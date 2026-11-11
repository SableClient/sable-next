use crate::errors::CoreResultExt as _;
use std::sync::Arc;
use std::sync::atomic::Ordering;

use matrix_sdk::ruma::push::{Action, RuleKind};
use matrix_sdk::ruma::{OwnedEventId, OwnedRoomId};
use matrix_sdk_ui::notification_client::NotificationProcessSetup;
use serde::{Deserialize, Serialize};

use super::{Handler, Json};
use crate::protocol::{RpcCode, RpcError, DefaultNotificationModesView, EventNotificationView, EventNotificationsView, InboxItemView, KeywordNotificationView, MentionNotificationModeView, MentionNotificationsView, MentionRuleView, NotificationModeView, NotificationSettingsView, NotificationView, PushFetchView};
use crate::{Core, ResultExt, notifications, push_rules};

domain! {
    settings,
    default_modes,
    mention_notifications,
    event_notifications,
    master_mute,
    notification,
    push_event,
    keywords,
    add_keyword,
    remove_keyword,
    set_keyword_mode,
    set_room_notification_mode,
    set_rooms_notification_mode,
    set_default_mode,
    set_mention_notifications,
    set_event_notification,
    set_master_mute,
    inbox,
    backfill_inbox,
    set_options,
    push_rules,
    set_push_rule_enabled,
    set_push_rule_actions,
    add_push_rule,
    delete_push_rule,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
#[serde(rename_all = "snake_case")]
pub enum InboxFilter {
    All,
    Mentions,
    Direct,
    Threads,
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct SettingsParams {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub room_id: OwnedRoomId,
}

impl Handler for SettingsParams {
    type Ok = NotificationSettingsView;

    async fn run(self, core: &Arc<Core>) -> Result<NotificationSettingsView, RpcError> {
        let room = core.room(&self.room_id).await?;
        let rules = core.push_rules().await?.snapshot().await;

        Ok(push_rules::room_settings(
            &rules,
            &self.room_id,
            notifications::uses_direct_push_rules(&room),
        ))
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct DefaultModesParams {}

impl Handler for DefaultModesParams {
    type Ok = DefaultNotificationModesView;

    async fn run(self, core: &Arc<Core>) -> Result<DefaultNotificationModesView, RpcError> {
        Ok(push_rules::default_modes(
            &core.push_rules().await?.snapshot().await,
        ))
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct MentionNotificationsParams {}

impl Handler for MentionNotificationsParams {
    type Ok = MentionNotificationsView;

    async fn run(self, core: &Arc<Core>) -> Result<MentionNotificationsView, RpcError> {
        Ok(push_rules::mention_notifications(
            &core.push_rules().await?.snapshot().await,
        ))
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct EventNotificationsParams {}

impl Handler for EventNotificationsParams {
    type Ok = EventNotificationsView;

    async fn run(self, core: &Arc<Core>) -> Result<EventNotificationsView, RpcError> {
        Ok(push_rules::event_notifications(
            &core.push_rules().await?.snapshot().await,
        ))
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct MasterMuteParams {}

impl Handler for MasterMuteParams {
    type Ok = Option<bool>;

    async fn run(self, core: &Arc<Core>) -> Result<Option<bool>, RpcError> {
        Ok(push_rules::master_muted(
            &core.push_rules().await?.snapshot().await,
        ))
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct NotificationParams {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub room_id: OwnedRoomId,
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub event_id: OwnedEventId,
}

impl Handler for NotificationParams {
    /// `null` when the event notifies nobody, or is gone, or cannot be read.
    type Ok = Option<NotificationView>;

    async fn run(self, core: &Arc<Core>) -> Result<Option<NotificationView>, RpcError> {
        let client = core.client().await?;
        let setup = NotificationProcessSetup::SingleProcess {
            sync_service: core.sync_service().await?,
        };

        let mut notification =
            notifications::notification(&client, setup, &self.room_id, &self.event_id).await;
        if let Some(notification) = notification.as_mut() {
            core.nicknames().apply_notification(notification);
        }
        Ok(notification)
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct PushEventParams {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub room_id: OwnedRoomId,
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub event_id: OwnedEventId,
}

impl Handler for PushEventParams {
    type Ok = PushFetchView;

    async fn run(self, core: &Arc<Core>) -> Result<PushFetchView, RpcError> {
        let client = core.client().await?;
        let sync_service = core.sync_service().await?;

        Ok(Box::pin(notifications::fetch_push_event(
            &client,
            sync_service,
            &self.room_id,
            &self.event_id,
        ))
        .await)
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct KeywordsParams {}

impl Handler for KeywordsParams {
    type Ok = Vec<KeywordNotificationView>;

    async fn run(self, core: &Arc<Core>) -> Result<Vec<KeywordNotificationView>, RpcError> {
        Ok(push_rules::keywords(
            &core.push_rules().await?.snapshot().await,
        ))
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct AddKeywordParams {
    pub keyword: String,
}

impl Handler for AddKeywordParams {
    type Ok = ();

    async fn run(self, core: &Arc<Core>) -> Result<(), RpcError> {
        let rules = core.push_rules().await?;
        let writes = push_rules::plan_add_keyword(&rules.snapshot().await, &self.keyword)
            .or_report(core, "add_notification_keyword")?;
        rules
            .apply(writes)
            .await
            .or_report(core, "add_notification_keyword")?;

        Ok(())
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct RemoveKeywordParams {
    pub keyword: String,
}

impl Handler for RemoveKeywordParams {
    type Ok = ();

    async fn run(self, core: &Arc<Core>) -> Result<(), RpcError> {
        let rules = core.push_rules().await?;
        rules
            .apply(push_rules::plan_remove_keyword(
                &rules.snapshot().await,
                &self.keyword,
            ))
            .await
            .or_report(core, "remove_notification_keyword")?;

        Ok(())
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct SetKeywordModeParams {
    pub keyword: String,
    pub mode: MentionNotificationModeView,
}

impl Handler for SetKeywordModeParams {
    type Ok = ();

    async fn run(self, core: &Arc<Core>) -> Result<(), RpcError> {
        let rules = core.push_rules().await?;
        rules
            .apply(push_rules::plan_keyword_mode(
                &rules.snapshot().await,
                &self.keyword,
                self.mode,
            ))
            .await
            .or_report(core, "set_notification_keyword_mode")?;

        Ok(())
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct SetRoomNotificationModeParams {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub room_id: OwnedRoomId,
    /// `null` drops the room's own rules so it follows the default again.
    #[serde(default)]
    pub mode: Option<NotificationModeView>,
}

impl Handler for SetRoomNotificationModeParams {
    type Ok = ();

    async fn run(self, core: &Arc<Core>) -> Result<(), RpcError> {
        SetRoomsNotificationModeParams {
            room_ids: vec![self.room_id],
            mode: self.mode,
        }
        .run(core)
        .await
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct SetRoomsNotificationModeParams {
    #[cfg_attr(feature = "typegen", specta(type = Vec<String>))]
    pub room_ids: Vec<OwnedRoomId>,
    #[serde(default)]
    pub mode: Option<NotificationModeView>,
}

impl Handler for SetRoomsNotificationModeParams {
    type Ok = ();

    async fn run(self, core: &Arc<Core>) -> Result<(), RpcError> {
        let rules = core.push_rules().await?;
        let mut writes = Vec::new();
        for room_id in &self.room_ids {
            let room = core.room(room_id).await?;
            let direct = notifications::uses_direct_push_rules(&room);
            writes.extend(push_rules::plan_room_mode(room_id, direct, self.mode));
        }
        rules
            .apply(writes)
            .await
            .or_report(core, "set_rooms_notification_mode")?;

        Ok(())
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct SetDefaultModeParams {
    pub direct: bool,
    pub mode: NotificationModeView,
}

impl Handler for SetDefaultModeParams {
    type Ok = ();

    async fn run(self, core: &Arc<Core>) -> Result<(), RpcError> {
        let rules = core.push_rules().await?;
        if self.direct {
            return rules
                .set_direct_default(self.mode)
                .await
                .or_report(core, "set_default_notification_mode");
        }
        let before = rules.snapshot().await;
        let writes = push_rules::plan_default_mode(&before, self.direct, self.mode)
            .or_report(core, "set_default_notification_mode")?;
        rules
            .apply(writes)
            .await
            .or_report(core, "set_default_notification_mode")?;

        Ok(())
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct SetMentionNotificationsParams {
    pub rule: MentionRuleView,
    pub mode: MentionNotificationModeView,
}

impl Handler for SetMentionNotificationsParams {
    type Ok = ();

    async fn run(self, core: &Arc<Core>) -> Result<(), RpcError> {
        let rules = core.push_rules().await?;
        let writes = push_rules::plan_mention(&rules.snapshot().await, self.rule, self.mode)
            .or_report(core, "set_mention_notifications")?;
        rules
            .apply(writes)
            .await
            .or_report(core, "set_mention_notifications")?;

        Ok(())
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct SetEventNotificationParams {
    pub event: EventNotificationView,
    pub enabled: bool,
}

impl Handler for SetEventNotificationParams {
    type Ok = ();

    async fn run(self, core: &Arc<Core>) -> Result<(), RpcError> {
        let client = core.client().await?;
        let user_id = client.user_id().ok_or(RpcCode::NotLoggedIn)?;
        let rules = core.push_rules().await?;
        let writes =
            push_rules::plan_event(&rules.snapshot().await, self.event, self.enabled, user_id)
                .or_report(core, "set_event_notification")?;
        rules
            .apply(writes)
            .await
            .or_report(core, "set_event_notification")?;

        Ok(())
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct SetMasterMuteParams {
    pub muted: bool,
}

impl Handler for SetMasterMuteParams {
    type Ok = ();

    async fn run(self, core: &Arc<Core>) -> Result<(), RpcError> {
        core.push_rules()
            .await?
            .apply(push_rules::plan_master(self.muted))
            .await
            .or_report(core, "set_master_mute")?;

        Ok(())
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct InboxParams {
    pub filter: InboxFilter,
    pub include_read: bool,
    pub limit: u32,
    #[cfg_attr(feature = "typegen", specta(type = Option<specta_typescript::Number>))]
    #[serde(default)]
    pub before_ts: Option<u64>,
    #[cfg_attr(feature = "typegen", specta(type = Option<String>))]
    #[serde(default)]
    pub room_id: Option<OwnedRoomId>,
    #[serde(default)]
    pub query: Option<String>,
}

#[derive(Debug, Serialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct InboxOk {
    pub items: Vec<InboxItemView>,
    pub has_more: bool,
}

impl Handler for InboxParams {
    type Ok = InboxOk;

    async fn run(self, core: &Arc<Core>) -> Result<InboxOk, RpcError> {
        let (items, has_more) = core
            .inbox_notifications(
                self.filter,
                self.include_read,
                self.limit,
                self.before_ts,
                crate::inbox::InboxScope {
                    room_id: self.room_id.as_deref(),
                    query: self.query.as_deref(),
                },
            )
            .await?;
        let nicknames = core.nicknames();
        let items = items
            .into_iter()
            .map(|mut item| {
                nicknames.apply_inbox(&mut item);
                item
            })
            .collect();
        Ok(InboxOk { items, has_more })
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct BackfillInboxParams {
    pub include_read: bool,
    #[cfg_attr(feature = "typegen", specta(type = Option<String>))]
    #[serde(default)]
    pub room_id: Option<OwnedRoomId>,
}

#[derive(Debug, Serialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct BackfillInboxOk {
    pub recorded: u32,
    pub has_more: bool,
}

impl Handler for BackfillInboxParams {
    type Ok = BackfillInboxOk;

    async fn run(self, core: &Arc<Core>) -> Result<BackfillInboxOk, RpcError> {
        let (recorded, has_more) = core
            .backfill_inbox(self.include_read, self.room_id.as_deref())
            .await?;
        Ok(BackfillInboxOk { recorded, has_more })
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
#[expect(
    clippy::struct_excessive_bools,
    reason = "wire type mirroring the notification preferences"
)]
pub struct SetOptionsParams {
    pub enabled: bool,
    pub content: bool,
    pub encrypted_content: bool,
    pub sounds: bool,
    pub notify_once: bool,
}

impl Handler for SetOptionsParams {
    type Ok = ();

    fn run(self, core: &Arc<Core>) -> impl Future<Output = Result<(), RpcError>> {
        core.notifications_enabled
            .store(self.enabled, Ordering::Relaxed);
        core.notification_content
            .store(self.content, Ordering::Relaxed);
        core.notification_encrypted_content
            .store(self.encrypted_content, Ordering::Relaxed);
        core.notification_sounds
            .store(self.sounds, Ordering::Relaxed);
        core.notify_once.store(self.notify_once, Ordering::Relaxed);

        std::future::ready(Ok(()))
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct PushRulesParams {}

impl Handler for PushRulesParams {
    type Ok = Json;

    async fn run(self, core: &Arc<Core>) -> Result<Json, RpcError> {
        let rules = core.push_rules().await?.snapshot().await;
        serde_json::to_value(rules)
            .map(Json)
            .or_failed(core, "push_rules")
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct SetPushRuleEnabledParams {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub kind: RuleKind,
    pub rule_id: String,
    pub enabled: bool,
}

impl Handler for SetPushRuleEnabledParams {
    type Ok = ();

    async fn run(self, core: &Arc<Core>) -> Result<(), RpcError> {
        core.push_rules()
            .await?
            .apply(vec![push_rules::RuleWrite::Enabled {
                kind: self.kind,
                rule_id: self.rule_id,
                enabled: self.enabled,
            }])
            .await
            .or_report(core, "set_push_rule_enabled")
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct SetPushRuleActionsParams {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub kind: RuleKind,
    pub rule_id: String,
    #[cfg_attr(feature = "typegen", specta(type = Vec<specta_typescript::Unknown>))]
    pub actions: Vec<Action>,
}

impl Handler for SetPushRuleActionsParams {
    type Ok = ();

    async fn run(self, core: &Arc<Core>) -> Result<(), RpcError> {
        core.push_rules()
            .await?
            .apply(vec![push_rules::RuleWrite::Actions {
                kind: self.kind,
                rule_id: self.rule_id,
                actions: self.actions,
            }])
            .await
            .or_report(core, "set_push_rule_actions")
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct AddPushRuleParams {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub kind: RuleKind,
    #[cfg_attr(feature = "typegen", specta(type = specta_typescript::Unknown))]
    pub rule: serde_json::Value,
}

impl Handler for AddPushRuleParams {
    type Ok = ();

    async fn run(self, core: &Arc<Core>) -> Result<(), RpcError> {
        let rule = push_rules::new_rule(&self.kind, self.rule).or_failed(core, "add_push_rule")?;
        core.push_rules()
            .await?
            .apply(vec![push_rules::RuleWrite::Put(rule)])
            .await
            .or_report(core, "add_push_rule")
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct DeletePushRuleParams {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub kind: RuleKind,
    pub rule_id: String,
}

impl Handler for DeletePushRuleParams {
    type Ok = ();

    async fn run(self, core: &Arc<Core>) -> Result<(), RpcError> {
        core.push_rules()
            .await?
            .apply(vec![push_rules::RuleWrite::Delete {
                kind: self.kind,
                rule_id: self.rule_id,
            }])
            .await
            .or_report(core, "delete_push_rule")
    }
}
