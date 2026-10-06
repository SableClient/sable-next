use std::collections::HashMap;
use std::hash::BuildHasher;

pub struct Process {
    pub parent: Option<u32>,
    pub name: String,
}

#[must_use]
pub fn app_name(executable: &str) -> &str {
    executable
        .rsplit_once('.')
        .map_or(executable, |(stem, _)| stem)
}

#[must_use]
pub fn tree_root<S: BuildHasher>(pid: u32, processes: &HashMap<u32, Process, S>) -> u32 {
    let Some(name) = processes.get(&pid).map(|process| &process.name) else {
        return pid;
    };
    let mut root = pid;
    let mut hops = 0;
    while let Some(parent) = processes.get(&root).and_then(|process| process.parent)
        && parent != root
        && processes
            .get(&parent)
            .is_some_and(|process| process.name.eq_ignore_ascii_case(name))
        && hops < processes.len()
    {
        root = parent;
        hops += 1;
    }
    root
}

#[must_use]
pub fn descends_from<S: BuildHasher>(
    pid: u32,
    ancestor: u32,
    processes: &HashMap<u32, Process, S>,
) -> bool {
    let mut current = pid;
    for _ in 0..processes.len() {
        let Some(parent) = processes.get(&current).and_then(|process| process.parent) else {
            return false;
        };
        if parent == ancestor {
            return true;
        }
        current = parent;
    }
    false
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::{Process, app_name, descends_from, tree_root};

    fn table(entries: &[(u32, Option<u32>, &str)]) -> HashMap<u32, Process> {
        entries
            .iter()
            .map(|&(pid, parent, name)| {
                (
                    pid,
                    Process {
                        parent,
                        name: name.to_owned(),
                    },
                )
            })
            .collect()
    }

    #[test]
    fn the_extension_is_dropped_from_an_app_name() {
        assert_eq!(app_name("chrome.exe"), "chrome");
        assert_eq!(app_name("Spotify"), "Spotify");
    }

    #[test]
    fn a_helper_resolves_to_the_browser_that_launched_it() {
        let processes = table(&[
            (1, None, "explorer.exe"),
            (10, Some(1), "chrome.exe"),
            (11, Some(10), "chrome.exe"),
            (12, Some(11), "chrome.exe"),
        ]);
        assert_eq!(tree_root(12, &processes), 10);
        assert_eq!(tree_root(10, &processes), 10);
    }

    #[test]
    fn the_climb_stops_at_a_different_program() {
        let processes = table(&[(1, None, "game.exe"), (2, Some(1), "launcher.exe")]);
        assert_eq!(tree_root(2, &processes), 2);
    }

    #[test]
    fn a_parent_cycle_terminates() {
        let processes = table(&[(1, Some(2), "a.exe"), (2, Some(1), "a.exe")]);
        let root = tree_root(1, &processes);
        assert!(root == 1 || root == 2);
    }

    #[test]
    fn descent_follows_the_parent_chain_across_names() {
        let processes = table(&[
            (1, None, "sable.exe"),
            (2, Some(1), "msedgewebview2.exe"),
            (3, Some(2), "msedgewebview2.exe"),
            (9, None, "spotify.exe"),
        ]);
        assert!(descends_from(3, 1, &processes));
        assert!(!descends_from(9, 1, &processes));
        assert!(!descends_from(1, 1, &processes));
    }
}
