use std::{
    io,
    path::PathBuf,
    sync::{Arc, Mutex, MutexGuard, PoisonError},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use argon2::{Argon2, PasswordHash, PasswordVerifier};
use axum_extra::headers::authorization::{Authorization, Basic};
use tower_sessions::Session;

use crate::users::UserRegistry;

const SESSION_USER_ID: &str = "user_id";
const SESSION_VERSION: &str = "user_version";
const LEGACY_USER_ID: &str = "legacy";
const SESSION_CREATED_AT: &str = "created_at";
const SESSION_LIFETIME: Duration = Duration::from_hours(168);
const DUMMY_PASSWORD_HASH: &str = "$argon2id$v=19$m=19456,t=2,p=1$P+eI2tfGQ1sd90QtbQ8wFA$Obgt2lytjJYQTynFGGi4Lu+2hlyyipgjDot5QXzqxjs";

#[derive(Clone)]
pub(crate) struct Auth {
    username: Arc<str>,
    password_hash: Option<Arc<str>>,
    registry: Arc<RegistryCache>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
struct RegistryStamp {
    modified: Option<SystemTime>,
    length: Option<u64>,
}

struct RegistryCache {
    path: PathBuf,
    current: Mutex<(RegistryStamp, Arc<UserRegistry>)>,
}

impl RegistryCache {
    fn new(path: PathBuf) -> io::Result<Self> {
        let current = (file_stamp(&path)?, Arc::new(UserRegistry::load(&path)?));
        Ok(Self {
            path,
            current: Mutex::new(current),
        })
    }

    fn current(&self) -> MutexGuard<'_, (RegistryStamp, Arc<UserRegistry>)> {
        self.current.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn snapshot(&self) -> Arc<UserRegistry> {
        self.current().1.clone()
    }

    fn reload(&self) -> io::Result<Option<(Arc<UserRegistry>, Vec<String>)>> {
        let stamp = file_stamp(&self.path)?;
        if self.current().0 == stamp {
            return Ok(None);
        }
        let registry = Arc::new(UserRegistry::load(&self.path)?);
        let (_, previous) = std::mem::replace(&mut *self.current(), (stamp, registry.clone()));
        let revoked = previous
            .users
            .iter()
            .filter(|old| !old.disabled)
            .filter(|old| {
                registry
                    .users
                    .iter()
                    .find(|new| new.id == old.id)
                    .is_none_or(|new| new.disabled || new.session_version != old.session_version)
            })
            .map(|user| user.id.clone())
            .collect();
        Ok(Some((registry, revoked)))
    }
}

fn file_stamp(path: &std::path::Path) -> io::Result<RegistryStamp> {
    match std::fs::metadata(path) {
        Ok(metadata) => Ok(RegistryStamp {
            modified: metadata.modified().ok(),
            length: Some(metadata.len()),
        }),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(RegistryStamp {
            modified: None,
            length: None,
        }),
        Err(error) => Err(error),
    }
}

impl Auth {
    pub(crate) fn new(
        username: impl Into<Arc<str>>,
        password_hash: Option<String>,
        users_path: PathBuf,
    ) -> Result<Self, Box<dyn std::error::Error + Send + Sync>> {
        let registry = Arc::new(RegistryCache::new(users_path)?);
        let users = registry.snapshot();
        let username = username.into();
        let password_hash = password_hash.map(Arc::<str>::from);
        if users
            .users
            .iter()
            .any(|user| user.username.as_deref() == Some(username.as_ref()))
        {
            return Err("registry username conflicts with legacy account".into());
        }
        if let Some(hash) = &password_hash {
            PasswordHash::new(hash).map_err(|_| {
                "invalid password_hash (SABLE_SERVER_PASSWORD_HASH): expected an Argon2 password hash"
            })?;
        }
        for user in &users.users {
            if let Some(hash) = &user.password_hash {
                PasswordHash::new(hash).map_err(|_| {
                    format!("invalid password hash for user {} in users.json", user.id)
                })?;
            }
        }
        Ok(Self {
            username,
            password_hash,
            registry,
        })
    }

    pub(crate) async fn reload_if_changed(
        &self,
    ) -> io::Result<Option<(Arc<UserRegistry>, Vec<String>)>> {
        let registry = self.registry.clone();
        tokio::task::spawn_blocking(move || registry.reload())
            .await
            .map_err(io::Error::other)?
    }

    pub(crate) async fn authenticate(&self, session: &Session) -> Option<String> {
        let created_at = session
            .get::<u64>(SESSION_CREATED_AT)
            .await
            .ok()
            .flatten()?;
        let expired = current_time().saturating_sub(created_at) >= SESSION_LIFETIME.as_secs();
        if expired {
            let _ = session.flush().await;
            return None;
        }
        let id = session
            .get::<String>(SESSION_USER_ID)
            .await
            .ok()
            .flatten()?;
        let version = session.get::<u64>(SESSION_VERSION).await.ok().flatten()?;
        ((id == LEGACY_USER_ID && self.password_hash.is_some() && version == 0)
            || self
                .registry
                .snapshot()
                .users
                .iter()
                .any(|user| user.id == id && !user.disabled && user.session_version == version))
        .then_some(id)
    }

    pub(crate) async fn check_basic(
        &self,
        credentials: Option<&Authorization<Basic>>,
        permit: tokio::sync::OwnedSemaphorePermit,
    ) -> Option<(String, u64)> {
        let credentials = credentials?;
        let username = credentials.username();
        let user = if username == self.username.as_ref() {
            self.password_hash
                .as_ref()
                .map(|hash| (LEGACY_USER_ID.to_owned(), hash.to_string(), 0))
        } else {
            self.registry.snapshot().users.iter().find_map(|user| {
                if !user.disabled && user.username.as_deref() == Some(username) {
                    Some((
                        user.id.clone(),
                        user.password_hash.clone()?,
                        user.session_version,
                    ))
                } else {
                    None
                }
            })
        };
        let known = user.is_some();
        let (id, hash, version) =
            user.unwrap_or_else(|| (String::new(), DUMMY_PASSWORD_HASH.to_owned(), 0));
        let password = credentials.password().to_owned();
        let valid = tokio::task::spawn_blocking(move || {
            let _permit = permit;
            PasswordHash::new(&hash).is_ok_and(|parsed| {
                Argon2::default()
                    .verify_password(password.as_bytes(), &parsed)
                    .is_ok()
            })
        })
        .await
        .unwrap_or(false);
        (known && valid).then_some((id, version))
    }

    pub(crate) fn local_enabled(&self) -> bool {
        self.password_hash.is_some()
            || self
                .registry
                .snapshot()
                .users
                .iter()
                .any(|user| !user.disabled && user.password_hash.is_some())
    }

    pub(crate) fn oidc_user(&self, issuer: &str, subject: &str) -> Option<String> {
        self.registry
            .snapshot()
            .users
            .iter()
            .find(|user| {
                !user.disabled
                    && user
                        .identities
                        .iter()
                        .any(|identity| identity.issuer == issuer && identity.subject == subject)
            })
            .map(|user| user.id.clone())
    }

    pub(crate) async fn provision_oidc(&self, issuer: String, subject: String) -> Option<String> {
        let path = self.registry.path.clone();
        let user_id = tokio::task::spawn_blocking(move || {
            UserRegistry::provision_oidc(&path, &issuer, &subject)
        })
        .await
        .ok()?
        .ok()
        .flatten();
        if let Err(error) = self.reload_if_changed().await {
            tracing::warn!(%error, "could not reload user registry after provisioning");
        }
        user_id
    }

    pub(crate) async fn login(
        &self,
        session: &Session,
        user_id: &str,
        expected_version: Option<u64>,
    ) -> Result<(), tower_sessions::session::Error> {
        let version = if user_id == LEGACY_USER_ID {
            0
        } else {
            let users = self.registry.snapshot();
            users
                .users
                .iter()
                .find(|user| user.id == user_id && !user.disabled)
                .ok_or_else(|| {
                    tower_sessions::session::Error::Store(
                        tower_sessions::session_store::Error::Backend("user unavailable".into()),
                    )
                })?
                .session_version
        };
        if expected_version.is_some_and(|expected| expected != version) {
            return Err(tower_sessions::session::Error::Store(
                tower_sessions::session_store::Error::Backend("user credentials changed".into()),
            ));
        }
        session.cycle_id().await?;
        session.insert(SESSION_VERSION, version).await?;
        session.insert(SESSION_CREATED_AT, current_time()).await?;
        session.insert(SESSION_USER_ID, user_id).await
    }
}

pub(crate) async fn logout(session: &Session) -> Result<(), tower_sessions::session::Error> {
    session.flush().await
}

fn current_time() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |duration| duration.as_secs())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tower_sessions::MemoryStore;

    #[tokio::test]
    async fn disabling_user_invalidates_existing_session() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("users.json");
        let hash = "$argon2id$v=19$m=19456,t=2,p=1$P+eI2tfGQ1sd90QtbQ8wFA$Obgt2lytjJYQTynFGGi4Lu+2hlyyipgjDot5QXzqxjs";
        let id = UserRegistry::add_local(&path, "alice", hash).unwrap();
        let auth = Auth::new("legacy", Some(hash.to_owned()), path.clone()).unwrap();
        let session = Session::new(None, Arc::new(MemoryStore::default()), None);
        auth.login(&session, &id, None).await.unwrap();
        assert_eq!(
            auth.authenticate(&session).await.as_deref(),
            Some(id.as_str())
        );
        UserRegistry::set_disabled(&path, &id, true).unwrap();
        let (_, revoked) = auth.reload_if_changed().await.unwrap().unwrap();
        assert_eq!(revoked, vec![id.clone()]);
        assert!(auth.authenticate(&session).await.is_none());
        UserRegistry::set_disabled(&path, &id, false).unwrap();
        auth.reload_if_changed().await.unwrap();
        assert!(auth.authenticate(&session).await.is_none());
        assert!(auth.login(&session, &id, Some(0)).await.is_err());
        auth.login(&session, &id, Some(1)).await.unwrap();
        UserRegistry::set_password(&path, &id, hash.to_owned()).unwrap();
        auth.reload_if_changed().await.unwrap();
        assert!(auth.authenticate(&session).await.is_none());
        assert!(auth.login(&session, &id, Some(1)).await.is_err());
    }

    #[tokio::test]
    async fn authentication_uses_the_cached_registry() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("users.json");
        let hash = "$argon2id$v=19$m=19456,t=2,p=1$P+eI2tfGQ1sd90QtbQ8wFA$Obgt2lytjJYQTynFGGi4Lu+2hlyyipgjDot5QXzqxjs";
        let id = UserRegistry::add_local(&path, "alice", hash).unwrap();
        let auth = Auth::new("legacy", None, path.clone()).unwrap();
        let session = Session::new(None, Arc::new(MemoryStore::default()), None);
        auth.login(&session, &id, None).await.unwrap();

        std::fs::remove_file(path).unwrap();

        assert_eq!(
            auth.authenticate(&session).await.as_deref(),
            Some(id.as_str())
        );
    }
}
