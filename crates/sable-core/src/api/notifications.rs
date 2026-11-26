use crate::errors::CoreResultExt as _;
use std::sync::Arc;
use std::sync::atomic::Ordering;

use matrix_sdk::ruma::push::{Action, RuleKind};
use matrix_sdk::ruma::{OwnedEventId, OwnedRoomId};
use matrix_sdk_ui::notification_client::NotificationProcessSetup;
use serde::{Deserialize, Serialize};

use super::{Handler, SessionHandler, Json};
use crate::protocol::{RpcCode, RpcError, DefaultNotificationModesView, EventNotificationView, EventNotificationsView, InboxItemView, KeywordNotificationView, MentionNotificationModeView, MentionNotificationsView, MentionRuleView, NotificationModeView, NotificationSettingsView, NotificationView, PushFetchView};
use crate::{Core, ResultExt, notifications, push_rules, SignedIn};

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

impl SessionHandler for SettingsParams {
    type Ok = NotificationSettingsView;

    async fn run(self, session: &SignedIn) -> Result<NotificationSettingsView, RpcError> {
        let room = session.room(&self.room_id)?;
        let rules = session.push_rules().await?.snapshot();

        Ok(push_rules::room_settings(
            &rules,
            &self.room_id,
            notifications::uses_direct_push_rules(&rules, &room),
        ))
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct DefaultModesParams {}

impl SessionHandler for DefaultModesParams {
    type Ok = DefaultNotificationModesView;

    async fn run(self, session: &SignedIn) -> Result<DefaultNotificationModesView, RpcError> {
        Ok(push_rules::default_modes(
            &session.push_rules().await?.snapshot(),
        ))
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct MentionNotificationsParams {}

impl SessionHandler for MentionNotificationsParams {
    type Ok = MentionNotificationsView;

    async fn run(self, session: &SignedIn) -> Result<MentionNotificationsView, RpcError> {
        Ok(push_rules::mention_notifications(
            &session.push_rules().await?.snapshot(),
        ))
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct EventNotificationsParams {}

impl SessionHandler for EventNotificationsParams {
    type Ok = EventNotificationsView;

    async fn run(self, session: &SignedIn) -> Result<EventNotificationsView, RpcError> {
        Ok(push_rules::event_notifications(
            &session.push_rules().await?.snapshot(),
        ))
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct MasterMuteParams {}

impl SessionHandler for MasterMuteParams {
    type Ok = Option<bool>;

    async fn run(self, session: &SignedIn) -> Result<Option<bool>, RpcError> {
        Ok(push_rules::master_muted(
            &session.push_rules().await?.snapshot(),
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

impl SessionHandler for NotificationParams {
    /// `null` when the event notifies nobody, or is gone, or cannot be read.
    type Ok = Option<NotificationView>;

    async fn run(self, session: &SignedIn) -> Result<Option<NotificationView>, RpcError> {
        let client = session.client();
        let setup = NotificationProcessSetup::SingleProcess {
            sync_service: session.sync_service(),
        };

        Ok(notifications::notification(
            client,
            setup,
            &self.room_id,
            &self.event_id,
            &session.core().nicknames(),
        )
        .await)
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

impl SessionHandler for PushEventParams {
    type Ok = PushFetchView;

    async fn run(self, session: &SignedIn) -> Result<PushFetchView, RpcError> {
        let client = session.client();
        let sync_service = session.sync_service();

        Ok(Box::pin(notifications::fetch_push_event(
            client,
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

impl SessionHandler for KeywordsParams {
    type Ok = Vec<KeywordNotificationView>;

    async fn run(self, session: &SignedIn) -> Result<Vec<KeywordNotificationView>, RpcError> {
        Ok(push_rules::keywords(
            &session.push_rules().await?.snapshot(),
        ))
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct AddKeywordParams {
    pub keyword: String,
}

impl SessionHandler for AddKeywordParams {
    type Ok = ();

    async fn run(self, session: &SignedIn) -> Result<(), RpcError> {
        let rules = session.push_rules().await?;
        let writes = push_rules::plan_add_keyword(&rules.snapshot(), &self.keyword)
            .or_report(session.core(), "add_notification_keyword")?;
        rules
            .apply(writes)
            .await
            .or_report(session.core(), "add_notification_keyword")?;

        Ok(())
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct RemoveKeywordParams {
    pub keyword: String,
}

impl SessionHandler for RemoveKeywordParams {
    type Ok = ();

    async fn run(self, session: &SignedIn) -> Result<(), RpcError> {
        let rules = session.push_rules().await?;
        rules
            .apply(push_rules::plan_remove_keyword(
                &rules.snapshot(),
                &self.keyword,
            ))
            .await
            .or_report(session.core(), "remove_notification_keyword")?;

        Ok(())
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct SetKeywordModeParams {
    pub keyword: String,
    pub mode: MentionNotificationModeView,
}

impl SessionHandler for SetKeywordModeParams {
    type Ok = ();

    async fn run(self, session: &SignedIn) -> Result<(), RpcError> {
        let rules = session.push_rules().await?;
        rules
            .apply(push_rules::plan_keyword_mode(
                &rules.snapshot(),
                &self.keyword,
                self.mode,
            ))
            .await
            .or_report(session.core(), "set_notification_keyword_mode")?;

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

impl SessionHandler for SetRoomNotificationModeParams {
    type Ok = ();

    async fn run(self, session: &SignedIn) -> Result<(), RpcError> {
        let rooms = SetRoomsNotificationModeParams {
            room_ids: vec![self.room_id],
            mode: self.mode,
        };
        SessionHandler::run(rooms, session).await
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

impl SessionHandler for SetRoomsNotificationModeParams {
    type Ok = ();

    async fn run(self, session: &SignedIn) -> Result<(), RpcError> {
        let rules = session.push_rules().await?;
        let mut writes = Vec::new();
        for room_id in &self.room_ids {
            session.room(room_id)?;
            writes.extend(push_rules::plan_room_mode(room_id, self.mode));
        }
        if self.mode == Some(NotificationModeView::All) {
            writes.extend(push_rules::plan_suppressions(&rules.snapshot()));
        }
        rules
            .apply(writes)
            .await
            .or_report(session.core(), "set_rooms_notification_mode")?;

        Ok(())
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct SetDefaultModeParams {
    pub direct: bool,
    pub mode: NotificationModeView,
}

impl SessionHandler for SetDefaultModeParams {
    type Ok = ();

    async fn run(self, session: &SignedIn) -> Result<(), RpcError> {
        let rules = session.push_rules().await?;
        let before = rules.snapshot();
        let writes = push_rules::plan_default_mode(&before, self.direct, self.mode)
            .or_report(session.core(), "set_default_notification_mode")?;
        rules
            .apply(writes)
            .await
            .or_report(session.core(), "set_default_notification_mode")?;

        Ok(())
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct SetMentionNotificationsParams {
    pub rule: MentionRuleView,
    pub mode: MentionNotificationModeView,
}

impl SessionHandler for SetMentionNotificationsParams {
    type Ok = ();

    async fn run(self, session: &SignedIn) -> Result<(), RpcError> {
        let rules = session.push_rules().await?;
        let writes = push_rules::plan_mention(&rules.snapshot(), self.rule, self.mode)
            .or_report(session.core(), "set_mention_notifications")?;
        rules
            .apply(writes)
            .await
            .or_report(session.core(), "set_mention_notifications")?;

        Ok(())
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct SetEventNotificationParams {
    pub event: EventNotificationView,
    pub enabled: bool,
}

impl SessionHandler for SetEventNotificationParams {
    type Ok = ();

    async fn run(self, session: &SignedIn) -> Result<(), RpcError> {
        let client = session.client();
        let user_id = client.user_id().ok_or(RpcCode::NotLoggedIn)?;
        let rules = session.push_rules().await?;
        let writes =
            push_rules::plan_event(&rules.snapshot(), self.event, self.enabled, user_id)
                .or_report(session.core(), "set_event_notification")?;
        rules
            .apply(writes)
            .await
            .or_report(session.core(), "set_event_notification")?;

        Ok(())
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct SetMasterMuteParams {
    pub muted: bool,
}

impl SessionHandler for SetMasterMuteParams {
    type Ok = ();

    async fn run(self, session: &SignedIn) -> Result<(), RpcError> {
        session.push_rules()
            .await?
            .apply(push_rules::plan_master(self.muted))
            .await
            .or_report(session.core(), "set_master_mute")?;

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

impl SessionHandler for InboxParams {
    type Ok = InboxOk;

    async fn run(self, session: &SignedIn) -> Result<InboxOk, RpcError> {
        let (items, has_more) = session
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
        let nicknames = session.core().nicknames();
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

impl SessionHandler for BackfillInboxParams {
    type Ok = BackfillInboxOk;
    const ENDS_WITH_SESSION: bool = true;

    async fn run(self, session: &SignedIn) -> Result<BackfillInboxOk, RpcError> {
        let (recorded, has_more) = session
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
    pub in_app_banners: bool,
}

impl Handler for SetOptionsParams {
    type Ok = ();

    fn run(self, core: &Arc<Core>) -> impl Future<Output = Result<(), RpcError>> {
        core.settings.notifications_enabled
            .store(self.enabled, Ordering::Relaxed);
        core.settings.notification_content
            .store(self.content, Ordering::Relaxed);
        core.settings.notification_encrypted_content
            .store(self.encrypted_content, Ordering::Relaxed);
        core.settings.notification_sounds
            .store(self.sounds, Ordering::Relaxed);
        core.settings.notify_once.store(self.notify_once, Ordering::Relaxed);
        core.settings.in_app_banners
            .store(self.in_app_banners, Ordering::Relaxed);

        std::future::ready(Ok(()))
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct PushRulesParams {}

impl SessionHandler for PushRulesParams {
    type Ok = Json;

    async fn run(self, session: &SignedIn) -> Result<Json, RpcError> {
        let rules = session.push_rules().await?.snapshot();
        serde_json::to_value(rules)
            .map(Json)
            .or_failed(session.core(), "push_rules")
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

impl SessionHandler for SetPushRuleEnabledParams {
    type Ok = ();

    async fn run(self, session: &SignedIn) -> Result<(), RpcError> {
        session.push_rules()
            .await?
            .apply(vec![push_rules::RuleWrite::Enabled {
                kind: self.kind,
                rule_id: self.rule_id,
                enabled: self.enabled,
            }])
            .await
            .or_report(session.core(), "set_push_rule_enabled")
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

impl SessionHandler for SetPushRuleActionsParams {
    type Ok = ();

    async fn run(self, session: &SignedIn) -> Result<(), RpcError> {
        session.push_rules()
            .await?
            .apply(vec![push_rules::RuleWrite::Actions {
                kind: self.kind,
                rule_id: self.rule_id,
                actions: self.actions,
            }])
            .await
            .or_report(session.core(), "set_push_rule_actions")
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

impl SessionHandler for AddPushRuleParams {
    type Ok = ();

    async fn run(self, session: &SignedIn) -> Result<(), RpcError> {
        let rule = push_rules::new_rule(&self.kind, self.rule).or_failed(session.core(), "add_push_rule")?;
        session.push_rules()
            .await?
            .apply(vec![push_rules::RuleWrite::Put(rule)])
            .await
            .or_report(session.core(), "add_push_rule")
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct DeletePushRuleParams {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub kind: RuleKind,
    pub rule_id: String,
}

impl SessionHandler for DeletePushRuleParams {
    type Ok = ();

    async fn run(self, session: &SignedIn) -> Result<(), RpcError> {
        session.push_rules()
            .await?
            .apply(vec![push_rules::RuleWrite::Delete {
                kind: self.kind,
                rule_id: self.rule_id,
            }])
            .await
            .or_report(session.core(), "delete_push_rule")
    }
}
