use std::collections::{BTreeSet, HashMap};
use std::hash::{Hash, Hasher};

use matrix_sdk::ruma::{OwnedServerName, ServerName};

const DISTINCT_FAILURES_TO_OPEN: usize = 3;
const FAILURE_WINDOW_MS: u64 = 10 * 60 * 1000;
const INITIAL_BACKOFF_MS: u64 = 60 * 1000;
const MAX_BACKOFF_MS: u64 = 30 * 60 * 1000;
const PROBE_WAIT_MS: u64 = 5 * 1000;

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
pub(crate) struct MediaHealth {
    servers: HashMap<OwnedServerName, ServerHealth>,
}

impl MediaHealth {
    pub(crate) fn admit(&mut self, server: &ServerName, now_ms: u64) -> Admission {
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

    pub(crate) fn succeeded(&mut self, server: &ServerName) {
        self.servers.remove(server);
    }

    pub(crate) fn failed(&mut self, server: &ServerName, media_id: &str, now_ms: u64) {
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
        assert_eq!(health.admit(server, NOW), Admission::Allowed);

        health.failed(server, "c", NOW);
        assert!(matches!(
            health.admit(server, NOW),
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
            health.admit(server, NOW + FAILURE_WINDOW_MS + 1),
            Admission::Allowed
        );
    }

    #[test]
    fn test_an_open_server_lets_exactly_one_probe_through_once_the_backoff_expires() {
        let server = server_name!("dead.example");
        let mut health = MediaHealth::default();
        open(&mut health, server, NOW);
        let later = NOW + MAX_BACKOFF_MS;

        assert_eq!(health.admit(server, later), Admission::Probe);
        assert_eq!(
            health.admit(server, later),
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
            assert_eq!(health.admit(server, now), Admission::Probe);
            health.failed(server, "a", now);
        }

        let Admission::Refused { retry_after_ms } = health.admit(server, now) else {
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
        let Admission::Refused { retry_after_ms } = health.admit(server, NOW) else {
            panic!("the server should be refused");
        };

        for id in ["d", "e", "f", "g"] {
            health.failed(server, id, NOW);
        }

        assert_eq!(
            health.admit(server, NOW),
            Admission::Refused { retry_after_ms }
        );
    }

    #[test]
    fn test_a_success_closes_the_circuit() {
        let server = server_name!("back.example");
        let mut health = MediaHealth::default();
        open(&mut health, server, NOW);

        assert_eq!(
            health.admit(server, NOW + MAX_BACKOFF_MS * 2),
            Admission::Probe
        );
        health.succeeded(server);

        assert_eq!(
            health.admit(server, NOW + MAX_BACKOFF_MS * 2),
            Admission::Allowed
        );
    }

    #[test]
    fn test_an_abandoned_probe_frees_the_slot_for_another() {
        let server = server_name!("dead.example");
        let mut health = MediaHealth::default();
        open(&mut health, server, NOW);
        let later = NOW + MAX_BACKOFF_MS * 2;

        assert_eq!(health.admit(server, later), Admission::Probe);
        health.abandoned(server);

        assert_eq!(health.admit(server, later), Admission::Probe);
    }

    #[test]
    fn test_servers_are_tracked_independently() {
        let dead = server_name!("dead.example");
        let alive = server_name!("alive.example");
        let mut health = MediaHealth::default();
        open(&mut health, dead, NOW);

        assert_eq!(health.admit(alive, NOW), Admission::Allowed);
    }
}
