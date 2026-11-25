use sable_model::emote_picker::{
    FREQUENT_REACTIONS, most_used, reaction_identity, rememberable_reaction,
};
use serde_json::Value;

use crate::SignedIn;
use crate::protocol::RpcError;
use crate::usage_history::Kind;

/// MSC4356, which leaves ranking to each client.
const EMOJI: Kind = Kind {
    event_type: "m.recent_emoji",
    store_key: b"sable.reaction_history",
    list: "recent_emoji",
    key: "emoji",
    limit: 100,
    sealed: false,
    accepts: rememberable_reaction,
    identity: reaction_identity,
};

fn frequent_keys(entries: &[Value], now: u64) -> Vec<String> {
    let mut recent: Vec<(String, String, (u64, u64))> = Vec::new();
    for (key, (uses, total)) in entries
        .iter()
        .filter_map(|entry| EMOJI.frequency(entry, now))
    {
        if !rememberable_reaction(key) {
            continue;
        }
        let id = reaction_identity(key);
        if let Some((_, _, sum)) = recent.iter_mut().find(|(seen, _, _)| *seen == id) {
            *sum = (sum.0.saturating_add(uses), sum.1.saturating_add(total));
        } else {
            recent.push((id, key.to_owned(), (uses, total)));
        }
    }
    let recent = recent
        .into_iter()
        .map(|(_, key, uses)| (key, uses))
        .collect();
    most_used(recent, FREQUENT_REACTIONS)
}

impl SignedIn {
    pub(crate) async fn frequent_reactions(
        &self,
        legacy: Option<Value>,
        recent: &[String],
    ) -> Result<Vec<String>, RpcError> {
        let entries = self
            .update_usage_history(&EMOJI, true, |history| {
                if let Some(legacy) = &legacy {
                    history.import(&EMOJI, legacy);
                }
                history.seed(&EMOJI, recent);
            })
            .await?;
        Ok(frequent_keys(&entries, crate::now_ms()))
    }

    pub(crate) async fn remember_reaction(&self, key: &str) -> Result<(), RpcError> {
        self.remember_use(&EMOJI, key, true).await
    }
}

#[cfg(test)]
#[path = "reaction_history_tests.rs"]
mod tests;
