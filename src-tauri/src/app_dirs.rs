//! XDG base directories for files the app locates before Tauri's path
//! resolver is available.

use std::{
    ffi::OsString,
    io,
    path::{Path, PathBuf},
};

pub const IDENTIFIER: &str = env!("SABLE_IDENTIFIER");

pub fn config_root() -> Option<PathBuf> {
    resolve("XDG_CONFIG_HOME", ".config")
}

/// `$XDG_CONFIG_HOME/<identifier>`, the directory Tauri's `app_config_dir` also uses.
pub fn config_dir() -> Option<PathBuf> {
    config_root().map(|root| root.join(IDENTIFIER))
}

fn resolve(variable: &str, home_default: &str) -> Option<PathBuf> {
    resolve_from(
        std::env::var_os(variable),
        std::env::var_os("HOME"),
        home_default,
    )
}

/// An unset, empty or relative value is ignored, as the specification requires.
fn resolve_from(
    value: Option<OsString>,
    home: Option<OsString>,
    home_default: &str,
) -> Option<PathBuf> {
    value
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
        .or_else(|| home.map(|home| Path::new(&home).join(home_default)))
}

/// Creates missing directories as `0700` and leaves existing ones untouched.
pub fn create_private_dir(dir: &Path) -> io::Result<()> {
    let mut builder = std::fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(dir)
}

/// Copies `old` to `new` unless `new` exists or `old` is absent.
pub fn adopt_file(old: &Path, new: &Path) -> io::Result<()> {
    if old == new || new.exists() || !old.exists() {
        return Ok(());
    }
    if let Some(parent) = new.parent() {
        create_private_dir(parent)?;
    }
    std::fs::copy(old, new).map(drop)
}

#[cfg(test)]
mod tests {
    use super::{adopt_file, create_private_dir, resolve_from};
    use std::{ffi::OsString, os::unix::fs::PermissionsExt, path::PathBuf};

    fn os(value: &str) -> OsString {
        value.into()
    }

    #[test]
    fn an_absolute_variable_wins_over_home() {
        assert_eq!(
            resolve_from(Some(os("/xdg")), Some(os("/home/u")), ".config"),
            Some(PathBuf::from("/xdg"))
        );
    }

    #[test]
    fn an_unset_empty_or_relative_variable_falls_back_to_home() {
        for value in [None, Some(os("")), Some(os("relative/dir"))] {
            assert_eq!(
                resolve_from(value, Some(os("/home/u")), ".config"),
                Some(PathBuf::from("/home/u/.config"))
            );
        }
    }

    #[test]
    fn nothing_resolves_without_a_variable_or_home() {
        assert_eq!(resolve_from(Some(os("relative")), None, ".config"), None);
    }

    #[test]
    fn new_directories_are_private_and_existing_ones_keep_their_mode() {
        let root = std::env::temp_dir().join(format!("sable-dirs-{}", std::process::id()));
        let nested = root.join("a").join("b");
        create_private_dir(&nested).unwrap();
        let mode =
            |path: &std::path::Path| std::fs::metadata(path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(&nested), 0o700);

        std::fs::set_permissions(&nested, std::fs::Permissions::from_mode(0o755)).unwrap();
        create_private_dir(&nested).unwrap();
        assert_eq!(mode(&nested), 0o755);
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn adopting_copies_once_and_never_overwrites() {
        let root = std::env::temp_dir().join(format!("sable-adopt-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let (old, new) = (root.join("old"), root.join("sub").join("new"));

        adopt_file(&old, &new).unwrap();
        assert!(!new.exists());

        std::fs::write(&old, "1").unwrap();
        adopt_file(&old, &new).unwrap();
        assert_eq!(std::fs::read_to_string(&new).unwrap(), "1");

        std::fs::write(&old, "2").unwrap();
        adopt_file(&old, &new).unwrap();
        assert_eq!(std::fs::read_to_string(&new).unwrap(), "1");
        std::fs::remove_dir_all(&root).unwrap();
    }
}
