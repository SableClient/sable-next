use std::{
    collections::HashSet,
    path::{Path, PathBuf},
    sync::{Mutex, PoisonError},
};

pub struct Grants {
    path: Option<PathBuf>,
    known: &'static [&'static str],
    granted: Mutex<HashSet<&'static str>>,
}

impl Grants {
    #[must_use]
    pub fn load(known: &'static [&'static str]) -> Self {
        Self::at(store_path(), known)
    }

    fn at(path: Option<PathBuf>, known: &'static [&'static str]) -> Self {
        let granted = path
            .as_deref()
            .map(|path| read(path, known))
            .unwrap_or_default();
        Self {
            path,
            known,
            granted: Mutex::new(granted),
        }
    }

    pub fn contains_all(&self, kinds: &[&str]) -> bool {
        let granted = self.granted.lock().unwrap_or_else(PoisonError::into_inner);
        kinds.iter().all(|kind| granted.contains(kind))
    }

    pub fn grant(&self, kinds: &[&str]) {
        let mut granted = self.granted.lock().unwrap_or_else(PoisonError::into_inner);
        granted.extend(
            self.known
                .iter()
                .copied()
                .filter(|known| kinds.contains(known)),
        );
        if let Some(path) = &self.path {
            write(path, &granted);
        }
    }
}

fn store_path() -> Option<PathBuf> {
    let config = std::env::var_os("XDG_CONFIG_HOME")
        .filter(|dir| !dir.is_empty())
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|home| Path::new(&home).join(".config")))?;
    Some(config.join("moe.sable.next").join("permissions.json"))
}

fn read(path: &Path, known: &'static [&'static str]) -> HashSet<&'static str> {
    let stored: Vec<String> = std::fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default();
    known
        .iter()
        .copied()
        .filter(|kind| stored.iter().any(|stored| stored == kind))
        .collect()
}

fn write(path: &Path, granted: &HashSet<&'static str>) {
    let mut kinds: Vec<&str> = granted.iter().copied().collect();
    kinds.sort_unstable();
    let written = path
        .parent()
        .map_or(Ok(()), std::fs::create_dir_all)
        .and_then(|()| std::fs::write(path, serde_json::to_vec(&kinds).unwrap_or_default()));
    if let Err(error) = written {
        log::warn!("could not remember a permission grant: {error}");
    }
}

#[cfg(test)]
mod tests {
    use super::Grants;

    const KINDS: &[&str] = &["microphone", "camera"];

    #[test]
    fn a_granted_permission_is_remembered_across_launches() {
        let dir = std::env::temp_dir().join(format!("sable-grants-{}", std::process::id()));
        let path = dir.join("moe.sable.next").join("permissions.json");

        let first = Grants::at(Some(path.clone()), KINDS);
        assert!(!first.contains_all(&["microphone"]));
        first.grant(&["microphone"]);

        let next = Grants::at(Some(path.clone()), KINDS);
        assert!(next.contains_all(&["microphone"]));
        assert!(!next.contains_all(&["microphone", "camera"]));

        std::fs::write(&path, br#"["camera","clipboard"]"#).unwrap();
        let edited = Grants::at(Some(path), KINDS);
        assert!(edited.contains_all(&["camera"]));
        assert!(!edited.contains_all(&["clipboard"]));

        std::fs::remove_dir_all(&dir).unwrap();
    }
}
