//! The iOS badge per room, written by the app and counted on by the notification extension.
//! The gateway's count follows the server's push rules, not the badge settings.

use std::collections::{BTreeMap, VecDeque};
#[cfg(not(target_family = "wasm"))]
use std::path::Path;

use serde::{Deserialize, Serialize};

#[cfg(not(target_family = "wasm"))]
const FILE: &str = "push-badge.json";
const COUNTED_LIMIT: usize = 100;

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct PushBadgeRoom {
    pub count: u32,
    /// Counts every notifying message, not only mentions.
    pub every: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct PushBadge {
    pub user_id: String,
    pub rooms: BTreeMap<String, PushBadgeRoom>,
    /// For a room the app has not listed yet.
    pub direct_every: bool,
    pub group_every: bool,
    /// So a push delivered twice is counted once.
    #[serde(default)]
    pub counted: VecDeque<String>,
}

impl PushBadge {
    #[cfg(not(target_family = "wasm"))]
    #[must_use]
    pub fn load(root: &Path, user_id: &str) -> Option<Self> {
        let bytes = std::fs::read(root.join(FILE)).ok()?;
        serde_json::from_slice::<Self>(&bytes)
            .ok()
            .filter(|badge| badge.user_id == user_id)
    }

    /// Keeps the events the extension already counted, which may not have reached the app.
    ///
    /// # Errors
    /// When the file cannot be written.
    #[cfg(not(target_family = "wasm"))]
    pub fn save(mut self, root: &Path) -> std::io::Result<()> {
        if let Some(previous) = Self::load(root, &self.user_id) {
            self.counted = previous.counted;
        }
        self.write(root)
    }

    /// # Errors
    /// When the file cannot be written.
    #[cfg(not(target_family = "wasm"))]
    pub fn write(&self, root: &Path) -> std::io::Result<()> {
        let bytes = serde_json::to_vec(self).map_err(std::io::Error::other)?;
        crate::store::write_atomic(&root.join(FILE), &bytes)
    }

    #[must_use]
    pub fn total(&self) -> u32 {
        self.rooms
            .values()
            .map(|room| room.count)
            .fold(0, u32::saturating_add)
    }

    /// Whether the badge changed.
    pub fn count(&mut self, room_id: &str, event_id: &str, mention: bool, direct: bool) -> bool {
        if self.counted.iter().any(|counted| counted == event_id) {
            return false;
        }
        let every = if direct {
            self.direct_every
        } else {
            self.group_every
        };
        let room = self
            .rooms
            .entry(room_id.to_owned())
            .or_insert(PushBadgeRoom { count: 0, every });
        if !(room.every || mention) {
            return false;
        }
        room.count = room.count.saturating_add(1);
        if self.counted.len() == COUNTED_LIMIT {
            self.counted.pop_front();
        }
        self.counted.push_back(event_id.to_owned());
        true
    }

    /// Every room when `room_ids` is `None`. Whether the badge changed.
    pub fn clear(&mut self, room_ids: Option<&[&str]>) -> bool {
        let mut changed = false;
        for (room_id, room) in &mut self.rooms {
            if room.count > 0 && room_ids.is_none_or(|ids| ids.contains(&room_id.as_str())) {
                room.count = 0;
                changed = true;
            }
        }
        changed
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn badge() -> PushBadge {
        PushBadge {
            user_id: "@alice:example.org".to_owned(),
            rooms: BTreeMap::from([
                (
                    "!group".to_owned(),
                    PushBadgeRoom {
                        count: 2,
                        every: false,
                    },
                ),
                (
                    "!dm".to_owned(),
                    PushBadgeRoom {
                        count: 1,
                        every: true,
                    },
                ),
            ]),
            direct_every: true,
            group_every: false,
            counted: VecDeque::new(),
        }
    }

    #[test]
    fn a_room_counts_what_its_badge_setting_counts_and_each_event_once() {
        let mut badge = badge();
        assert!(!badge.count("!group", "$a", false, false));
        assert!(badge.count("!group", "$b", true, false));
        assert!(badge.count("!dm", "$c", false, true));
        assert!(!badge.count("!dm", "$c", false, true));
        assert!(badge.count("!new-dm", "$d", false, true));
        assert!(!badge.count("!new-group", "$e", false, false));
        assert_eq!(badge.total(), 6);
    }

    #[test]
    fn reading_clears_the_rooms_it_names_or_all_of_them() {
        let mut badge = badge();
        assert!(badge.clear(Some(&["!dm"])));
        assert_eq!(badge.total(), 2);
        assert!(!badge.clear(Some(&["!dm"])));
        assert!(badge.clear(None));
        assert_eq!(badge.total(), 0);
    }

    #[test]
    fn the_app_rewrites_counts_but_keeps_what_the_extension_counted() {
        let root = tempfile::tempdir().unwrap();
        let mut counted = badge();
        counted.count("!dm", "$c", false, true);
        counted.write(root.path()).unwrap();

        badge().save(root.path()).unwrap();
        let mut saved = PushBadge::load(root.path(), "@alice:example.org").unwrap();
        assert_eq!(saved.total(), 3);
        assert!(!saved.count("!dm", "$c", false, true));
        assert!(PushBadge::load(root.path(), "@bob:example.org").is_none());
    }
}
