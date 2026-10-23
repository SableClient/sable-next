use std::{collections::HashMap, hash::Hash};

/// For a slice that serves many keys from one instance: the first follower creates
/// a key's value and the last one to leave removes it.
#[derive(Debug)]
pub struct Followed<K, V> {
    entries: HashMap<K, (usize, V)>,
}

impl<K, V> Default for Followed<K, V> {
    fn default() -> Self {
        Self {
            entries: HashMap::new(),
        }
    }
}

impl<K: Eq + Hash, V> Followed<K, V> {
    /// Whether this follower is the first.
    pub fn follow(&mut self, key: K, make: impl FnOnce() -> V) -> bool {
        if let Some((followers, _)) = self.entries.get_mut(&key) {
            *followers += 1;
            false
        } else {
            self.entries.insert(key, (1, make()));
            true
        }
    }

    /// Returns the value when this was the last follower.
    pub fn unfollow(&mut self, key: &K) -> Option<V> {
        let (followers, _) = self.entries.get_mut(key)?;
        *followers -= 1;
        if *followers > 0 {
            return None;
        }
        self.entries.remove(key).map(|(_, value)| value)
    }

    #[must_use]
    pub fn get(&self, key: &K) -> Option<&V> {
        self.entries.get(key).map(|(_, value)| value)
    }

    pub fn get_mut(&mut self, key: &K) -> Option<&mut V> {
        self.entries.get_mut(key).map(|(_, value)| value)
    }

    /// For a slice that is being disposed.
    pub fn drain(&mut self) -> impl Iterator<Item = (K, V)> {
        self.entries.drain().map(|(key, (_, value))| (key, value))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_value_lives_until_the_last_follower_leaves() {
        let mut followed = Followed::default();
        assert!(followed.follow("a", || 1));
        assert!(!followed.follow("a", || unreachable!("made twice")));
        assert_eq!(followed.unfollow(&"a"), None);
        assert_eq!(followed.get(&"a"), Some(&1));
        assert_eq!(followed.unfollow(&"a"), Some(1));
        assert_eq!(followed.get(&"a"), None);
    }

    #[test]
    fn unfollowing_what_was_never_followed_is_a_no_op() {
        let mut followed = Followed::<&str, u8>::default();
        assert_eq!(followed.unfollow(&"a"), None);
    }

    #[test]
    fn drain_hands_back_what_is_left() {
        let mut followed = Followed::default();
        followed.follow("a", || 1);
        followed.follow("b", || 2);
        *followed.get_mut(&"b").unwrap() += 1;
        let mut left: Vec<_> = followed.drain().collect();
        left.sort_unstable();
        assert_eq!(left, [("a", 1), ("b", 3)]);
        assert_eq!(followed.get(&"a"), None);
    }
}
