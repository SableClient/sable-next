use std::{collections::HashSet, io, path::Path};

use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Clone, Debug, Deserialize, Serialize)]
pub(crate) struct User {
    pub id: String,
    pub username: Option<String>,
    pub password_hash: Option<String>,
    #[serde(default)]
    pub disabled: bool,
    #[serde(default)]
    pub deleted: bool,
    #[serde(default)]
    pub session_version: u64,
    #[serde(default)]
    pub identities: Vec<OidcIdentity>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq, Hash)]
pub(crate) struct OidcIdentity {
    pub issuer: String,
    pub subject: String,
}

#[derive(Default, Deserialize, Serialize)]
pub(crate) struct UserRegistry {
    pub users: Vec<User>,
}

impl UserRegistry {
    pub(crate) fn load(path: &Path) -> io::Result<Self> {
        let bytes = match std::fs::read(path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Self::default()),
            Err(error) => return Err(error),
        };
        let registry: Self = serde_json::from_slice(&bytes).map_err(io::Error::other)?;
        registry.validate()?;
        Ok(registry)
    }

    pub(crate) fn add_local(
        path: &Path,
        username: &str,
        password_hash: &str,
    ) -> io::Result<String> {
        if username.is_empty() || password_hash.is_empty() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "username and password hash are required",
            ));
        }
        Self::add(
            path,
            User {
                id: Uuid::new_v4().to_string(),
                username: Some(username.to_owned()),
                password_hash: Some(password_hash.to_owned()),
                disabled: false,
                deleted: false,
                session_version: 0,
                identities: Vec::new(),
            },
        )
    }

    pub(crate) fn add_oidc(path: &Path, issuer: &str, subject: &str) -> io::Result<String> {
        Self::add(
            path,
            User {
                id: Uuid::new_v4().to_string(),
                username: None,
                password_hash: None,
                disabled: false,
                deleted: false,
                session_version: 0,
                identities: vec![OidcIdentity {
                    issuer: issuer.to_owned(),
                    subject: subject.to_owned(),
                }],
            },
        )
    }

    pub(crate) fn provision_oidc(
        path: &Path,
        issuer: &str,
        subject: &str,
    ) -> io::Result<Option<String>> {
        let mut id = None;
        Self::update(path, |registry| {
            if let Some(user) = registry.users.iter().find(|user| {
                user.identities
                    .iter()
                    .any(|identity| identity.issuer == issuer && identity.subject == subject)
            }) {
                if !user.disabled {
                    id = Some(user.id.clone());
                }
            } else {
                let user = User {
                    id: Uuid::new_v4().to_string(),
                    username: None,
                    password_hash: None,
                    disabled: false,
                    deleted: false,
                    session_version: 0,
                    identities: vec![OidcIdentity {
                        issuer: issuer.to_owned(),
                        subject: subject.to_owned(),
                    }],
                };
                id = Some(user.id.clone());
                registry.users.push(user);
            }
            Ok(())
        })?;
        Ok(id)
    }

    fn add(path: &Path, user: User) -> io::Result<String> {
        let id = user.id.clone();
        Self::update(path, |registry| {
            registry.users.push(user);
            Ok(())
        })?;
        Ok(id)
    }

    pub(crate) fn set_disabled(path: &Path, id: &str, disabled: bool) -> io::Result<()> {
        Self::update(path, |registry| {
            let user = registry
                .users
                .iter_mut()
                .find(|user| user.id == id)
                .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "user not found"))?;
            if !disabled && user.deleted {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "deleted user cannot be enabled",
                ));
            }
            if disabled && !user.disabled {
                user.session_version = user.session_version.saturating_add(1);
            }
            user.disabled = disabled;
            Ok(())
        })
    }

    pub(crate) fn mark_deleted(path: &Path, id: &str) -> io::Result<()> {
        Self::update(path, |registry| {
            let user = registry
                .users
                .iter_mut()
                .find(|user| user.id == id)
                .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "user not found"))?;
            user.session_version = user.session_version.saturating_add(1);
            user.disabled = true;
            user.deleted = true;
            user.username = None;
            user.password_hash = None;
            Ok(())
        })
    }

    pub(crate) fn set_password(path: &Path, id: &str, hash: String) -> io::Result<()> {
        Self::update(path, |registry| {
            let user = registry
                .users
                .iter_mut()
                .find(|user| user.id == id)
                .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "user not found"))?;
            if user.username.is_none() {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "user has no local login",
                ));
            }
            user.password_hash = Some(hash);
            user.session_version = user.session_version.saturating_add(1);
            Ok(())
        })
    }

    fn update(path: &Path, update: impl FnOnce(&mut Self) -> io::Result<()>) -> io::Result<()> {
        let parent = path
            .parent()
            .ok_or_else(|| io::Error::other("missing registry directory"))?;
        std::fs::create_dir_all(parent)?;
        let lock = std::fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .open(parent.join("users.lock"))?;
        lock.lock()?;
        let mut registry = Self::load(path)?;
        update(&mut registry)?;
        registry.validate()?;
        let mut bytes = serde_json::to_vec_pretty(&registry).map_err(io::Error::other)?;
        bytes.push(b'\n');
        sable_core::store::write_atomic_private(path, &bytes)
    }

    pub(crate) fn validate(&self) -> io::Result<()> {
        let mut ids = HashSet::new();
        let mut usernames = HashSet::new();
        let mut identities = HashSet::new();
        for user in &self.users {
            if Uuid::parse_str(&user.id).map_or(true, |id| id.to_string() != user.id)
                || !ids.insert(&user.id)
                || user
                    .username
                    .as_ref()
                    .is_some_and(|name| name.is_empty() || !usernames.insert(name))
                || user.username.is_some() != user.password_hash.is_some()
                || user.identities.iter().any(|identity| {
                    identity.issuer.is_empty()
                        || identity.subject.is_empty()
                        || !identities.insert(identity)
                })
            {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "invalid or duplicate user identity",
                ));
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn persists_local_users_and_rejects_duplicate_names() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("users.json");
        let id = UserRegistry::add_local(&path, "alice", "hash").unwrap();
        let registry = UserRegistry::load(&path).unwrap();
        assert_eq!(registry.users.len(), 1);
        assert_eq!(registry.users[0].id, id);
        UserRegistry::add_local(&path, "alice", "other").unwrap_err();
        assert_eq!(UserRegistry::load(&path).unwrap().users.len(), 1);
        UserRegistry::set_disabled(&path, &id, true).unwrap();
        assert!(UserRegistry::load(&path).unwrap().users[0].disabled);
        assert!(UserRegistry::set_disabled(&path, "missing", true).is_err());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
    }

    #[test]
    #[expect(
        clippy::needless_collect,
        reason = "all threads must start before joining"
    )]
    fn concurrent_oidc_provisioning_keeps_one_identity_and_respects_disable() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("users.json");
        let threads: Vec<_> = (0..4)
            .map(|_| {
                let path = path.clone();
                std::thread::spawn(move || {
                    UserRegistry::provision_oidc(&path, "https://issuer.example", "subject")
                        .unwrap()
                        .unwrap()
                })
            })
            .collect();
        let ids: Vec<_> = threads
            .into_iter()
            .map(|thread| thread.join().unwrap())
            .collect();
        assert!(ids.iter().all(|id| id == &ids[0]));
        assert_eq!(UserRegistry::load(&path).unwrap().users.len(), 1);
        UserRegistry::set_disabled(&path, &ids[0], true).unwrap();
        assert!(
            UserRegistry::provision_oidc(&path, "https://issuer.example", "subject")
                .unwrap()
                .is_none()
        );
        UserRegistry::mark_deleted(&path, &ids[0]).unwrap();
        assert!(UserRegistry::set_disabled(&path, &ids[0], false).is_err());
        assert!(
            UserRegistry::provision_oidc(&path, "https://issuer.example", "subject")
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn rejects_duplicate_oidc_identities() {
        let identity = OidcIdentity {
            issuer: "https://id.example".into(),
            subject: "123".into(),
        };
        let user = |id| User {
            id,
            username: None,
            password_hash: None,
            disabled: false,
            deleted: false,
            session_version: 0,
            identities: vec![identity.clone()],
        };
        let registry = UserRegistry {
            users: vec![
                user(Uuid::new_v4().to_string()),
                user(Uuid::new_v4().to_string()),
            ],
        };
        assert!(registry.validate().is_err());
    }
}
