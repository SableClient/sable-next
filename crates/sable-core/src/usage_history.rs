//! Counts of use shared through account data, which has no compare and swap.
//! A change is saved here before any request, then replayed onto what the server holds.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::ResultExt;
use crate::SignedIn;
use crate::protocol::{CoreEvent, RpcCode, RpcError};
use crate::sealed_account_data::{cached_key, is_sealed, read_account_data};

mod window;

use window::Uses;

pub(crate) const MAX_TOTAL: u64 = (1 << 53) - 1;

/// An account data event holding a newest first list of `{<key>, total}`.
pub(crate) struct Kind {
    pub(crate) event_type: &'static str,
    pub(crate) store_key: &'static [u8],
    pub(crate) list: &'static str,
    pub(crate) key: &'static str,
    pub(crate) limit: usize,
    pub(crate) sealed: bool,
    pub(crate) accepts: fn(&str) -> bool,
    pub(crate) identity: fn(&str) -> String,
}

impl Kind {
    pub(crate) fn read(&self, content: &Value) -> Vec<Value> {
        content
            .get(self.list)
            .unwrap_or(content)
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|value| self.read_entry(value))
            .collect()
    }

    fn read_entry(&self, value: &Value) -> Option<Value> {
        if value.is_object() {
            return self.counted(value).map(|_| value.clone());
        }
        // Older clients wrote bare keys or `[key, total]`.
        let key = value.as_str().or_else(|| value.get(0)?.as_str())?;
        let total = value.get(1).and_then(Value::as_u64).unwrap_or(1);
        (self.accepts)(key).then(|| self.entry(Map::new(), key, total.min(MAX_TOTAL)))
    }

    fn entry(&self, mut fields: Map<String, Value>, key: &str, total: u64) -> Value {
        fields.insert(self.key.to_owned(), key.into());
        fields.insert("total".to_owned(), total.into());
        Value::Object(fields)
    }

    fn counted<'a>(&self, entry: &'a Value) -> Option<(&'a str, u64)> {
        let key = entry.get(self.key)?.as_str()?;
        let total = entry.get("total")?.as_u64()?;
        (total <= MAX_TOTAL).then_some((key, total))
    }

    fn holds(&self, entries: &[Value], key: &str) -> bool {
        let id = (self.identity)(key);
        entries
            .iter()
            .filter_map(|entry| self.counted(entry))
            .any(|(known, _)| (self.identity)(known) == id)
    }

    /// The key, with how often it was used over the last thirty days and in all.
    pub(crate) fn frequency<'a>(
        &self,
        entry: &'a Value,
        now: u64,
    ) -> Option<(&'a str, (u64, u64))> {
        let (key, total) = self.counted(entry)?;
        let uses = window::frequency(&window::read(entry), total, now);
        Some((key, (uses, total)))
    }

    fn date(&self, entry: &mut Value, now: u64) {
        let Some((key, total)) = self.counted(entry) else {
            return;
        };
        // Entries this client does not understand are left as they are.
        if !(self.accepts)(key) {
            return;
        }
        let dated = window::date(window::read(entry), total, now);
        window::write(entry, &dated);
    }

    fn remember(&self, entries: &mut Vec<Value>, key: &str, picked: &[Uses]) {
        let id = (self.identity)(key);
        let mut total = window::sum(picked);
        let mut buckets = Vec::new();
        let mut fields = None;
        entries.retain(|entry| match self.counted(entry) {
            Some((known, uses)) if (self.identity)(known) == id => {
                total = total.saturating_add(uses);
                for uses in window::read(entry) {
                    window::add(&mut buckets, uses);
                }
                if fields.is_none() {
                    fields = entry.as_object().cloned();
                }
                false
            }
            _ => true,
        });
        for uses in picked {
            window::add(&mut buckets, uses.clone());
        }
        let mut entry = self.entry(fields.unwrap_or_default(), key, total.min(MAX_TOTAL));
        window::write(&mut entry, &buckets);
        entries.insert(0, entry);
    }
}

#[derive(Clone, Deserialize, Serialize)]
struct Pick {
    key: String,
    /// Dated when made, as it can wait here for months.
    uses: Vec<Uses>,
}

/// What the server has yet to receive, applied in field order.
#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(default)]
struct Pending {
    /// Stands in only while the server has no event of its own.
    fallback: Vec<Value>,
    /// Added at the end when absent.
    seeds: Vec<String>,
    /// Added at the front when absent.
    arrivals: Vec<String>,
    /// Oldest first, one for each key, so it stays as short as the list.
    picks: Vec<Pick>,
}

impl Pending {
    const fn is_empty(&self) -> bool {
        self.fallback.is_empty()
            && self.seeds.is_empty()
            && self.arrivals.is_empty()
            && self.picks.is_empty()
    }

    /// Leaves what was added after `sent` was taken.
    fn remove(&mut self, sent: &Self) {
        self.fallback.clear();
        self.seeds.retain(|key| !sent.seeds.contains(key));
        self.arrivals.retain(|key| !sent.arrivals.contains(key));
        for pick in &mut self.picks {
            if let Some(done) = sent.picks.iter().find(|done| done.key == pick.key) {
                // Oldest first, as compacting may have moved days since it was sent.
                let mut left = window::sum(&done.uses);
                for uses in &mut pick.uses {
                    let taken = uses.count.min(left);
                    uses.count -= taken;
                    left -= taken;
                }
                pick.uses.retain(|uses| uses.count > 0);
            }
        }
        self.picks.retain(|pick| !pick.uses.is_empty());
    }
}

#[derive(Clone, Deserialize, Serialize)]
struct Sent {
    entries: Vec<Value>,
    pending: Pending,
}

#[derive(Default, Deserialize, Serialize)]
#[serde(default)]
pub(crate) struct History {
    cached: Vec<Value>,
    pending: Pending,
    /// The last upload, until its response or the server's copy shows it landed.
    sent: Option<Sent>,
    /// The list older builds sync, as last seen.
    seen: Option<Vec<String>>,
    /// Earlier builds saved the event's content here, so it has the list's name.
    #[serde(flatten, skip_serializing)]
    earlier: Map<String, Value>,
}

pub(crate) struct Remote {
    pub(crate) content: Option<Value>,
    pub(crate) needs_seal: bool,
}

impl History {
    fn restore(kind: &Kind, bytes: &[u8]) -> Self {
        let mut history: Self = serde_json::from_slice(bytes).unwrap_or_else(|error| {
            tracing::warn!("the saved usage history is unreadable: {error}");
            Self::default()
        });
        let earlier = Value::Object(std::mem::take(&mut history.earlier));
        if earlier.get(kind.list).is_some() {
            history.pending.fallback = kind.read(&earlier);
        }
        history
    }

    pub(crate) fn entries(&self, kind: &Kind) -> Vec<Value> {
        let mut entries = if self.cached.is_empty() {
            self.pending.fallback.clone()
        } else {
            self.cached.clone()
        };
        for key in &self.pending.seeds {
            if !kind.holds(&entries, key) {
                entries.push(kind.entry(Map::new(), key, 1));
            }
        }
        for key in self.pending.arrivals.iter().rev() {
            if !kind.holds(&entries, key) {
                entries.insert(0, kind.entry(Map::new(), key, 1));
            }
        }
        for pick in &self.pending.picks {
            kind.remember(&mut entries, &pick.key, &pick.uses);
        }
        entries.truncate(kind.limit);
        entries
    }

    pub(crate) fn pick(&mut self, kind: &Kind, key: &str, device: &str, now: u64) {
        if !(kind.accepts)(key) {
            return;
        }
        let picks = &mut self.pending.picks;
        let mut uses = picks
            .iter()
            .position(|pick| pick.key == key)
            .map(|index| picks.remove(index).uses)
            .unwrap_or_default();
        window::add(&mut uses, Uses::at(device, 1, now));
        picks.push(Pick {
            key: key.to_owned(),
            uses: window::compact(uses, now),
        });
        let excess = picks.len().saturating_sub(kind.limit);
        picks.drain(..excess);
    }

    pub(crate) fn import(&mut self, kind: &Kind, content: &Value) {
        if self.cached.is_empty() && self.pending.fallback.is_empty() {
            self.pending.fallback = kind.read(content);
        }
    }

    pub(crate) fn seed(&mut self, kind: &Kind, keys: &[String]) {
        for key in keys {
            if (kind.accepts)(key) && !self.pending.seeds.contains(key) {
                self.pending.seeds.push(key.clone());
            }
        }
        self.pending.seeds.truncate(kind.limit);
    }

    /// An older build adds to its list without counting. The first sight of
    /// that list is a migration, and what is new in it later is a fresh pick.
    pub(crate) fn follow(&mut self, kind: &Kind, list: &[String]) {
        match self.seen.replace(list.to_vec()) {
            None => self.seed(kind, list),
            Some(seen) => {
                let arrivals = &mut self.pending.arrivals;
                let new: Vec<String> = list
                    .iter()
                    .filter(|key| (kind.accepts)(key))
                    .filter(|key| !seen.contains(key) && !arrivals.contains(key))
                    .cloned()
                    .collect();
                arrivals.splice(0..0, new);
                arrivals.truncate(kind.limit);
            }
        }
    }

    /// Takes in the server's copy and decides what, if anything, to write.
    pub(crate) fn receive(&mut self, kind: &Kind, remote: Remote, now: u64) -> Option<Value> {
        let Remote {
            content,
            needs_seal,
        } = remote;
        let base = content
            .as_ref()
            .map(|content| kind.read(content))
            .unwrap_or_default();
        if let Some(sent) = self.sent.take()
            && content.is_some()
            && sent.entries == base
        {
            self.pending.remove(&sent.pending);
        }
        if content.is_some() {
            self.pending.fallback.clear();
        }
        self.cached = base;

        let seal = needs_seal && !self.cached.is_empty();
        // Reading alone never writes, nor restores what the server no longer has.
        if self.pending.is_empty() && !seal {
            return None;
        }
        let mut entries = self.entries(kind);
        let unchanged = content.as_ref().map_or(entries.is_empty(), |content| {
            content.get(kind.list).and_then(Value::as_array) == Some(&entries)
        });
        if unchanged && !seal {
            self.cached = entries;
            self.pending = Pending::default();
            return None;
        }
        for entry in &mut entries {
            kind.date(entry, now);
        }
        let mut upload = match content {
            Some(Value::Object(fields)) => fields,
            _ => Map::new(),
        };
        upload.insert(kind.list.to_owned(), entries.clone().into());
        self.sent = Some(Sent {
            entries,
            pending: self.pending.clone(),
        });
        Some(Value::Object(upload))
    }

    pub(crate) fn uploaded(&mut self) {
        if let Some(sent) = self.sent.take() {
            self.pending.remove(&sent.pending);
            self.cached = sent.entries;
        }
    }
}

impl SignedIn {
    /// `change` is durable before the network is touched. Without `sync` it stays on this device.
    pub(crate) async fn update_usage_history(
        &self,
        kind: &Kind,
        sync: bool,
        change: impl FnOnce(&mut History),
    ) -> Result<Vec<Value>, RpcError> {
        // One client throughout, so switching accounts cannot cross their histories.
        let before = self
            .edit_usage_history(kind, |history| {
                let before = history.entries(kind);
                change(history);
                before
            })
            .await?;
        if sync {
            self.sync_usage_history(kind).await?;
        }
        let entries = self
            .edit_usage_history(kind, |history| history.entries(kind))
            .await?;
        if entries != before {
            self.core().emit(CoreEvent::AccountDataChanged {
                event_type: kind.event_type.to_owned(),
            });
        }
        Ok(entries)
    }

    pub(crate) async fn remember_use(
        &self,
        kind: &Kind,
        key: &str,
        sync: bool,
    ) -> Result<(), RpcError> {
        let client = self.client();
        let device = client.device_id().ok_or(RpcCode::Unavailable)?;
        self.update_usage_history(kind, sync, |history| {
            history.pick(kind, key, device.as_str(), crate::now_ms());
        })
        .await
        .map(|_| ())
    }

    async fn edit_usage_history<T>(
        &self,
        kind: &Kind,
        edit: impl FnOnce(&mut History) -> T,
    ) -> Result<T, RpcError> {
        let client = self.client();
        let _guard = self.state().usage_history_writes.lock().await;
        self.core()
            .with_open_stores(async || {
                let stored = client
                    .state_store()
                    .get_custom_value(kind.store_key)
                    .await
                    .or_failed(self.core(), "usage_history")?;
                let mut history = stored
                    .as_deref()
                    .map(|bytes| History::restore(kind, bytes))
                    .unwrap_or_default();
                let result = edit(&mut history);
                let bytes = serde_json::to_vec(&history).or_failed(self.core(), "usage_history")?;
                if stored.as_ref() != Some(&bytes) {
                    client
                        .state_store()
                        .set_custom_value_no_read(kind.store_key, bytes)
                        .await
                        .or_failed(self.core(), "usage_history")?;
                }
                Ok(result)
            })
            .await
    }

    async fn sync_usage_history(&self, kind: &Kind) -> Result<(), RpcError> {
        let client = self.client();
        let _guard = self.state().account_data_writes.lock().await;
        let key = if kind.sealed {
            self.core()
                .with_open_stores(async || cached_key(client).await)
                .await
        } else {
            None
        };
        let content = match read_account_data(client, kind.event_type, true).await {
            Ok(content) => content,
            Err(error) => {
                tracing::debug!("{} could not be read: {error}", kind.event_type);
                return Ok(());
            }
        };
        let remote = match content {
            Some(content) if kind.sealed && is_sealed(&content) => {
                // Writing over what cannot be read would erase the other devices' copy.
                let Some(opened) = key
                    .as_ref()
                    .and_then(|key| key.open(kind.event_type, &content))
                else {
                    return Ok(());
                };
                Remote {
                    content: Some(opened),
                    needs_seal: false,
                }
            }
            content => Remote {
                needs_seal: content.is_some() && key.is_some(),
                content,
            },
        };
        let Some(upload) = self
            .edit_usage_history(kind, |history| {
                history.receive(kind, remote, crate::now_ms())
            })
            .await?
        else {
            return Ok(());
        };
        let upload = match &key {
            Some(key) => key
                .seal(kind.event_type, &upload)
                .or_failed(self.core(), "usage_history_seal")?,
            None => upload,
        };
        let raw = ruma::serde::Raw::new(&upload)
            .or_failed(self.core(), "usage_history")?
            .cast_unchecked();
        if let Err(error) = client
            .account()
            .set_account_data_raw(kind.event_type.into(), raw)
            .await
        {
            tracing::warn!(
                "{} was saved locally but not uploaded: {error}",
                kind.event_type
            );
            return Ok(());
        }
        self.edit_usage_history(kind, History::uploaded).await
    }
}

/// Drops the dates, for tests about order and totals.
#[cfg(test)]
pub(crate) fn undated(mut value: Value) -> Value {
    match &mut value {
        Value::Array(items) => {
            for item in items {
                *item = undated(item.take());
            }
        }
        Value::Object(fields) => {
            fields.remove(window::FIELD);
            for field in fields.values_mut() {
                *field = undated(field.take());
            }
        }
        _ => {}
    }
    value
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    const NOW: u64 = 100 * window::DAY_MS;

    const KIND: Kind = Kind {
        event_type: "org.example.history",
        store_key: b"test",
        list: "list",
        key: "key",
        limit: 3,
        sealed: false,
        accepts: |key| !key.is_empty(),
        identity: str::to_owned,
    };

    #[test]
    fn a_pick_made_during_an_upload_waits_for_the_next_one() {
        let mut history = History::default();
        history.pick(&KIND, "a", "phone", NOW);
        let remote = |content| Remote {
            content,
            needs_seal: false,
        };
        let first = history.receive(&KIND, remote(None), NOW);
        assert_eq!(
            first.clone().map(undated),
            Some(json!({"list": [{"key": "a", "total": 1}]}))
        );
        history.pick(&KIND, "a", "phone", NOW);
        history.uploaded();
        assert_eq!(
            history.receive(&KIND, remote(first), NOW).map(undated),
            Some(json!({"list": [{"key": "a", "total": 2}]}))
        );
    }

    #[test]
    fn what_an_earlier_build_saved_uploads_when_the_server_has_none() {
        let saved = br#"{"list": [{"key": "a", "total": 4}]}"#;
        let mut history = History::restore(&KIND, saved);
        let remote = Remote {
            content: None,
            needs_seal: false,
        };
        assert_eq!(
            history.receive(&KIND, remote, NOW).map(undated),
            Some(json!({"list": [{"key": "a", "total": 4}]}))
        );
    }

    #[test]
    fn the_outbox_stays_as_short_as_the_list() {
        let mut history = History::default();
        for key in ["a", "b", "a", "c", "d", "a"] {
            history.pick(&KIND, key, "phone", NOW);
        }
        assert_eq!(history.pending.picks.len(), 3);
        assert_eq!(
            undated(history.entries(&KIND).into()),
            json!([
                {"key": "a", "total": 3},
                {"key": "d", "total": 1},
                {"key": "c", "total": 1},
            ])
        );
    }

    #[test]
    fn a_pick_that_waited_offline_keeps_the_day_it_was_made() {
        let mut history = History::default();
        history.pick(&KIND, "a", "phone", NOW);
        let later = NOW + 40 * window::DAY_MS;
        let remote = Remote {
            content: None,
            needs_seal: false,
        };
        let upload = history.receive(&KIND, remote, later).unwrap();
        let entries = KIND.read(&upload);
        assert_eq!(
            KIND.frequency(entries.first().unwrap(), later),
            Some(("a", (0, 1)))
        );
    }
}

#[cfg(test)]
#[cfg(not(target_family = "wasm"))]
pub(crate) mod testing {
    use std::sync::Arc;

    use matrix_sdk::test_utils::mocks::MatrixMockServer;
    use matrix_sdk_ui::sync_service::SyncService;
    use serde_json::Value;

    use crate::{Core, session::Session, store::MemorySessionStore};

    pub(crate) async fn signed_in(server: &MatrixMockServer) -> Arc<Core> {
        let client = server.client_builder().build().await;
        signed_in_as(server, client).await
    }

    pub(crate) async fn signed_in_as(
        server: &MatrixMockServer,
        client: matrix_sdk::Client,
    ) -> Arc<Core> {
        let (core, _events) = Core::new("history-test", Box::new(MemorySessionStore::default()));
        crate::test_support::set_session(
            &core,
            Some(Session {
                account_id: "test".into(),
                client: client.clone(),
                sync_service: Arc::new(SyncService::builder(client).build().await.unwrap()),
                homeserver: server.server().uri(),
                oauth: false,
                state: Arc::default(),
            }),
        );
        core
    }

    pub(crate) async fn uploads(server: &MatrixMockServer) -> Vec<Value> {
        let written = written(server).await;
        written.into_iter().map(super::undated).collect()
    }

    /// As sent, dates included.
    pub(crate) async fn written(server: &MatrixMockServer) -> Vec<Value> {
        server
            .server()
            .received_requests()
            .await
            .unwrap()
            .iter()
            .filter(|request| request.method.as_str() == "PUT")
            .map(|request| request.body_json().unwrap())
            .collect()
    }
}
