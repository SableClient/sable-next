use std::path::{Path, PathBuf};

use matrix_sdk::SessionTokens;

use crate::sealed_account_data::AccountDataKey;
use crate::store::StoreError;

/// An interrupted save leaves its temporary file behind; younger ones may be a save in progress.
const ABANDONED_SAVE_AGE: std::time::Duration = std::time::Duration::from_hours(1);

const SEAL_LABEL: &str = "sable.login_tokens";
const SEALED: &str = "tokens";
const LEGACY: &str = "json";
const KEY: &str = "key";

/// One file per login: whichever process refreshes a login rewrites only its file, under the
/// SDK's cross-process refresh lock. A login's tokens leave the account registry once it holds them.
/// Files are sealed with a key from the OS credential store.
///
/// Sealed files live outside `credentials/`: Sable 2.2 deletes any file there that is not plain
/// JSON, so running an older install would sign every account out.
pub(crate) struct LoginTokens {
    directory: PathBuf,
    legacy_directory: PathBuf,
}

impl LoginTokens {
    pub(crate) fn new(base_store: &Path) -> Self {
        let logins = Self {
            directory: base_store.join("login-tokens"),
            legacy_directory: base_store.join("credentials"),
        };
        logins.move_sealed_files();
        logins
    }

    fn create_directory(&self) -> std::io::Result<()> {
        std::fs::create_dir_all(&self.directory)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&self.directory, std::fs::Permissions::from_mode(0o700))?;
        }
        Ok(())
    }

    /// A file already in the new directory is newer and wins.
    fn move_sealed_files(&self) {
        let Ok(entries) = std::fs::read_dir(&self.legacy_directory) else {
            return;
        };
        for entry in entries.flatten() {
            let name = entry.file_name();
            let sealed = name == KEY
                || Path::new(&name)
                    .extension()
                    .is_some_and(|extension| extension == SEALED);
            if !sealed {
                continue;
            }
            // Android denies apps `link`, so this must be a rename that refuses to replace.
            let moved = self.create_directory().and_then(|()| {
                let mut source = tempfile::TempPath::try_from_path(entry.path())?;
                source.disable_cleanup(true);
                source
                    .persist_noclobber(self.directory.join(&name))
                    .map_err(|error| error.error)
            });
            match moved {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                    if let Err(error) = std::fs::remove_file(entry.path()) {
                        tracing::warn!("could not remove a moved token file: {error}");
                    }
                }
                Err(error) => tracing::warn!("could not move a sealed token file: {error}"),
            }
        }
    }

    /// A re-login keeps the account id with a new device, so a stale client writes to its own file.
    fn file_stem(account_id: &str, device_id: &str) -> String {
        use base64::Engine as _;
        use sha2::{Digest, Sha256};

        let device = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(Sha256::digest(device_id.as_bytes()));
        format!("{account_id}.{device}")
    }

    fn path(&self, account_id: &str, device_id: &str, extension: &str) -> PathBuf {
        let directory = if extension == LEGACY {
            &self.legacy_directory
        } else {
            &self.directory
        };
        directory.join(format!(
            "{}.{extension}",
            Self::file_stem(account_id, device_id)
        ))
    }

    fn key_reference(&self) -> PathBuf {
        self.directory.join(KEY)
    }

    fn seal(&self, tokens: &SessionTokens) -> Result<Vec<u8>, StoreError> {
        let key = crate::secrets::load_or_create(&self.key_reference())?;
        let sealed = AccountDataKey::from_bytes(*key)
            .seal(SEAL_LABEL, &serde_json::to_value(tokens)?)
            .map_err(|error| StoreError::Message(error.to_string()))?;
        Ok(serde_json::to_vec(&sealed)?)
    }

    fn open(&self, bytes: &[u8]) -> Result<Option<SessionTokens>, StoreError> {
        let key = match crate::secrets::load(&self.key_reference()) {
            Ok(Some(key)) => key,
            Ok(None) => return Err(StoreError::Invalid("saved login tokens have no key")),
            Err(StoreError::KeyMissing) => {
                tracing::warn!("the key for saved login tokens is gone, so they cannot be read");
                return Ok(None);
            }
            Err(error) => return Err(error),
        };
        let tokens = AccountDataKey::from_bytes(*key)
            .open(SEAL_LABEL, &serde_json::from_slice(bytes)?)
            .ok_or(StoreError::Invalid(
                "saved login tokens could not be opened",
            ))?;
        Ok(Some(serde_json::from_value(tokens)?))
    }

    /// `Ok(None)` when the login has no file, or its key is gone from the keyring for good. An
    /// unreadable file must not pass for missing.
    pub(crate) fn read(
        &self,
        account_id: &str,
        device_id: &str,
    ) -> Result<Option<SessionTokens>, StoreError> {
        match std::fs::read(self.path(account_id, device_id, SEALED)) {
            Ok(bytes) => return self.open(&bytes),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
        let legacy = self.path(account_id, device_id, LEGACY);
        let tokens: SessionTokens = match std::fs::read(&legacy) {
            Ok(bytes) => serde_json::from_slice(&bytes)?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error.into()),
        };
        // Another process may have sealed it first, with tokens rotated since.
        if !self.write(account_id, device_id, &tokens, false)? {
            return self.read(account_id, device_id);
        }
        if let Err(error) = std::fs::remove_file(&legacy)
            && error.kind() != std::io::ErrorKind::NotFound
        {
            tracing::warn!("could not remove a plain token file: {error}");
        }
        Ok(Some(tokens))
    }

    pub(crate) fn read_or_migrate(
        &self,
        account_id: &str,
        device_id: &str,
        embedded: &SessionTokens,
    ) -> Result<(SessionTokens, bool), StoreError> {
        let (tokens, migrated) = match self.read(account_id, device_id)? {
            Some(tokens) => (tokens, false),
            None if embedded.access_token.is_empty() => {
                return Err(StoreError::Invalid("saved login tokens are missing"));
            }
            None => {
                let migrated = self.save_new(account_id, device_id, embedded)?;
                let tokens = self
                    .read(account_id, device_id)?
                    .ok_or(StoreError::Invalid("saved login tokens are missing"))?;
                (tokens, migrated)
            }
        };
        if tokens.access_token.is_empty() {
            return Err(StoreError::Invalid("saved login access token is empty"));
        }
        Ok((tokens, migrated))
    }

    pub(crate) fn save(
        &self,
        account_id: &str,
        device_id: &str,
        tokens: &SessionTokens,
    ) -> Result<(), StoreError> {
        self.write(account_id, device_id, tokens, true).map(drop)
    }

    /// Never replaces a file, which may hold tokens a refresh rotated since. Returns whether it wrote.
    pub(crate) fn save_new(
        &self,
        account_id: &str,
        device_id: &str,
        tokens: &SessionTokens,
    ) -> Result<bool, StoreError> {
        self.write(account_id, device_id, tokens, false)
    }

    fn write(
        &self,
        account_id: &str,
        device_id: &str,
        tokens: &SessionTokens,
        replace: bool,
    ) -> Result<bool, StoreError> {
        use std::io::Write;

        self.create_directory()?;
        let sealed = self.seal(tokens)?;
        let mut temporary = tempfile::NamedTempFile::new_in(&self.directory)?;
        temporary.write_all(&sealed)?;
        temporary.as_file().sync_all()?;
        let path = self.path(account_id, device_id, SEALED);
        let persisted = if replace {
            temporary.persist(path)
        } else {
            temporary.persist_noclobber(path)
        };
        match persisted {
            Ok(_) => Ok(true),
            Err(error) if error.error.kind() == std::io::ErrorKind::AlreadyExists => Ok(false),
            Err(error) => Err(StoreError::backend(error)),
        }
    }

    fn login_stem(name: &str) -> Option<&str> {
        let (stem, extension) = name.rsplit_once('.')?;
        matches!(extension, SEALED | LEGACY).then_some(stem)
    }

    fn entries(&self) -> impl Iterator<Item = std::fs::DirEntry> {
        [&self.directory, &self.legacy_directory]
            .into_iter()
            .filter_map(|directory| std::fs::read_dir(directory).ok())
            .flatten()
            .flatten()
    }

    /// Never removes a file it does not recognise, which may belong to another version.
    pub(crate) fn retain<'a>(&self, logins: impl IntoIterator<Item = (&'a str, &'a str)>) {
        let kept: std::collections::HashSet<_> = logins
            .into_iter()
            .map(|(account_id, device_id)| Self::file_stem(account_id, device_id))
            .collect();
        for entry in self.entries() {
            let name = entry.file_name().to_string_lossy().into_owned();
            let stale = Self::login_stem(&name).map_or_else(
                || {
                    name.starts_with(".tmp")
                        && entry
                            .metadata()
                            .and_then(|metadata| metadata.modified())
                            .ok()
                            .and_then(|modified| modified.elapsed().ok())
                            .is_some_and(|age| age > ABANDONED_SAVE_AGE)
                },
                |stem| !kept.contains(stem),
            );
            if stale && let Err(error) = std::fs::remove_file(entry.path()) {
                tracing::warn!("could not remove a stale token file: {error}");
            }
        }
    }

    pub(crate) fn forget(&self, account_id: &str) {
        for entry in self.entries() {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            let matches_account = Self::login_stem(&name)
                .and_then(|stem| stem.rsplit_once('.'))
                .is_some_and(|(account, device)| account == account_id && !device.is_empty());
            if matches_account && let Err(error) = std::fs::remove_file(entry.path()) {
                tracing::warn!("could not forget a login's tokens: {error}");
            }
        }
    }

    pub(crate) fn forget_all(&self) {
        crate::secrets::forget(&self.key_reference());
        for directory in [&self.directory, &self.legacy_directory] {
            match std::fs::remove_dir_all(directory) {
                Err(error) if error.kind() != std::io::ErrorKind::NotFound => {
                    tracing::warn!("could not forget the saved tokens: {error}");
                }
                _ => {}
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use matrix_sdk::SessionTokens;

    use super::LoginTokens;

    fn tokens(access: &str) -> SessionTokens {
        SessionTokens {
            access_token: access.to_owned(),
            refresh_token: Some(format!("{access}-refresh")),
        }
    }

    #[test]
    fn each_login_keeps_its_own_tokens() {
        let base = tempfile::tempdir().unwrap();
        let logins = LoginTokens::new(base.path());

        logins.save("a1", "OLD", &tokens("old")).unwrap();
        logins.save("a1", "NEW", &tokens("new")).unwrap();
        logins.save("a2", "OLD", &tokens("other")).unwrap();

        assert_eq!(
            logins.read("a1", "OLD").unwrap().unwrap().access_token,
            "old"
        );
        assert_eq!(
            logins.read("a1", "NEW").unwrap().unwrap().access_token,
            "new"
        );
        logins.forget("a1");
        assert!(logins.read("a1", "NEW").unwrap().is_none());
        assert_eq!(
            logins.read("a2", "OLD").unwrap().unwrap().access_token,
            "other"
        );
        logins.forget_all();
        assert!(logins.read("a2", "OLD").unwrap().is_none());
    }

    #[test]
    fn forget_does_not_remove_a_dotted_account_id_prefix() {
        let base = tempfile::tempdir().unwrap();
        let logins = LoginTokens::new(base.path());

        logins.save("a1", "OLD", &tokens("old")).unwrap();
        logins.save("a1.extra", "OLD", &tokens("dotted")).unwrap();
        logins.forget("a1");

        assert!(logins.read("a1", "OLD").unwrap().is_none());
        assert_eq!(
            logins
                .read("a1.extra", "OLD")
                .unwrap()
                .unwrap()
                .access_token,
            "dotted"
        );
    }

    #[test]
    fn a_new_login_file_never_replaces_rotated_tokens() {
        let base = tempfile::tempdir().unwrap();
        let logins = LoginTokens::new(base.path());

        logins.save("a1", "D", &tokens("rotated")).unwrap();
        assert!(!logins.save_new("a1", "D", &tokens("embedded")).unwrap());
        assert_eq!(
            logins.read("a1", "D").unwrap().unwrap().access_token,
            "rotated"
        );
        assert!(logins.save_new("a2", "D", &tokens("embedded")).unwrap());
        assert_eq!(
            logins.read_or_migrate("a1", "D", &tokens("stale")).unwrap(),
            (tokens("rotated"), false)
        );
        assert_eq!(
            logins
                .read_or_migrate("a3", "D", &tokens("legacy"))
                .unwrap(),
            (tokens("legacy"), true)
        );
    }

    #[test]
    fn an_unreadable_file_is_not_a_missing_one() {
        let base = tempfile::tempdir().unwrap();
        let logins = LoginTokens::new(base.path());
        logins.save("a1", "D", &tokens("saved")).unwrap();
        std::fs::write(logins.path("a1", "D", super::SEALED), b"not tokens").unwrap();

        logins.read("a1", "D").unwrap_err();
        assert!(logins.read("a2", "D").unwrap().is_none());
    }

    #[test]
    fn only_current_logins_and_recent_saves_are_kept() {
        let base = tempfile::tempdir().unwrap();
        let logins = LoginTokens::new(base.path());
        logins.save("a1", "OLD", &tokens("old")).unwrap();
        logins.save("a1", "NEW", &tokens("new")).unwrap();
        logins.save("a2", "D", &tokens("removed")).unwrap();
        std::fs::write(base.path().join("login-tokens/.tmp-in-progress"), b"").unwrap();

        logins.retain([("a1", "NEW")]);

        assert!(logins.read("a1", "NEW").unwrap().is_some());
        assert!(logins.read("a1", "OLD").unwrap().is_none());
        assert!(logins.read("a2", "D").unwrap().is_none());
        assert!(base.path().join("login-tokens/.tmp-in-progress").exists());
        assert!(base.path().join("login-tokens/key").exists());
    }

    #[test]
    fn an_unknown_file_is_never_removed() {
        let base = tempfile::tempdir().unwrap();
        let logins = LoginTokens::new(base.path());
        logins.save("a1", "D", &tokens("saved")).unwrap();
        let unknown = base.path().join("login-tokens/from-a-newer-version");
        std::fs::write(&unknown, b"").unwrap();
        let old = std::time::SystemTime::now() - std::time::Duration::from_hours(2);
        std::fs::File::options()
            .write(true)
            .open(&unknown)
            .unwrap()
            .set_modified(old)
            .unwrap();

        logins.retain([("a1", "D")]);

        assert!(unknown.exists());
    }

    #[test]
    fn sealed_files_move_out_of_the_directory_sable_2_2_cleans() {
        let base = tempfile::tempdir().unwrap();
        LoginTokens::new(base.path())
            .save("a1", "D", &tokens("saved"))
            .unwrap();
        let legacy = base.path().join("credentials");
        std::fs::rename(base.path().join("login-tokens"), &legacy).unwrap();
        std::fs::write(legacy.join("a2.D.json"), b"{}").unwrap();

        let logins = LoginTokens::new(base.path());

        assert_eq!(
            logins.read("a1", "D").unwrap().unwrap().access_token,
            "saved"
        );
        assert!(base.path().join("login-tokens/key").exists());
        let left: Vec<_> = std::fs::read_dir(&legacy)
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect();
        assert_eq!(left, ["a2.D.json"]);
    }

    #[test]
    fn a_moved_file_never_replaces_a_newer_one() {
        let base = tempfile::tempdir().unwrap();
        let logins = LoginTokens::new(base.path());
        logins.save("a1", "D", &tokens("old")).unwrap();
        let legacy = base.path().join("credentials");
        std::fs::create_dir_all(&legacy).unwrap();
        let name = logins.path("a1", "D", super::SEALED);
        std::fs::copy(&name, legacy.join(name.file_name().unwrap())).unwrap();
        logins.save("a1", "D", &tokens("rotated")).unwrap();

        let logins = LoginTokens::new(base.path());

        assert_eq!(
            logins.read("a1", "D").unwrap().unwrap().access_token,
            "rotated"
        );
        assert!(!legacy.join(name.file_name().unwrap()).exists());
    }

    #[test]
    fn saved_tokens_are_sealed() {
        let base = tempfile::tempdir().unwrap();
        let logins = LoginTokens::new(base.path());
        logins.save("a1", "D", &tokens("secret-access")).unwrap();

        let saved = std::fs::read(logins.path("a1", "D", super::SEALED)).unwrap();
        assert!(!String::from_utf8_lossy(&saved).contains("secret-access"));
        assert_eq!(
            logins.read("a1", "D").unwrap().unwrap().access_token,
            "secret-access"
        );
    }

    #[test]
    fn a_plain_token_file_is_sealed_on_read() {
        let base = tempfile::tempdir().unwrap();
        let logins = LoginTokens::new(base.path());
        let legacy = logins.path("a1", "D", super::LEGACY);
        std::fs::create_dir_all(legacy.parent().unwrap()).unwrap();
        std::fs::write(&legacy, serde_json::to_vec(&tokens("plain")).unwrap()).unwrap();

        assert_eq!(
            logins.read("a1", "D").unwrap().unwrap().access_token,
            "plain"
        );
        assert!(!legacy.exists());
        assert!(logins.path("a1", "D", super::SEALED).exists());
        assert_eq!(
            logins.read("a1", "D").unwrap().unwrap().access_token,
            "plain"
        );
    }

    #[test]
    fn a_plain_file_never_replaces_sealed_rotated_tokens() {
        let base = tempfile::tempdir().unwrap();
        let logins = LoginTokens::new(base.path());
        logins.save("a1", "D", &tokens("rotated")).unwrap();
        let legacy = logins.path("a1", "D", super::LEGACY);
        std::fs::create_dir_all(legacy.parent().unwrap()).unwrap();
        std::fs::write(&legacy, serde_json::to_vec(&tokens("plain")).unwrap()).unwrap();

        assert_eq!(
            logins.read("a1", "D").unwrap().unwrap().access_token,
            "rotated"
        );
    }

    #[test]
    fn tokens_whose_key_is_gone_read_as_missing() {
        let base = tempfile::tempdir().unwrap();
        let logins = LoginTokens::new(base.path());
        logins.save("a1", "D", &tokens("saved")).unwrap();
        std::fs::write(base.path().join("login-tokens/key"), "another-device").unwrap();

        assert!(logins.read("a1", "D").unwrap().is_none());
    }
}
