use sable_model::emote_picker::{reaction_identity as identity, rememberable_reaction};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::protocol::{CoreEvent, RpcError};
use crate::{Core, ResultExt};

const EVENT_TYPE: &str = "m.recent_emoji";
const STORE_KEY: &[u8] = b"sable.reaction_history";
const DAY_MS: u64 = 86_400_000;
const HISTORY_DAYS: u64 = 30;
const MAX_ENTRIES: usize = 100;

#[derive(Deserialize, Serialize)]
struct Usage {
    day: u64,
    device: String,
    count: u64,
    last_used: u64,
}

#[derive(Serialize)]
struct Entry {
    emoji: String,
    total: u64,
    #[serde(rename = "moe.sable.usage")]
    usage: Vec<Usage>,
}

#[derive(Default)]
struct History {
    entries: Vec<Entry>,
}

impl History {
    fn read(content: &Value, now: u64) -> Self {
        let mut history = Self::default();
        let entries = content.get("recent_emoji").unwrap_or(content);
        for value in entries.as_array().into_iter().flatten() {
            let key = value
                .as_str()
                .or_else(|| value.get("emoji")?.as_str())
                .or_else(|| value.get(0)?.as_str());
            let Some(key) = key.filter(|key| rememberable_reaction(key)) else {
                continue;
            };
            // Old totals have no dates, so seed them with one use.
            let usage = value.get("moe.sable.usage").map_or_else(
                || {
                    vec![Usage {
                        day: now / DAY_MS,
                        device: "legacy".to_owned(),
                        count: 1,
                        last_used: now,
                    }]
                },
                |value| {
                    value
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter_map(|value| serde_json::from_value::<Usage>(value.clone()).ok())
                        .filter(|usage| valid_usage(usage, now))
                        .collect()
                },
            );
            history.merge_entry(Entry {
                emoji: key.to_owned(),
                total: 0,
                usage,
            });
        }
        history.prune(now);
        history
    }

    fn merge_entry(&mut self, entry: Entry) {
        let key = identity(&entry.emoji);
        let index = self
            .entries
            .iter()
            .position(|entry| identity(&entry.emoji) == key)
            .unwrap_or_else(|| {
                self.entries.push(Entry {
                    emoji: entry.emoji,
                    total: 0,
                    usage: Vec::new(),
                });
                self.entries.len() - 1
            });
        if let Some(existing) = self.entries.get_mut(index) {
            for usage in entry.usage {
                if let Some(previous) = existing
                    .usage
                    .iter_mut()
                    .find(|previous| previous.day == usage.day && previous.device == usage.device)
                {
                    previous.count = previous.count.max(usage.count);
                    previous.last_used = previous.last_used.max(usage.last_used);
                } else {
                    existing.usage.push(usage);
                }
            }
        }
    }

    fn merge(&mut self, other: Self, now: u64) {
        for entry in other.entries {
            self.merge_entry(entry);
        }
        self.prune(now);
    }

    fn prune(&mut self, now: u64) {
        for entry in &mut self.entries {
            entry.usage.retain(|usage| valid_usage(usage, now));
            entry.usage.sort_by(|left, right| {
                left.day
                    .cmp(&right.day)
                    .then_with(|| left.device.cmp(&right.device))
            });
            entry.total = entry
                .usage
                .iter()
                .fold(0_u64, |total, usage| total.saturating_add(usage.count));
        }
        self.entries.retain(|entry| entry.total > 0);
        self.entries.sort_by(|left, right| {
            right
                .total
                .cmp(&left.total)
                .then_with(|| last_used(right).cmp(&last_used(left)))
                .then_with(|| left.emoji.cmp(&right.emoji))
        });
        self.entries.truncate(MAX_ENTRIES);
    }

    fn remember(&mut self, key: &str, device: &str, now: u64) {
        if !rememberable_reaction(key) {
            return;
        }
        let key_id = identity(key);
        let mut entry = self
            .entries
            .iter()
            .position(|entry| identity(&entry.emoji) == key_id)
            .map_or_else(
                || Entry {
                    emoji: key.to_owned(),
                    total: 0,
                    usage: Vec::new(),
                },
                |index| self.entries.remove(index),
            );
        key.clone_into(&mut entry.emoji);
        let day = now / DAY_MS;
        if let Some(usage) = entry
            .usage
            .iter_mut()
            .find(|usage| usage.day == day && usage.device == device)
        {
            usage.count = usage.count.saturating_add(1);
            usage.last_used = now;
        } else {
            entry.usage.push(Usage {
                day,
                device: device.to_owned(),
                count: 1,
                last_used: now,
            });
        }
        self.entries.push(entry);
        self.prune(now);
    }

    fn content(&self) -> Value {
        json!({ "recent_emoji": self.entries })
    }

    fn keys(&self) -> Vec<String> {
        self.entries
            .iter()
            .map(|entry| entry.emoji.clone())
            .collect()
    }
}

fn last_used(entry: &Entry) -> u64 {
    entry
        .usage
        .iter()
        .map(|usage| usage.last_used)
        .max()
        .unwrap_or_default()
}

const fn valid_usage(usage: &Usage, now: u64) -> bool {
    let today = now / DAY_MS;
    usage.day <= today
        && today - usage.day < HISTORY_DAYS
        && usage.count > 0
        && usage.last_used <= now
        && usage.last_used / DAY_MS == usage.day
}

impl Core {
    pub(crate) async fn frequent_reactions(
        &self,
        legacy: Option<Value>,
    ) -> Result<Vec<String>, RpcError> {
        self.update_reaction_history(None, legacy).await
    }

    pub(crate) async fn remember_reaction(&self, key: &str) -> Result<(), RpcError> {
        self.update_reaction_history(Some(key), None)
            .await
            .map(|_| ())
    }

    async fn update_reaction_history(
        &self,
        key: Option<&str>,
        legacy: Option<Value>,
    ) -> Result<Vec<String>, RpcError> {
        let _guard = self.account_data_lock.lock().await;
        let client = self.client().await?;
        let now = web_time::SystemTime::now()
            .duration_since(web_time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
            .try_into()
            .unwrap_or(u64::MAX);
        let local = client
            .state_store()
            .get_custom_value(STORE_KEY)
            .await
            .or_failed(self, "reaction_history")?
            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok());
        let mut history = local
            .as_ref()
            .map_or_else(History::default, |content| History::read(content, now));
        let remote = client.account().fetch_account_data(EVENT_TYPE.into()).await;
        if let Ok(Some(content)) = &remote {
            if let Ok(content) = content.deserialize_as::<Value>() {
                let mut content = content;
                // An old client's undated snapshot must not refresh an already dated local entry.
                if local.is_some()
                    && let Some(entries) = content
                        .get_mut("recent_emoji")
                        .and_then(Value::as_array_mut)
                {
                    entries.retain(|entry| entry.get("moe.sable.usage").is_some());
                }
                history.merge(History::read(&content, now), now);
            }
        } else if local.is_none()
            && matches!(remote, Ok(None))
            && let Some(legacy) = legacy
        {
            history = History::read(&legacy, now);
        }
        if let Some(key) = key {
            let device = client.device_id().ok_or(RpcError::Unavailable)?;
            history.remember(key, device.as_str(), now);
        }
        let content = history.content();
        let bytes = serde_json::to_vec(&content).or_failed(self, "reaction_history")?;
        client
            .state_store()
            .set_custom_value_no_read(STORE_KEY, bytes)
            .await
            .or_failed(self, "reaction_history")?;
        if local.as_ref() != Some(&content) {
            self.emit(CoreEvent::AccountDataChanged {
                event_type: EVENT_TYPE.to_owned(),
            });
        }
        // Keep local counters even offline. A later read merges them before retrying the upload.
        if let Ok(remote) = remote {
            let previous = remote.and_then(|raw| raw.deserialize_as::<Value>().ok());
            if previous.as_ref() != Some(&content)
                && (previous.is_some() || !history.entries.is_empty())
                && let Err(error) = client
                    .account()
                    .set_account_data_raw(
                        EVENT_TYPE.into(),
                        matrix_sdk::ruma::serde::Raw::new(&content)
                            .or_failed(self, "reaction_history")?
                            .cast_unchecked(),
                    )
                    .await
            {
                tracing::warn!("reaction history was saved locally but not uploaded: {error}");
            }
        }
        Ok(history.keys())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: u64 = 100 * DAY_MS;

    #[test]
    fn frequency_leads_and_recency_only_breaks_ties() {
        let mut history = History::default();
        history.remember("🔥", "phone", NOW);
        history.remember("🔥", "phone", NOW + 1);
        history.remember("🎉", "phone", NOW + 2);
        assert_eq!(history.keys(), ["🔥", "🎉"]);
        history.remember("🎉", "phone", NOW + 3);
        assert_eq!(history.keys(), ["🎉", "🔥"]);
    }

    #[test]
    fn old_counts_expire_even_when_the_same_emoji_is_used_again() {
        let mut history = History::default();
        for _ in 0..10 {
            history.remember("🔥", "phone", NOW);
        }
        history.remember("🎉", "phone", NOW + 29 * DAY_MS);
        history.remember("🎉", "phone", NOW + 29 * DAY_MS + 1);
        history.remember("🔥", "phone", NOW + 30 * DAY_MS);
        assert_eq!(history.keys(), ["🎉", "🔥"]);
        assert_eq!(
            history
                .entries
                .iter()
                .map(|entry| entry.total)
                .collect::<Vec<_>>(),
            [2, 1]
        );
        history.prune(NOW + 60 * DAY_MS);
        assert_eq!(history.keys(), Vec::<String>::new());
    }

    #[test]
    fn duplicate_variants_share_a_counter_but_skin_tones_remain_distinct() {
        let mut history = History::default();
        for key in ["❤", "❤️", "❤︎", "👍", "👍🏽", "mxc://example.org/cat"] {
            history.remember(key, "phone", NOW);
        }
        assert_eq!(history.entries.len(), 4);
        assert_eq!(history.entries.first().unwrap().total, 3);
        let restored = History::read(&history.content(), NOW);
        assert_eq!(restored.keys(), history.keys());
    }

    #[test]
    fn device_counters_merge_without_losing_uses_or_counting_an_echo_twice() {
        let mut phone = History::default();
        let mut desktop = History::default();
        phone.remember("🔥", "phone", NOW);
        desktop.remember("🔥", "desktop", NOW);
        desktop.remember("🔥", "desktop", NOW + 1);
        let echo = desktop.content();
        phone.merge(desktop, NOW + 1);
        phone.merge(History::read(&echo, NOW + 1), NOW + 1);
        assert_eq!(phone.entries.first().unwrap().total, 3);
    }

    #[test]
    fn legacy_totals_seed_one_use_and_expire() {
        let mut history = History::read(
            &json!({"recent_emoji": [
                {"emoji": "🔥", "total": 5000}, ["❤️", 12], "❤", null, {}, 7
            ]}),
            NOW,
        );
        assert_eq!(history.entries.len(), 2);
        assert!(history.entries.iter().all(|entry| entry.total == 1));
        history.remember("🎉", "phone", NOW + 1);
        history.remember("🎉", "phone", NOW + 2);
        assert_eq!(history.keys().first().unwrap(), "🎉");
        history.prune(NOW + 30 * DAY_MS);
        assert_eq!(history.keys(), Vec::<String>::new());
    }

    #[test]
    fn text_reactions_are_never_stored_and_old_ones_are_purged() {
        let key = "EsTc 1234 abcd efgh";
        let mut history = History::read(
            &json!({"recent_emoji": [
                {"emoji": key, "total": 3}, {"emoji": "🔥", "total": 1}, "+1", "1"
            ]}),
            NOW,
        );
        history.remember("hello", "phone", NOW);
        history.remember("😂😂", "phone", NOW);
        assert_eq!(history.keys(), ["🔥"]);
        assert!(!history.content().to_string().contains(key));
    }

    #[test]
    fn malformed_future_and_repeated_buckets_do_not_inflate_the_ranking() {
        let usage = json!({"day": 100, "device": "phone", "count": 2, "last_used": NOW});
        let history = History::read(
            &json!({"recent_emoji": [
                {"emoji": "🔥", "moe.sable.usage": [usage, usage, null,
                    {"day": 101, "device": "phone", "count": 9999, "last_used": NOW},
                    {"day": 100, "device": "other", "count": 9999, "last_used": NOW + 1}]},
                {"emoji": "🎉", "moe.sable.usage": []}
            ]}),
            NOW,
        );
        assert_eq!(history.keys(), ["🔥"]);
        assert_eq!(history.entries.first().unwrap().total, 2);
    }

    #[test]
    fn storage_keeps_only_the_top_hundred_reactions_and_thirty_days_per_device() {
        let mut history = History::default();
        for index in 0..150 {
            history.remember(&format!("mxc://example.org/{index}"), "phone", NOW + index);
        }
        for day in 1..90 {
            history.remember("🔥", "phone", NOW + day * DAY_MS);
        }
        assert_eq!(history.keys(), ["🔥"]);
        assert_eq!(history.entries.first().unwrap().usage.len(), 30);
        assert_eq!(history.entries.first().unwrap().total, 30);
    }

    #[tokio::test]
    #[cfg(not(target_family = "wasm"))]
    async fn reaction_history_records_additions_once_and_survives_a_new_core() {
        use std::sync::{Arc, Mutex};

        use crate::{api::messages::ReactParams, session::Session, store::MemorySessionStore};
        use matrix_sdk::{
            ruma::{event_id, room_id},
            test_utils::mocks::MatrixMockServer,
        };
        use matrix_sdk_test::{JoinedRoomBuilder, User, event_factory::EventFactory};
        use matrix_sdk_ui::sync_service::SyncService;
        use wiremock::{
            Mock, ResponseTemplate,
            matchers::{method, path_regex},
        };

        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;
        server.mock_room_state_encryption().plain().mount().await;
        let room_id = room_id!("!reactions:example.org");
        let target = event_id!("$message");
        let factory = EventFactory::new().room(room_id).sender(User::Alice);
        server
            .sync_room(
                &client,
                JoinedRoomBuilder::new(room_id)
                    .add_timeline_event(factory.text_msg("Hello").event_id(target)),
            )
            .await;
        server
            .mock_room_send()
            .ok(event_id!("$reaction"))
            .mount()
            .await;

        Mock::given(method("PUT"))
            .and(path_regex("/redact/"))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(json!({"event_id": "$redaction"})),
            )
            .mount(server.server())
            .await;

        let stored = Arc::new(Mutex::new(json!({"recent_emoji": []})));
        let get = stored.clone();
        Mock::given(method("GET"))
            .and(path_regex("/account_data/m.recent_emoji$"))
            .respond_with(move |_: &wiremock::Request| {
                ResponseTemplate::new(200).set_body_json(get.lock().unwrap().clone())
            })
            .mount(server.server())
            .await;
        let put = stored.clone();
        Mock::given(method("PUT"))
            .and(path_regex("/account_data/m.recent_emoji$"))
            .respond_with(move |request: &wiremock::Request| {
                *put.lock().unwrap() = request.body_json().unwrap();
                ResponseTemplate::new(200).set_body_json(json!({}))
            })
            .mount(server.server())
            .await;
        let (core, _events) = Core::new("history-test", Box::new(MemorySessionStore::default()));
        *core.session.write().await = Some(Session {
            account_id: "test".into(),
            client: client.clone(),
            sync_service: Arc::new(SyncService::builder(client.clone()).build().await.unwrap()),
            homeserver: server.server().uri(),
            oauth: false,
        });
        let react = || ReactParams {
            room_id: room_id.to_owned(),
            event_id: target.to_owned(),
            key: "🔥".into(),
            source_pack: None,
            shortcode: None,
            thread_root: None,
            subscription: None,
            persona: None,
        };
        core.run(react()).await.unwrap();
        assert_eq!(core.frequent_reactions(None).await.unwrap(), ["🔥"]);
        assert_eq!(stored.lock().unwrap()["recent_emoji"][0]["total"], 1);
        core.run(react()).await.unwrap();
        assert_eq!(stored.lock().unwrap()["recent_emoji"][0]["total"], 1);
        assert!(
            core.run(ReactParams {
                event_id: event_id!("$missing").to_owned(),
                ..react()
            })
            .await
            .is_err()
        );
        assert_eq!(stored.lock().unwrap()["recent_emoji"][0]["total"], 1);

        let (restored, _events) =
            Core::new("history-test", Box::new(MemorySessionStore::default()));
        *restored.session.write().await = Some(Session {
            account_id: "test".into(),
            client: client.clone(),
            sync_service: Arc::new(SyncService::builder(client.clone()).build().await.unwrap()),
            homeserver: server.server().uri(),
            oauth: false,
        });
        assert_eq!(restored.frequent_reactions(None).await.unwrap(), ["🔥"]);
    }

    #[tokio::test]
    #[cfg(not(target_family = "wasm"))]
    async fn reaction_history_keeps_offline_counts_and_merges_them_on_reconnect() {
        use crate::{session::Session, store::MemorySessionStore};
        use matrix_sdk::test_utils::mocks::MatrixMockServer;
        use matrix_sdk_ui::sync_service::SyncService;
        use std::sync::Arc;
        use wiremock::{
            Mock, ResponseTemplate,
            matchers::{method, path_regex},
        };

        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;
        let (core, _events) = Core::new(
            "offline-history-test",
            Box::new(MemorySessionStore::default()),
        );
        *core.session.write().await = Some(Session {
            account_id: "test".into(),
            client: client.clone(),
            sync_service: Arc::new(SyncService::builder(client.clone()).build().await.unwrap()),
            homeserver: server.server().uri(),
            oauth: false,
        });
        let unavailable = Mock::given(method("GET"))
            .and(path_regex("/account_data/m.recent_emoji$"))
            .respond_with(
                ResponseTemplate::new(403)
                    .set_body_json(json!({"errcode": "M_FORBIDDEN", "error": "offline fixture"})),
            )
            .mount_as_scoped(server.server())
            .await;
        core.remember_reaction("🔥").await.unwrap();
        assert_eq!(core.frequent_reactions(None).await.unwrap(), ["🔥"]);
        drop(unavailable);

        let now = web_time::SystemTime::now()
            .duration_since(web_time::UNIX_EPOCH)
            .unwrap()
            .as_millis()
            .try_into()
            .unwrap();
        let mut remote = History::default();
        remote.remember("🔥", "other-device", now);
        remote.remember("🔥", "other-device", now);
        Mock::given(method("GET"))
            .and(path_regex("/account_data/m.recent_emoji$"))
            .respond_with(ResponseTemplate::new(200).set_body_json(remote.content()))
            .mount(server.server())
            .await;
        Mock::given(method("PUT"))
            .and(path_regex("/account_data/m.recent_emoji$"))
            .respond_with(|request: &wiremock::Request| {
                assert_eq!(
                    request.body_json::<Value>().unwrap()["recent_emoji"][0]["total"],
                    3
                );
                ResponseTemplate::new(200).set_body_json(json!({}))
            })
            .expect(1)
            .mount(server.server())
            .await;
        assert_eq!(core.frequent_reactions(None).await.unwrap(), ["🔥"]);
    }
}
