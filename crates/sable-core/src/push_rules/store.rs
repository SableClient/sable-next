use std::sync::Arc;

use matrix_sdk::Client;
use matrix_sdk::event_handler::EventHandlerDropGuard;
use matrix_sdk::ruma::api::client::push::{
    delete_pushrule, set_pushrule, set_pushrule_actions, set_pushrule_enabled,
};
use matrix_sdk::ruma::api::error::ErrorKind;
use matrix_sdk::ruma::events::push_rules::PushRulesEvent;
use matrix_sdk::ruma::push::{Action, NewPushRule, RuleKind, Ruleset};
use tokio::sync::{RwLock, broadcast};

use super::pushes_every_encrypted_event;
use crate::errors::CoreError;

pub struct PushRules {
    client: Client,
    rules: Arc<RwLock<Ruleset>>,
    changes: broadcast::Sender<()>,
    _handler: EventHandlerDropGuard,
}

impl PushRules {
    #[cfg_attr(
        target_family = "wasm",
        expect(
            clippy::arc_with_non_send_sync,
            reason = "the WASM core is single-threaded"
        )
    )]
    pub async fn load(client: &Client) -> Arc<Self> {
        let initial = client
            .account()
            .push_rules()
            .await
            .unwrap_or_else(|_| Ruleset::new());
        let rules = Arc::new(RwLock::new(initial));
        let changes = broadcast::Sender::new(16);
        let handle = client.add_event_handler({
            let rules = rules.clone();
            let changes = changes.clone();
            move |event: PushRulesEvent| {
                let rules = rules.clone();
                let changes = changes.clone();
                async move {
                    *rules.write().await = event.content.global;
                    let _ = changes.send(());
                }
            }
        });

        Arc::new(Self {
            client: client.clone(),
            rules,
            changes,
            _handler: client.event_handler_drop_guard(handle),
        })
    }

    pub async fn snapshot(&self) -> Ruleset {
        self.rules.read().await.clone()
    }

    pub async fn pushes_every_encrypted_event(&self) -> bool {
        pushes_every_encrypted_event(&*self.rules.read().await)
    }

    #[must_use]
    pub fn subscribe(&self) -> broadcast::Receiver<()> {
        self.changes.subscribe()
    }

    /// # Errors
    ///
    /// When the server rejects a write.
    pub async fn apply(&self, writes: Vec<RuleWrite>) -> Result<(), CoreError> {
        let planned = writes.len();
        let mut result = Ok(());
        let mut applied = 0_usize;
        for write in writes {
            if let Err(error) = self.send(&write).await {
                result = Err(error);
                break;
            }
            write.apply_to(&mut *self.rules.write().await);
            applied += 1;
        }
        if applied > 0 {
            let _ = self.changes.send(());
        }
        match &result {
            Ok(()) if planned > 0 => tracing::info!(planned, "push rule changes applied"),
            Ok(()) => {}
            Err(error) => tracing::warn!(planned, applied, %error, "push rule changes failed"),
        }
        result
    }

    async fn send(&self, write: &RuleWrite) -> Result<(), CoreError> {
        let sent = match write.clone() {
            RuleWrite::Put(rule) => self
                .client
                .send(set_pushrule::v3::Request::new(rule))
                .await
                .map(|_| ()),
            RuleWrite::PutAfter { rule, after } => {
                let mut request = set_pushrule::v3::Request::new(rule);
                request.after = Some(after);
                self.client.send(request).await.map(|_| ())
            }
            RuleWrite::Actions {
                kind,
                rule_id,
                actions,
            } => self
                .client
                .send(set_pushrule_actions::v3::Request::new(
                    kind, rule_id, actions,
                ))
                .await
                .map(|_| ()),
            RuleWrite::Enabled {
                kind,
                rule_id,
                enabled,
            } => self
                .client
                .send(set_pushrule_enabled::v3::Request::new(
                    kind, rule_id, enabled,
                ))
                .await
                .map(|_| ()),
            RuleWrite::Delete { kind, rule_id } => {
                match self
                    .client
                    .send(delete_pushrule::v3::Request::new(kind, rule_id))
                    .await
                {
                    Err(error) if error.client_api_error_kind() == Some(&ErrorKind::NotFound) => {
                        Ok(())
                    }
                    other => other.map(|_| ()),
                }
            }
        };
        sent.map_err(CoreError::backend)
    }
}

#[derive(Debug, Clone)]
pub enum RuleWrite {
    Put(NewPushRule),
    PutAfter {
        rule: NewPushRule,
        after: String,
    },
    Actions {
        kind: RuleKind,
        rule_id: String,
        actions: Vec<Action>,
    },
    Enabled {
        kind: RuleKind,
        rule_id: String,
        enabled: bool,
    },
    Delete {
        kind: RuleKind,
        rule_id: String,
    },
}

impl RuleWrite {
    /// The next `m.push_rules` sync replaces the whole ruleset, so a write the
    /// local copy rejects is only stale until then.
    pub(super) fn apply_to(self, rules: &mut Ruleset) {
        let result = match self {
            Self::Put(rule) => rules.insert(rule, None, None).map_err(|e| e.to_string()),
            Self::PutAfter { rule, after } => rules
                .insert(rule, Some(&after), None)
                .map_err(|e| e.to_string()),
            Self::Actions {
                kind,
                rule_id,
                actions,
            } => rules
                .set_actions(kind, rule_id, actions)
                .map_err(|e| e.to_string()),
            Self::Enabled {
                kind,
                rule_id,
                enabled,
            } => rules
                .set_enabled(kind, rule_id, enabled)
                .map_err(|e| e.to_string()),
            Self::Delete { kind, rule_id } => {
                rules.remove(kind, rule_id).map_err(|e| e.to_string())
            }
        };
        if let Err(error) = result {
            tracing::warn!(%error, "push rule write not applied to the local copy");
        }
    }
}
