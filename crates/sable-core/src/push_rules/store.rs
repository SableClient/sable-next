use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;

use matrix_sdk::Client;
use matrix_sdk::event_handler::EventHandlerDropGuard;
use matrix_sdk::ruma::api::client::push::{
    delete_pushrule, get_pushrules_all, set_pushrule, set_pushrule_actions, set_pushrule_enabled,
};
use matrix_sdk::ruma::api::error::ErrorKind;
use matrix_sdk::ruma::events::{AnyGlobalAccountDataEvent, direct::DirectEventContent};
use matrix_sdk::ruma::push::{Action, NewPushRule, RuleKind, Ruleset};
use matrix_sdk::ruma::serde::Raw;
use tokio::sync::{Mutex, RwLock, broadcast};

use super::direct::{self, DirectDefault};
use super::pushes_every_encrypted_event;
use crate::errors::{CoreError, ReportExt};
use crate::protocol::NotificationModeView;

pub struct PushRules {
    client: Client,
    rules: Arc<RwLock<Ruleset>>,
    write_lock: Mutex<()>,
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
            move |event: AnyGlobalAccountDataEvent| {
                let rules = rules.clone();
                let changes = changes.clone();
                async move {
                    match event {
                        AnyGlobalAccountDataEvent::PushRules(event) => {
                            *rules.write().await = event.content.global;
                        }
                        AnyGlobalAccountDataEvent::Direct(_) => {}
                        event if event.event_type().to_string() == direct::DEFAULT_EVENT => {}
                        _ => return,
                    }
                    let _ = changes.send(());
                }
            }
        });

        Arc::new(Self {
            client: client.clone(),
            rules,
            write_lock: Mutex::new(()),
            changes,
            _handler: client.event_handler_drop_guard(handle),
        })
    }

    pub async fn snapshot(&self) -> Ruleset {
        self.rules.read().await.clone()
    }

    async fn fetch_direct_default(&self) -> Result<Option<DirectDefault>, CoreError> {
        self.client
            .account()
            .fetch_account_data(direct::DEFAULT_EVENT.into())
            .await
            .backend()?
            .map(|raw| raw.deserialize_as_unchecked::<DirectDefault>().backend())
            .transpose()
    }

    async fn save_direct_default(&self, preference: &DirectDefault) -> Result<(), CoreError> {
        self.client
            .account()
            .set_account_data_raw(
                direct::DEFAULT_EVENT.into(),
                Raw::new(preference).backend()?.cast_unchecked(),
            )
            .await
            .backend()?;
        let _ = self.changes.send(());
        Ok(())
    }

    async fn refresh(&self) -> Result<Ruleset, CoreError> {
        let rules = self
            .client
            .send(get_pushrules_all::v3::Request::new())
            .await
            .backend()?
            .global;
        *self.rules.write().await = rules.clone();
        Ok(rules)
    }

    pub(crate) async fn set_direct_default(
        &self,
        mode: NotificationModeView,
    ) -> Result<(), CoreError> {
        let _guard = self.write_lock.lock().await;
        let mode = if mode == NotificationModeView::Mute {
            NotificationModeView::Mentions
        } else {
            mode
        };
        let before = self.refresh().await?;
        super::plan_default_mode(&before, true, mode)?;
        let mut preference = self
            .fetch_direct_default()
            .await?
            .unwrap_or_else(|| DirectDefault {
                mode,
                pending_one_to_one: false,
                managed: BTreeMap::new(),
            });
        preference.mode = mode;
        preference.pending_one_to_one = true;
        self.save_direct_default(&preference).await?;
        self.reconcile_direct(&preference, &before).await
    }

    pub(crate) async fn reconcile_direct_default(&self) -> Result<(), CoreError> {
        let _guard = self.write_lock.lock().await;
        let rules = self.refresh().await?;
        let mut preference = self
            .fetch_direct_default()
            .await?
            .unwrap_or_else(|| DirectDefault {
                mode: super::default_mode(&rules, true),
                pending_one_to_one: false,
                managed: BTreeMap::new(),
            });
        if !preference.pending_one_to_one {
            preference.mode = super::default_mode(&rules, true);
        }
        self.reconcile_direct(&preference, &rules).await
    }

    async fn reconcile_direct(
        &self,
        preference: &DirectDefault,
        rules: &Ruleset,
    ) -> Result<(), CoreError> {
        let rooms: BTreeSet<_> = self
            .client
            .account()
            .fetch_account_data_static::<DirectEventContent>()
            .await
            .backend()?
            .map(|raw| raw.deserialize().backend())
            .transpose()?
            .unwrap_or_default()
            .values()
            .flatten()
            .cloned()
            .collect();
        let mut preference = preference.clone();
        if preference.pending_one_to_one {
            self.apply_locked(super::plan_default_mode(rules, true, preference.mode)?)
                .await?;
            preference.pending_one_to_one = false;
            self.save_direct_default(&preference).await?;
        }
        let (writes, pending, next) = direct::plan(&self.snapshot().await, &preference, &rooms);
        let changed = !writes.is_empty();
        if changed && pending != preference {
            // Record both rule definitions before sending so a partial write can be retried.
            self.save_direct_default(&pending).await?;
        }
        self.apply_locked(writes).await?;
        if changed || next != preference {
            self.save_direct_default(&next).await?;
        }
        Ok(())
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
        let _guard = self.write_lock.lock().await;
        self.apply_locked(writes).await
    }

    async fn apply_locked(&self, writes: Vec<RuleWrite>) -> Result<(), CoreError> {
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
        sent.backend()
    }
}

#[derive(Debug, Clone)]
pub enum RuleWrite {
    Put(NewPushRule),
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
