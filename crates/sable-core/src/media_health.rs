use std::collections::{BTreeSet, HashMap};
use std::hash::{Hash, Hasher};

use matrix_sdk::ruma::{OwnedServerName, ServerName};

const DISTINCT_FAILURES_TO_OPEN: usize = 3;
const FAILURE_WINDOW_MS: u64 = 10 * 60 * 1000;
const INITIAL_BACKOFF_MS: u64 = 60 * 1000;
const MAX_BACKOFF_MS: u64 = 5 * 60 * 1000;
const PROBE_WAIT_MS: u64 = 5 * 1000;
const MEDIA_FAILURES_TO_REFUSE: u32 = 3;
const PERSISTENT_MEDIA_FAILURE_MS: u64 = 10 * 1000;

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Admission {
    Allowed,
    Probe,
    Refused { retry_after_ms: u64 },
}

#[derive(Default)]
struct ServerHealth {
    failing: BTreeSet<String>,
    first_failure_ms: u64,
    open_until_ms: u64,
    backoff_ms: u64,
    probing: bool,
}

impl ServerHealth {
    const fn is_open(&self) -> bool {
        self.backoff_ms > 0
    }
}

#[derive(Default)]
struct FileHealth {
    failures: u32,
    first_failure_ms: u64,
    open_until_ms: u64,
    backoff_ms: u64,
}

#[derive(Default)]
pub(crate) struct MediaHealth {
    servers: HashMap<OwnedServerName, ServerHealth>,
    files: HashMap<(OwnedServerName, String), FileHealth>,
}

impl MediaHealth {
    pub(crate) fn admit(&mut self, server: &ServerName, media_id: &str, now_ms: u64) -> Admission {
        if let Some(file) = self.files.get(&(server.to_owned(), media_id.to_owned()))
            && now_ms < file.open_until_ms
        {
            return Admission::Refused {
                retry_after_ms: file.open_until_ms - now_ms,
            };
        }
        let Some(health) = self.servers.get_mut(server) else {
            return Admission::Allowed;
        };
        if !health.is_open() {
            return Admission::Allowed;
        }
        if now_ms < health.open_until_ms {
            return Admission::Refused {
                retry_after_ms: health.open_until_ms - now_ms,
            };
        }
        if health.probing {
            return Admission::Refused {
                retry_after_ms: PROBE_WAIT_MS,
            };
        }
        health.probing = true;
        Admission::Probe
    }

    pub(crate) fn succeeded(&mut self, server: &ServerName, media_id: &str) {
        self.servers.remove(server);
        self.files.remove(&(server.to_owned(), media_id.to_owned()));
    }

    pub(crate) fn failed(&mut self, server: &ServerName, media_id: &str, now_ms: u64) {
        self.file_failed(server, media_id, now_ms);
        let health = self.servers.entry(server.to_owned()).or_default();
        if health.is_open() {
            if health.probing {
                health.backoff_ms = (health.backoff_ms * 2).min(MAX_BACKOFF_MS);
                health.open_until_ms = now_ms + jittered(server, health.backoff_ms);
                health.probing = false;
            }
            return;
        }
        if health.failing.is_empty()
            || now_ms.saturating_sub(health.first_failure_ms) > FAILURE_WINDOW_MS
        {
            health.failing.clear();
            health.first_failure_ms = now_ms;
        }
        health.failing.insert(media_id.to_owned());
        if health.failing.len() >= DISTINCT_FAILURES_TO_OPEN {
            health.failing.clear();
            health.backoff_ms = INITIAL_BACKOFF_MS;
            health.open_until_ms = now_ms + jittered(server, health.backoff_ms);
        }
    }

    fn file_failed(&mut self, server: &ServerName, media_id: &str, now_ms: u64) {
        let file = self
            .files
            .entry((server.to_owned(), media_id.to_owned()))
            .or_default();
        if file.backoff_ms > 0 {
            if now_ms >= file.open_until_ms {
                file.backoff_ms = (file.backoff_ms * 2).min(MAX_BACKOFF_MS);
                file.open_until_ms = now_ms + jittered(server, file.backoff_ms);
            }
            return;
        }
        if file.failures == 0 || now_ms.saturating_sub(file.first_failure_ms) > FAILURE_WINDOW_MS {
            file.failures = 0;
            file.first_failure_ms = now_ms;
        }
        file.failures += 1;
        if file.failures >= MEDIA_FAILURES_TO_REFUSE
            && now_ms.saturating_sub(file.first_failure_ms) >= PERSISTENT_MEDIA_FAILURE_MS
        {
            file.backoff_ms = INITIAL_BACKOFF_MS;
            file.open_until_ms = now_ms + jittered(server, file.backoff_ms);
        }
    }

    pub(crate) fn abandoned(&mut self, server: &ServerName) {
        if let Some(health) = self.servers.get_mut(server) {
            health.probing = false;
        }
    }
}

fn jittered(server: &ServerName, backoff_ms: u64) -> u64 {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    server.hash(&mut hasher);
    backoff_ms.hash(&mut hasher);
    let spread = backoff_ms / 5;
    backoff_ms - spread + hasher.finish() % (spread * 2 + 1)
}

#[cfg(test)]
mod tests {
    use matrix_sdk::ruma::server_name;

    use super::*;

    const NOW: u64 = 1_000_000;

    fn open(health: &mut MediaHealth, server: &ServerName, now: u64) {
        for id in ["a", "b", "c"] {
            health.failed(server, id, now);
        }
    }

    #[test]
    fn test_a_server_is_admitted_until_three_distinct_media_fail() {
        let server = server_name!("dead.example");
        let mut health = MediaHealth::default();

        health.failed(server, "a", NOW);
        health.failed(server, "a", NOW);
        health.failed(server, "b", NOW);
        assert_eq!(health.admit(server, "z", NOW), Admission::Allowed);

        health.failed(server, "c", NOW);
        assert!(matches!(
            health.admit(server, "z", NOW),
            Admission::Refused { retry_after_ms } if retry_after_ms >= INITIAL_BACKOFF_MS * 4 / 5
        ));
    }

    #[test]
    fn test_failures_older_than_the_window_do_not_add_up() {
        let server = server_name!("flaky.example");
        let mut health = MediaHealth::default();

        health.failed(server, "a", NOW);
        health.failed(server, "b", NOW);
        health.failed(server, "c", NOW + FAILURE_WINDOW_MS + 1);

        assert_eq!(
            health.admit(server, "z", NOW + FAILURE_WINDOW_MS + 1),
            Admission::Allowed
        );
    }

    #[test]
    fn test_an_open_server_lets_exactly_one_probe_through_once_the_backoff_expires() {
        let server = server_name!("dead.example");
        let mut health = MediaHealth::default();
        open(&mut health, server, NOW);
        let later = NOW + MAX_BACKOFF_MS;

        assert_eq!(health.admit(server, "z", later), Admission::Probe);
        assert_eq!(
            health.admit(server, "z", later),
            Admission::Refused {
                retry_after_ms: PROBE_WAIT_MS
            }
        );
    }

    #[test]
    fn test_a_failed_probe_doubles_the_backoff_up_to_the_cap() {
        let server = server_name!("dead.example");
        let mut health = MediaHealth::default();
        open(&mut health, server, NOW);

        let mut now = NOW;
        for _ in 0..10 {
            now += MAX_BACKOFF_MS * 2;
            assert_eq!(health.admit(server, "z", now), Admission::Probe);
            health.failed(server, "a", now);
        }

        let Admission::Refused { retry_after_ms } = health.admit(server, "z", now) else {
            panic!("the server should still be refused");
        };
        assert!(retry_after_ms <= MAX_BACKOFF_MS * 6 / 5);
        assert!(retry_after_ms >= MAX_BACKOFF_MS * 4 / 5);
    }

    #[test]
    fn test_requests_already_in_flight_when_the_circuit_opens_do_not_extend_it() {
        let server = server_name!("dead.example");
        let mut health = MediaHealth::default();
        open(&mut health, server, NOW);
        let Admission::Refused { retry_after_ms } = health.admit(server, "z", NOW) else {
            panic!("the server should be refused");
        };

        for id in ["d", "e", "f", "g"] {
            health.failed(server, id, NOW);
        }

        assert_eq!(
            health.admit(server, "z", NOW),
            Admission::Refused { retry_after_ms }
        );
    }

    #[test]
    fn test_a_success_closes_the_circuit() {
        let server = server_name!("back.example");
        let mut health = MediaHealth::default();
        open(&mut health, server, NOW);

        assert_eq!(
            health.admit(server, "z", NOW + MAX_BACKOFF_MS * 2),
            Admission::Probe
        );
        health.succeeded(server, "z");

        assert_eq!(
            health.admit(server, "z", NOW + MAX_BACKOFF_MS * 2),
            Admission::Allowed
        );
    }

    #[test]
    fn test_an_abandoned_probe_frees_the_slot_for_another() {
        let server = server_name!("dead.example");
        let mut health = MediaHealth::default();
        open(&mut health, server, NOW);
        let later = NOW + MAX_BACKOFF_MS * 2;

        assert_eq!(health.admit(server, "z", later), Admission::Probe);
        health.abandoned(server);

        assert_eq!(health.admit(server, "z", later), Admission::Probe);
    }

    #[test]
    fn test_servers_are_tracked_independently() {
        let dead = server_name!("dead.example");
        let alive = server_name!("alive.example");
        let mut health = MediaHealth::default();
        open(&mut health, dead, NOW);

        assert_eq!(health.admit(alive, "z", NOW), Admission::Allowed);
    }

    #[test]
    fn test_one_file_failing_past_the_cold_fetch_window_is_refused_alone() {
        let server = server_name!("remote.example");
        let mut health = MediaHealth::default();

        health.failed(server, "avatar", NOW);
        health.failed(server, "avatar", NOW + 4_000);
        assert_eq!(
            health.admit(server, "avatar", NOW + 4_000),
            Admission::Allowed
        );
        health.failed(server, "avatar", NOW + PERSISTENT_MEDIA_FAILURE_MS);

        let later = NOW + PERSISTENT_MEDIA_FAILURE_MS;
        assert!(matches!(
            health.admit(server, "avatar", later),
            Admission::Refused { retry_after_ms } if retry_after_ms >= INITIAL_BACKOFF_MS * 4 / 5
        ));
        assert_eq!(health.admit(server, "other", later), Admission::Allowed);
    }

    #[test]
    fn test_a_burst_of_cold_failures_is_not_refused() {
        let server = server_name!("remote.example");
        let mut health = MediaHealth::default();

        for _ in 0..5 {
            health.failed(server, "avatar", NOW + 1_000);
        }

        assert_eq!(
            health.admit(server, "avatar", NOW + 2_000),
            Admission::Allowed
        );
    }

    #[test]
    fn test_a_refused_file_backs_off_further_and_recovers_on_success() {
        let server = server_name!("remote.example");
        let mut health = MediaHealth::default();
        for at in [NOW, NOW + 5_000, NOW + PERSISTENT_MEDIA_FAILURE_MS] {
            health.failed(server, "avatar", at);
        }

        health.failed(server, "avatar", NOW + PERSISTENT_MEDIA_FAILURE_MS + 1);
        let expired = NOW + PERSISTENT_MEDIA_FAILURE_MS + INITIAL_BACKOFF_MS * 2;
        assert_eq!(health.admit(server, "avatar", expired), Admission::Allowed);
        health.failed(server, "avatar", expired);
        assert!(matches!(
            health.admit(server, "avatar", expired),
            Admission::Refused { retry_after_ms } if retry_after_ms >= INITIAL_BACKOFF_MS * 2 * 4 / 5
        ));

        health.succeeded(server, "avatar");
        assert_eq!(health.admit(server, "avatar", expired), Admission::Allowed);
    }
}
