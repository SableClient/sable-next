use matrix_sdk::Client;
use matrix_sdk::notification_settings::{IsEncrypted, IsOneToOne, RoomNotificationMode};
use matrix_sdk::ruma::api::client::push::{
    PusherIds, PusherInit, PusherKind, delete_pushrule, set_pushrule,
};
use matrix_sdk::ruma::events::AnySyncMessageLikeEvent;
use matrix_sdk::ruma::events::AnySyncTimelineEvent;
use matrix_sdk::ruma::events::room::message::{MessageType, RoomMessageEventContent};
use matrix_sdk::ruma::power_levels::NotificationPowerLevelsKey;
use matrix_sdk::ruma::push::{
    Action, EventMatchConditionData, EventPropertyContainsConditionData,
    EventPropertyIsConditionData, HighlightTweakValue, HttpPusherData, NewConditionalPushRule,
    NewPatternedPushRule, NewPushRule, PredefinedContentRuleId, PredefinedOverrideRuleId,
    PushCondition, PushFormat, RuleKind, Ruleset, SenderNotificationPermissionConditionData,
    SoundTweakValue, Tweak,
};
use matrix_sdk::ruma::{
    EventId, MilliSecondsSinceUnixEpoch, OwnedRoomId, OwnedUserId, RoomId, UserId,
};
use matrix_sdk_ui::notification_client::{
    NotificationClient, NotificationEvent, NotificationItem, NotificationProcessSetup,
    NotificationStatus,
};

use url::Url;

use crate::protocol::{
    DefaultNotificationModesView, MentionNotificationModeView, MentionNotificationsView,
    MentionRuleView, NotificationModeView, NotificationSettingsView, NotificationView, PusherView,
    RoomNotificationModeView,
};

const GATEWAY_PATH: &str = "/_matrix/push/v1/notify";

impl From<NotificationModeView> for RoomNotificationMode {
    fn from(mode: NotificationModeView) -> Self {
        match mode {
            NotificationModeView::All => Self::AllMessages,
            NotificationModeView::Mentions => Self::MentionsAndKeywordsOnly,
            NotificationModeView::Mute => Self::Mute,
        }
    }
}

impl From<RoomNotificationMode> for NotificationModeView {
    fn from(mode: RoomNotificationMode) -> Self {
        match mode {
            RoomNotificationMode::AllMessages => Self::All,
            RoomNotificationMode::MentionsAndKeywordsOnly => Self::Mentions,
            RoomNotificationMode::Mute => Self::Mute,
        }
    }
}

async fn room_kind(room: &matrix_sdk::Room) -> Result<(IsEncrypted, IsOneToOne), String> {
    let encrypted = if room
        .latest_encryption_state()
        .await
        .map_err(|error| error.to_string())?
        .is_encrypted()
    {
        IsEncrypted::Yes
    } else {
        IsEncrypted::No
    };
    Ok((
        encrypted,
        IsOneToOne::from(room.active_members_count() == 2),
    ))
}

/// # Errors
///
/// When the room encryption state cannot be resolved.
pub async fn settings(room: &matrix_sdk::Room) -> Result<NotificationSettingsView, String> {
    let settings = room.client().notification_settings().await;
    let (encrypted, one_to_one) = room_kind(room).await?;

    Ok(NotificationSettingsView {
        room: settings
            .get_user_defined_room_notification_mode(room.room_id())
            .await
            .map(Into::into),
        default: settings
            .get_default_room_notification_mode(encrypted, one_to_one)
            .await
            .into(),
    })
}

pub async fn room_modes(
    client: &Client,
    room_ids: Vec<OwnedRoomId>,
) -> Vec<RoomNotificationModeView> {
    let settings = client.notification_settings().await;
    let lookups = room_ids.into_iter().filter_map(|room_id| {
        let room = client.get_room(&room_id)?;
        let settings = &settings;
        Some(async move {
            let (encrypted, one_to_one) = room_kind(&room).await.ok()?;
            Some(RoomNotificationModeView {
                room: settings
                    .get_user_defined_room_notification_mode(&room_id)
                    .await
                    .map(Into::into),
                default: settings
                    .get_default_room_notification_mode(encrypted, one_to_one)
                    .await
                    .into(),
                room_id,
            })
        })
    });
    futures_util::future::join_all(lookups)
        .await
        .into_iter()
        .flatten()
        .collect()
}

pub async fn default_modes(client: &Client) -> DefaultNotificationModesView {
    let settings = client.notification_settings().await;
    let mode = async |encrypted, one_to_one| {
        settings
            .get_default_room_notification_mode(encrypted, one_to_one)
            .await
            .into()
    };

    DefaultNotificationModesView {
        direct: mode(IsEncrypted::No, IsOneToOne::Yes).await,
        direct_encrypted: mode(IsEncrypted::Yes, IsOneToOne::Yes).await,
        group: mode(IsEncrypted::No, IsOneToOne::No).await,
        group_encrypted: mode(IsEncrypted::Yes, IsOneToOne::No).await,
    }
}

fn mention_mode(actions: &[Action]) -> MentionNotificationModeView {
    if !actions
        .iter()
        .any(|action| matches!(action, Action::Notify))
    {
        return MentionNotificationModeView::Off;
    }
    if actions.iter().any(|action| action.sound().is_some()) {
        MentionNotificationModeView::Loud
    } else {
        MentionNotificationModeView::Notify
    }
}

fn mention_actions(mode: MentionNotificationModeView) -> Vec<Action> {
    match mode {
        MentionNotificationModeView::Off => vec![],
        MentionNotificationModeView::Notify => vec![
            Action::Notify,
            Action::SetTweak(Tweak::Highlight(HighlightTweakValue::Yes)),
        ],
        MentionNotificationModeView::Loud => vec![
            Action::Notify,
            Action::SetTweak(Tweak::Sound(SoundTweakValue::Default)),
            Action::SetTweak(Tweak::Highlight(HighlightTweakValue::Yes)),
        ],
    }
}

enum MentionRule {
    Conditional {
        id: String,
        conditions: Vec<PushCondition>,
        fallback: MentionNotificationModeView,
    },
    Patterned {
        id: String,
        pattern: String,
        fallback: MentionNotificationModeView,
    },
}

fn room_mention_rule(rules: &Ruleset) -> MentionRule {
    let modern = rules
        .override_
        .iter()
        .any(|rule| rule.rule_id == PredefinedOverrideRuleId::IsRoomMention.as_str());

    let (id, matcher) = if modern {
        (
            PredefinedOverrideRuleId::IsRoomMention.to_string(),
            PushCondition::EventPropertyIs(EventPropertyIsConditionData::new(
                r"content.m\.mentions.room".to_owned(),
                true.into(),
            )),
        )
    } else {
        #[allow(deprecated)]
        let legacy = PredefinedOverrideRuleId::RoomNotif.to_string();
        (
            legacy,
            PushCondition::EventMatch(EventMatchConditionData::new(
                "content.body".to_owned(),
                "@room".to_owned(),
            )),
        )
    };

    MentionRule::Conditional {
        id,
        conditions: vec![
            matcher,
            PushCondition::SenderNotificationPermission(
                SenderNotificationPermissionConditionData::new(NotificationPowerLevelsKey::Room),
            ),
        ],
        fallback: MentionNotificationModeView::Notify,
    }
}

fn mention_rule(rules: &Ruleset, rule: MentionRuleView, user_id: &UserId) -> MentionRule {
    match rule {
        MentionRuleView::Room => room_mention_rule(rules),
        MentionRuleView::User => MentionRule::Conditional {
            id: PredefinedOverrideRuleId::IsUserMention.to_string(),
            conditions: vec![PushCondition::EventPropertyContains(
                EventPropertyContainsConditionData::new(
                    r"content.m\.mentions.user_ids".to_owned(),
                    user_id.as_str().into(),
                ),
            )],
            fallback: MentionNotificationModeView::Loud,
        },
        #[allow(deprecated)]
        MentionRuleView::DisplayName => MentionRule::Conditional {
            id: PredefinedOverrideRuleId::ContainsDisplayName.to_string(),
            conditions: vec![PushCondition::ContainsDisplayName],
            fallback: MentionNotificationModeView::Loud,
        },
        MentionRuleView::Username => {
            #[allow(deprecated)]
            let id = PredefinedContentRuleId::ContainsUserName.to_string();
            MentionRule::Patterned {
                id,
                pattern: user_id.localpart().to_owned(),
                fallback: MentionNotificationModeView::Loud,
            }
        }
    }
}

fn read_mention_mode(rules: &Ruleset, rule: &MentionRule) -> MentionNotificationModeView {
    match rule {
        MentionRule::Conditional { id, fallback, .. } => rules
            .override_
            .iter()
            .find(|rule| &rule.rule_id == id)
            .map_or(*fallback, |rule| mention_mode(&rule.actions)),
        MentionRule::Patterned { id, fallback, .. } => rules
            .content
            .iter()
            .find(|rule| &rule.rule_id == id)
            .map_or(*fallback, |rule| mention_mode(&rule.actions)),
    }
}

/// # Errors
///
/// When the server rejects the read, or no session is signed in.
pub async fn mention_notifications(client: &Client) -> Result<MentionNotificationsView, String> {
    let rules = client
        .account()
        .push_rules()
        .await
        .map_err(|error| error.to_string())?;
    let user_id = client.user_id().ok_or("no session")?;
    let read = |view| read_mention_mode(&rules, &mention_rule(&rules, view, user_id));

    Ok(MentionNotificationsView {
        room: read(MentionRuleView::Room),
        user: read(MentionRuleView::User),
        display_name: read(MentionRuleView::DisplayName),
        username: read(MentionRuleView::Username),
    })
}

/// # Errors
///
/// When the server rejects the write, or no session is signed in.
pub async fn set_mention_notifications(
    client: &Client,
    rule: MentionRuleView,
    mode: MentionNotificationModeView,
) -> Result<(), String> {
    let rules = client
        .account()
        .push_rules()
        .await
        .map_err(|error| error.to_string())?;
    let user_id = client.user_id().ok_or("no session")?;
    let actions = mention_actions(mode);

    let new = match mention_rule(&rules, rule, user_id) {
        MentionRule::Conditional { id, conditions, .. } => {
            NewPushRule::Override(NewConditionalPushRule::new(id, conditions, actions))
        }
        MentionRule::Patterned { id, pattern, .. } => {
            NewPushRule::Content(NewPatternedPushRule::new(id, pattern, actions))
        }
    };

    client
        .send(set_pushrule::v3::Request::new(new))
        .await
        .map(|_| ())
        .map_err(|error| error.to_string())
}

/// # Errors
///
/// When the server rejects the push rule write.
pub async fn set_default_mode(
    client: &Client,
    direct: bool,
    encrypted: bool,
    mode: NotificationModeView,
) -> Result<(), String> {
    client
        .notification_settings()
        .await
        .set_default_room_notification_mode(
            if encrypted {
                IsEncrypted::Yes
            } else {
                IsEncrypted::No
            },
            IsOneToOne::from(direct),
            mode.into(),
        )
        .await
        .map_err(|error| error.to_string())
}

/// # Errors
///
/// When the server rejects the push rule write.
pub async fn set_room_mode(
    room: &matrix_sdk::Room,
    mode: Option<NotificationModeView>,
) -> Result<(), String> {
    let settings = room.client().notification_settings().await;

    match mode {
        Some(mode) => {
            settings
                .set_room_notification_mode(room.room_id(), mode.into())
                .await
        }
        None => {
            settings
                .delete_user_defined_room_rules(room.room_id())
                .await
        }
    }
    .map_err(|error| error.to_string())
}

pub async fn notification(
    client: &Client,
    setup: NotificationProcessSetup,
    room_id: &RoomId,
    event_id: &EventId,
) -> Option<NotificationView> {
    let notifications = NotificationClient::new(client.clone(), setup).await.ok()?;

    match notifications.get_notification(room_id, event_id).await {
        Ok(NotificationStatus::Event(item)) => {
            Some(view(client.user_id()?.to_owned(), room_id, event_id, *item))
        }
        _ => None,
    }
}

pub(crate) async fn foreground_notification(
    notifications: &NotificationClient,
    room: &matrix_sdk::Room,
    event_id: &EventId,
) -> Option<NotificationView> {
    match notifications
        .get_notification_with_context(room.room_id(), event_id)
        .await
    {
        Ok(NotificationStatus::Event(item)) => Some(view(
            room.own_user_id().to_owned(),
            room.room_id(),
            event_id,
            *item,
        )),
        _ => None,
    }
}

pub(crate) async fn invite_notification(
    room: &matrix_sdk::Room,
    actions: &[Action],
) -> Option<NotificationView> {
    let invite = room.invite_details().await.ok()?;
    Some(NotificationView {
        user_id: room.own_user_id().to_owned(),
        room_id: room.room_id().to_owned(),
        event_id: None,
        room_name: room.display_name().await.ok()?.to_string(),
        room_avatar_url: room.avatar_url().map(|url| url.to_string()),
        is_direct: room.is_direct().await.unwrap_or(false),
        encrypted: room.encryption_state().is_encrypted(),
        sender: invite.inviter_id,
        sender_name: invite
            .inviter
            .as_ref()
            .and_then(|member| member.display_name().map(ToOwned::to_owned)),
        sender_avatar_url: invite
            .inviter
            .as_ref()
            .and_then(|member| member.avatar_url().map(ToString::to_string)),
        body: "invited you".to_owned(),
        mention: actions.iter().any(Action::is_highlight),
        noisy: Some(actions.iter().any(|action| action.sound().is_some())),
    })
}

/// A device token must not be handed to anything but a Matrix push gateway.
/// # Errors
///
/// When the address is not a gateway's.
fn gateway(url: &str) -> Result<String, String> {
    let parsed = Url::parse(url).map_err(|_| "the push gateway is not a URL".to_owned())?;
    let plain = parsed.scheme() != "https";
    let addressed = !parsed.username().is_empty() || parsed.password().is_some();
    if plain || addressed || parsed.fragment().is_some() || parsed.path() != GATEWAY_PATH {
        return Err(format!("{url} is not an https {GATEWAY_PATH} endpoint"));
    }

    Ok(parsed.to_string())
}

/// A cold platform notification is built from this payload, and it derives its
/// identity from `user_id`, so leaving it out stops a running app replacing it.
/// # Errors
///
/// When the gateway is not a push gateway, or the server rejects the registration.
pub async fn set_pusher(client: &Client, pusher: PusherView) -> Result<(), String> {
    let mut pusher_data = HttpPusherData::new(gateway(&pusher.url)?);
    if pusher.event_id_only {
        pusher_data.format = Some(PushFormat::EventIdOnly);
    }
    if let Some(user_id) = client.user_id() {
        pusher_data
            .data
            .insert("user_id".to_owned(), user_id.as_str().into());
        pusher_data.data.insert(
            "default_payload".to_owned(),
            serde_json::json!({ "user_id": user_id.as_str() }),
        );
    }
    if let Some(keys) = pusher.web_push {
        pusher_data
            .data
            .insert("endpoint".to_owned(), keys.endpoint.into());
        pusher_data
            .data
            .insert("p256dh".to_owned(), keys.p256dh.into());
        pusher_data.data.insert("auth".to_owned(), keys.auth.into());
    }

    client
        .pusher()
        .set(
            PusherInit {
                ids: PusherIds::new(pusher.pushkey, pusher.app_id),
                kind: PusherKind::Http(pusher_data),
                app_display_name: "Sable".to_owned(),
                device_display_name: pusher.device_display_name,
                profile_tag: None,
                lang: "en".to_owned(),
            }
            .into(),
            pusher.append,
        )
        .await
        .map_err(|error| error.to_string())
}

/// # Errors
///
/// When the server rejects the removal.
pub async fn remove_pusher(client: &Client, pushkey: String, app_id: String) -> Result<(), String> {
    client
        .pusher()
        .delete(PusherIds::new(pushkey, app_id))
        .await
        .map_err(|error| error.to_string())
}

/// # Errors
///
/// When the server rejects the read.
pub async fn keywords(client: &Client) -> Result<Vec<String>, String> {
    let ruleset = client
        .account()
        .push_rules()
        .await
        .map_err(|error| error.to_string())?;

    let mut keywords: Vec<String> = ruleset
        .content
        .iter()
        .filter(|rule| !rule.default)
        .map(|rule| rule.pattern.clone())
        .collect();
    keywords.sort_unstable();
    keywords.dedup();
    Ok(keywords)
}

/// # Errors
///
/// When the keyword is blank, or the server rejects the rule.
pub async fn add_keyword(client: &Client, keyword: String) -> Result<(), String> {
    let pattern = keyword.trim().to_owned();
    if pattern.is_empty() {
        return Err("a keyword cannot be blank".to_owned());
    }

    let rule = NewPatternedPushRule::new(
        pattern.clone(),
        pattern,
        vec![
            Action::Notify,
            Action::SetTweak(Tweak::Sound(SoundTweakValue::Default)),
            Action::SetTweak(Tweak::Highlight(HighlightTweakValue::Yes)),
        ],
    );

    client
        .send(set_pushrule::v3::Request::new(NewPushRule::Content(rule)))
        .await
        .map_err(|error| error.to_string())?;
    Ok(())
}

/// # Errors
///
/// When the server rejects the removal.
pub async fn remove_keyword(client: &Client, keyword: String) -> Result<(), String> {
    client
        .send(delete_pushrule::v3::Request::new(
            RuleKind::Content,
            keyword,
        ))
        .await
        .map_err(|error| error.to_string())?;
    Ok(())
}

const BACKFILL_GRACE_MS: u64 = 60_000;

#[must_use]
pub fn is_backfill(
    session_start: MilliSecondsSinceUnixEpoch,
    origin_server_ts: MilliSecondsSinceUnixEpoch,
) -> bool {
    let start: u64 = session_start.get().into();
    let sent: u64 = origin_server_ts.get().into();
    sent < start.saturating_sub(BACKFILL_GRACE_MS)
}

#[must_use]
pub fn is_read(room: &matrix_sdk::Room) -> bool {
    room.unread_notification_counts().notification_count == 0
}

#[must_use]
pub fn notifies(actions: &[Action]) -> bool {
    actions
        .iter()
        .any(|action| matches!(action, Action::Notify))
}

fn view(
    user_id: OwnedUserId,
    room_id: &RoomId,
    event_id: &EventId,
    item: NotificationItem,
) -> NotificationView {
    NotificationView {
        user_id,
        room_id: room_id.to_owned(),
        event_id: Some(event_id.to_owned()),
        room_name: item.room_computed_display_name,
        room_avatar_url: item.room_avatar_url,
        is_direct: item.is_direct_message_room,
        encrypted: item.is_room_encrypted.unwrap_or(false),
        sender: item.event.sender().to_owned(),
        sender_name: item.sender_display_name,
        sender_avatar_url: item.sender_avatar_url,
        body: body(&item.event),
        mention: item.has_mention.unwrap_or(false),
        noisy: item.is_noisy,
    }
}

fn body(event: &NotificationEvent) -> String {
    match event {
        NotificationEvent::Invite(_) => "invited you".to_owned(),
        NotificationEvent::Timeline(event) => timeline_body(event),
    }
}

const FALLBACK_BODY: &str = "sent a message";

fn timeline_body(event: &AnySyncTimelineEvent) -> String {
    let AnySyncTimelineEvent::MessageLike(message) = event else {
        return FALLBACK_BODY.to_owned();
    };

    match message {
        AnySyncMessageLikeEvent::RoomMessage(message) => message.as_original().map_or_else(
            || FALLBACK_BODY.to_owned(),
            |event| room_message_body(&event.content),
        ),
        AnySyncMessageLikeEvent::RoomEncrypted(_) => "sent an encrypted message".to_owned(),
        AnySyncMessageLikeEvent::Sticker(_) => "sent a sticker".to_owned(),
        AnySyncMessageLikeEvent::Reaction(reaction) => reaction.as_original().map_or_else(
            || FALLBACK_BODY.to_owned(),
            |event| format!("reacted with {}", event.content.relates_to.key),
        ),
        AnySyncMessageLikeEvent::UnstablePollStart(poll) => poll.as_original().map_or_else(
            || FALLBACK_BODY.to_owned(),
            |event| event.content.poll_start().question.text.clone(),
        ),
        AnySyncMessageLikeEvent::CallInvite(_) => "started a call".to_owned(),
        _ => FALLBACK_BODY.to_owned(),
    }
}

fn room_message_body(content: &RoomMessageEventContent) -> String {
    match &content.msgtype {
        MessageType::Image(_) => "sent an image".to_owned(),
        MessageType::Video(_) => "sent a video".to_owned(),
        MessageType::Audio(_) => "sent an audio file".to_owned(),
        MessageType::File(_) => "sent a file".to_owned(),
        _ => content.body().to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use matrix_sdk::ruma::events::AnySyncTimelineEvent;
    use matrix_sdk::ruma::push::Ruleset;
    use matrix_sdk::ruma::serde::Raw;
    use matrix_sdk::ruma::{MilliSecondsSinceUnixEpoch, UInt, user_id};
    use serde_json::json;

    use super::{
        MentionRule, gateway, is_backfill, mention_actions, mention_rule, read_mention_mode,
        timeline_body,
    };
    use crate::protocol::{MentionNotificationModeView, MentionRuleView};

    fn ts(millis: u32) -> MilliSecondsSinceUnixEpoch {
        MilliSecondsSinceUnixEpoch(UInt::from(millis))
    }

    fn event(value: &serde_json::Value) -> AnySyncTimelineEvent {
        Raw::<AnySyncTimelineEvent>::from_json_string(value.to_string())
            .expect("the fixture is valid JSON")
            .deserialize()
            .expect("the fixture is a timeline event")
    }

    fn stub(event_type: &str, content: &serde_json::Value) -> serde_json::Value {
        json!({
            "type": event_type,
            "content": content,
            "event_id": "$1:example.org",
            "sender": "@alice:example.org",
            "origin_server_ts": 0,
        })
    }

    #[test]
    fn every_notifiable_event_says_something() {
        let cases = [
            stub(
                "m.room.message",
                &json!({"msgtype": "m.text", "body": "hello"}),
            ),
            stub(
                "m.room.message",
                &json!({"msgtype": "m.image", "body": "cat.png", "url": "mxc://example.org/2"}),
            ),
            stub(
                "m.room.encrypted",
                &json!({"algorithm": "m.megolm.v1.aes-sha2", "ciphertext": "x", "sender_key": "k", "device_id": "D", "session_id": "s"}),
            ),
            stub(
                "m.sticker",
                &json!({"body": "wave", "url": "mxc://example.org/1", "info": {"w": 1, "h": 1, "mimetype": "image/png", "size": 1}}),
            ),
            stub(
                "m.reaction",
                &json!({"m.relates_to": {"rel_type": "m.annotation", "event_id": "$0:example.org", "key": "👍"}}),
            ),
            stub(
                "org.matrix.msc3381.poll.start",
                &json!({"org.matrix.msc3381.poll.start": {"question": {"org.matrix.msc1767.text": "Lunch?"}, "answers": [{"id": "a", "org.matrix.msc1767.text": "Yes"}]}}),
            ),
            stub("m.room.topic", &json!({"topic": "hi"})),
        ];

        for case in cases {
            let body = timeline_body(&event(&case));
            assert!(
                !body.is_empty(),
                "a notification for {case} would read as a bare sender name"
            );
        }
    }

    #[test]
    fn the_body_describes_what_arrived() {
        assert_eq!(
            timeline_body(&event(&stub(
                "m.room.message",
                &json!({"msgtype": "m.text", "body": "hello"})
            ))),
            "hello"
        );
        assert_eq!(
            timeline_body(&event(&stub(
                "m.room.encrypted",
                &json!({"algorithm": "m.megolm.v1.aes-sha2", "ciphertext": "x", "sender_key": "k", "device_id": "D", "session_id": "s"})
            ))),
            "sent an encrypted message"
        );
        assert_eq!(
            timeline_body(&event(&stub(
                "m.reaction",
                &json!({"m.relates_to": {"rel_type": "m.annotation", "event_id": "$0:example.org", "key": "👍"}})
            ))),
            "reacted with 👍"
        );
        assert_eq!(
            timeline_body(&event(&stub(
                "org.matrix.msc3381.poll.start",
                &json!({"org.matrix.msc3381.poll.start": {"question": {"org.matrix.msc1767.text": "Lunch?"}, "answers": [{"id": "a", "org.matrix.msc1767.text": "Yes"}]}})
            ))),
            "Lunch?"
        );
    }

    #[test]
    fn a_replayed_event_is_backfill_and_a_recent_one_is_not() {
        let start = ts(120_000);
        assert!(is_backfill(start, ts(1_000)));
        assert!(!is_backfill(start, ts(120_000)));
        assert!(!is_backfill(start, ts(200_000)));
        assert!(!is_backfill(start, ts(61_000)));
        assert!(is_backfill(start, ts(59_000)));
    }

    #[test]
    fn a_gateway_must_be_an_https_notify_endpoint() {
        assert_eq!(
            gateway("https://sygnal.example/_matrix/push/v1/notify"),
            Ok("https://sygnal.example/_matrix/push/v1/notify".to_owned())
        );

        let accepted: Vec<&str> = [
            "http://sygnal.example/_matrix/push/v1/notify",
            "https://user:pass@sygnal.example/_matrix/push/v1/notify",
            "https://sygnal.example/_matrix/push/v1/notify#fragment",
            "https://sygnal.example/",
            "not a url",
        ]
        .into_iter()
        .filter(|address| gateway(address).is_ok())
        .collect();

        assert!(accepted.is_empty(), "these are not gateways: {accepted:?}");
    }

    #[test]
    fn mention_modes_write_v1_actions() {
        assert_eq!(
            serde_json::to_value(mention_actions(MentionNotificationModeView::Off)).unwrap(),
            json!([])
        );
        assert_eq!(
            serde_json::to_value(mention_actions(MentionNotificationModeView::Notify)).unwrap(),
            json!(["notify", {"set_tweak": "highlight"}])
        );
        assert_eq!(
            serde_json::to_value(mention_actions(MentionNotificationModeView::Loud)).unwrap(),
            json!([
                "notify",
                {"set_tweak": "sound", "value": "default"},
                {"set_tweak": "highlight"}
            ])
        );
    }

    fn conditional(rule: MentionRule) -> (String, serde_json::Value) {
        match rule {
            MentionRule::Conditional { id, conditions, .. } => {
                let conditions = serde_json::to_value(conditions).unwrap();
                (id, conditions)
            }
            MentionRule::Patterned { .. } => panic!("expected a conditional rule"),
        }
    }

    #[test]
    fn room_mention_falls_back_to_legacy_text_and_permission() {
        let user = user_id!("@me:example.org");
        let mut rules = Ruleset::server_default(user);
        rules.override_.clear();

        let (id, conditions) = conditional(mention_rule(&rules, MentionRuleView::Room, user));

        assert_eq!(id, ".m.rule.roomnotif");
        assert_eq!(
            conditions,
            json!([
                {"kind": "event_match", "key": "content.body", "pattern": "@room"},
                {"kind": "sender_notification_permission", "key": "room"}
            ])
        );
    }

    #[test]
    fn the_other_mention_rules_match_the_server_defaults() {
        let user = user_id!("@me:example.org");
        let rules = Ruleset::server_default(user);

        let (id, conditions) = conditional(mention_rule(&rules, MentionRuleView::User, user));
        assert_eq!(id, ".m.rule.is_user_mention");
        assert_eq!(
            conditions,
            json!([{
                "kind": "event_property_contains",
                "key": r"content.m\.mentions.user_ids",
                "value": "@me:example.org"
            }])
        );

        let (id, conditions) =
            conditional(mention_rule(&rules, MentionRuleView::DisplayName, user));
        assert_eq!(id, ".m.rule.contains_display_name");
        assert_eq!(conditions, json!([{"kind": "contains_display_name"}]));

        match mention_rule(&rules, MentionRuleView::Username, user) {
            MentionRule::Patterned { id, pattern, .. } => {
                assert_eq!(id, ".m.rule.contains_user_name");
                assert_eq!(pattern, "me");
            }
            MentionRule::Conditional { .. } => panic!("the username rule is content-specific"),
        }
    }

    #[test]
    fn an_absent_mention_rule_reads_as_its_server_default() {
        let user = user_id!("@me:example.org");
        let mut rules = Ruleset::server_default(user);
        rules.override_.clear();
        rules.content.clear();

        let read = |view| read_mention_mode(&rules, &mention_rule(&rules, view, user));

        assert_eq!(
            read(MentionRuleView::Room),
            MentionNotificationModeView::Notify
        );
        assert_eq!(
            read(MentionRuleView::User),
            MentionNotificationModeView::Loud
        );
        assert_eq!(
            read(MentionRuleView::Username),
            MentionNotificationModeView::Loud
        );
    }

    #[test]
    fn a_content_rule_is_read_from_the_content_kind() {
        let user = user_id!("@me:example.org");
        let rules = Ruleset::server_default(user);

        assert_eq!(
            read_mention_mode(
                &rules,
                &mention_rule(&rules, MentionRuleView::Username, user)
            ),
            MentionNotificationModeView::Loud
        );
    }
}
