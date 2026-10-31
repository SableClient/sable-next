use std::sync::Arc;

use crate::errors::CoreError;
use base64::Engine as _;
use matrix_sdk::Client;
use matrix_sdk::event_handler::EventHandlerDropGuard;
use matrix_sdk::ruma::api::client::push::{
    delete_pushrule, set_pushrule, set_pushrule_actions, set_pushrule_enabled,
};
use matrix_sdk::ruma::api::error::ErrorKind;
use matrix_sdk::ruma::events::push_rules::PushRulesEvent;
use matrix_sdk::ruma::push::{
    Action, AnyPushRuleRef, EventMatchConditionData, EventPropertyIsConditionData,
    HighlightTweakValue, NewConditionalPushRule, NewPatternedPushRule, NewPushRule,
    NewSimplePushRule, PredefinedContentRuleId, PredefinedOverrideRuleId,
    PredefinedUnderrideRuleId, PushCondition, RoomMemberCountConditionData, RuleKind, Ruleset,
    ScalarJsonValue, SenderNotificationPermissionConditionData, SoundTweakValue, Tweak,
};
use matrix_sdk::ruma::{OwnedRoomId, RoomId};
use tokio::sync::{RwLock, broadcast};

use crate::protocol::{
    DefaultNotificationModesView, EventNotificationView, EventNotificationsView,
    KeywordNotificationView, MentionNotificationModeView, MentionNotificationsView,
    MentionRuleView, NotificationModeView, NotificationSettingsView,
};

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
    fn apply_to(self, rules: &mut Ruleset) {
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

#[must_use]
pub fn notifies(actions: &[Action]) -> bool {
    actions
        .iter()
        .any(|action| matches!(action, Action::Notify))
}

fn rule_notifies(rule: AnyPushRuleRef<'_>) -> bool {
    rule.enabled() && notifies(rule.actions())
}

#[must_use]
pub fn level(enabled: bool, actions: &[Action]) -> MentionNotificationModeView {
    if !enabled || !notifies(actions) {
        MentionNotificationModeView::Off
    } else if sound(actions) {
        MentionNotificationModeView::Loud
    } else {
        MentionNotificationModeView::Notify
    }
}

#[must_use]
pub fn level_actions(level: MentionNotificationModeView, highlight: bool) -> Vec<Action> {
    let mut actions = match level {
        MentionNotificationModeView::Off => return vec![],
        MentionNotificationModeView::Notify => vec![Action::Notify],
        MentionNotificationModeView::Loud => vec![
            Action::Notify,
            Action::SetTweak(Tweak::Sound(SoundTweakValue::Default)),
        ],
    };
    if highlight {
        actions.push(Action::SetTweak(Tweak::Highlight(HighlightTweakValue::Yes)));
    }
    actions
}

fn plan_level(
    kind: RuleKind,
    rule_id: &str,
    level: MentionNotificationModeView,
    highlight: bool,
) -> Vec<RuleWrite> {
    let enabled = RuleWrite::Enabled {
        kind: kind.clone(),
        rule_id: rule_id.to_owned(),
        enabled: level != MentionNotificationModeView::Off,
    };
    if level == MentionNotificationModeView::Off {
        return vec![enabled];
    }
    vec![
        RuleWrite::Actions {
            kind,
            rule_id: rule_id.to_owned(),
            actions: level_actions(level, highlight),
        },
        enabled,
    ]
}

fn targets_room(conditions: &[PushCondition], room_id: &RoomId) -> bool {
    conditions.iter().any(|condition| {
        matches!(
            condition,
            PushCondition::EventMatch(data) if data.key == "room_id" && data.pattern == room_id.as_str()
        )
    })
}

fn muted(rules: &Ruleset, room_id: &RoomId) -> bool {
    rules.override_.iter().any(|rule| {
        !rule.default
            && rule.enabled
            && !notifies(&rule.actions)
            && targets_room(&rule.conditions, room_id)
    })
}

fn room_rule<'a>(rules: &'a Ruleset, room_id: &RoomId) -> Option<&'a [Action]> {
    rules
        .room
        .iter()
        .find(|rule| rule.enabled && rule.rule_id == *room_id)
        .map(|rule| rule.actions.as_slice())
}

#[must_use]
pub fn room_mode(rules: &Ruleset, room_id: &RoomId) -> Option<NotificationModeView> {
    if muted(rules, room_id) {
        return Some(NotificationModeView::Mute);
    }
    room_rule(rules, room_id).map(|actions| {
        if notifies(actions) {
            NotificationModeView::All
        } else {
            NotificationModeView::Mentions
        }
    })
}

#[must_use]
pub fn dm_notifies(rules: &Ruleset, room_id: &RoomId) -> bool {
    match room_mode(rules, room_id) {
        Some(NotificationModeView::Mute | NotificationModeView::Mentions) => false,
        Some(NotificationModeView::All) => true,
        None => rules
            .get(RuleKind::Underride, message_rule(true).as_str())
            .is_none_or(rule_notifies),
    }
}

const fn message_rule(direct: bool) -> PredefinedUnderrideRuleId {
    if direct {
        PredefinedUnderrideRuleId::RoomOneToOne
    } else {
        PredefinedUnderrideRuleId::Message
    }
}

const fn encrypted_rule(direct: bool) -> PredefinedUnderrideRuleId {
    if direct {
        PredefinedUnderrideRuleId::EncryptedRoomOneToOne
    } else {
        PredefinedUnderrideRuleId::Encrypted
    }
}

const fn default_family(direct: bool) -> [&'static str; 7] {
    if direct {
        [
            ".m.rule.room_one_to_one",
            ".m.rule.encrypted_room_one_to_one",
            STICKER_DIRECT,
            ".m.rule.poll_start_one_to_one",
            ".m.rule.poll_end_one_to_one",
            ".org.matrix.msc3930.rule.poll_start_one_to_one",
            ".org.matrix.msc3930.rule.poll_end_one_to_one",
        ]
    } else {
        [
            ".m.rule.message",
            ".m.rule.encrypted",
            STICKER,
            ".m.rule.poll_start",
            ".m.rule.poll_end",
            ".org.matrix.msc3930.rule.poll_start",
            ".org.matrix.msc3930.rule.poll_end",
        ]
    }
}

fn spec_actions(direct: bool) -> Vec<Action> {
    if direct {
        vec![
            Action::Notify,
            Action::SetTweak(Tweak::Sound(SoundTweakValue::Default)),
        ]
    } else {
        vec![Action::Notify]
    }
}

#[must_use]
pub fn default_mode(rules: &Ruleset, direct: bool) -> NotificationModeView {
    if rules
        .get(RuleKind::Underride, message_rule(direct).as_str())
        .is_some_and(rule_notifies)
    {
        NotificationModeView::All
    } else {
        NotificationModeView::Mentions
    }
}

#[must_use]
pub fn default_modes(rules: &Ruleset) -> DefaultNotificationModesView {
    DefaultNotificationModesView {
        direct: default_mode(rules, true),
        group: default_mode(rules, false),
    }
}

#[must_use]
pub fn room_settings(rules: &Ruleset, room_id: &RoomId, direct: bool) -> NotificationSettingsView {
    NotificationSettingsView {
        room: room_mode(rules, room_id),
        default: default_mode(rules, direct),
    }
}

#[must_use]
pub fn plan_room_mode(
    rules: &Ruleset,
    room_id: &RoomId,
    direct: bool,
    mode: Option<NotificationModeView>,
) -> Vec<RuleWrite> {
    let kept = match mode {
        Some(NotificationModeView::Mute) => Some(RuleKind::Override),
        Some(_) => Some(RuleKind::Room),
        None => None,
    };
    let mut writes = Vec::new();
    match mode {
        Some(NotificationModeView::Mute) => writes.push(RuleWrite::Put(NewPushRule::Override(
            NewConditionalPushRule::new(
                room_id.to_string(),
                vec![PushCondition::EventMatch(
                    matrix_sdk::ruma::push::EventMatchConditionData::new(
                        "room_id".to_owned(),
                        room_id.to_string(),
                    ),
                )],
                vec![],
            ),
        ))),
        Some(NotificationModeView::All) => {
            writes.push(RuleWrite::Put(NewPushRule::Room(NewSimplePushRule::new(
                room_id.to_owned(),
                spec_actions(direct),
            ))));
        }
        Some(NotificationModeView::Mentions) => {
            writes.push(RuleWrite::Put(NewPushRule::Room(NewSimplePushRule::new(
                room_id.to_owned(),
                vec![],
            ))));
        }
        None => {}
    }
    if let Some(kind) = &kept {
        writes.push(RuleWrite::Enabled {
            kind: kind.clone(),
            rule_id: room_id.to_string(),
            enabled: true,
        });
    }

    let mut stale: Vec<(RuleKind, String)> = vec![
        (RuleKind::Override, room_id.to_string()),
        (RuleKind::Room, room_id.to_string()),
    ];
    stale.extend(
        rules
            .override_
            .iter()
            .filter(|rule| !rule.default && targets_room(&rule.conditions, room_id))
            .map(|rule| (RuleKind::Override, rule.rule_id.clone())),
    );
    stale.extend(
        rules
            .underride
            .iter()
            .filter(|rule| {
                !rule.default
                    && !rule.rule_id.starts_with(SHAPE_PREFIX)
                    && targets_room(&rule.conditions, room_id)
            })
            .map(|rule| (RuleKind::Underride, rule.rule_id.clone())),
    );
    let mut seen = std::collections::HashSet::new();
    for (kind, rule_id) in stale {
        if kept.as_ref() == Some(&kind) && rule_id == room_id.as_str() {
            continue;
        }
        if seen.insert((kind.to_string(), rule_id.clone())) {
            writes.push(RuleWrite::Delete { kind, rule_id });
        }
    }
    writes
}

/// # Errors
///
/// When the server has no rule for this kind of room.
pub fn plan_default_mode(
    rules: &Ruleset,
    direct: bool,
    mode: NotificationModeView,
) -> Result<Vec<RuleWrite>, CoreError> {
    let message = message_rule(direct);
    if rules.get(RuleKind::Underride, message.as_str()).is_none() {
        return Err(format!("the server has no {message} rule").into());
    }
    Ok(default_family(direct)
        .into_iter()
        .filter(|rule_id| rules.get(RuleKind::Underride, rule_id).is_some())
        .flat_map(|rule_id| {
            let actions = match mode {
                NotificationModeView::All => spec_actions(direct),
                NotificationModeView::Mentions | NotificationModeView::Mute => vec![],
            };
            [
                RuleWrite::Actions {
                    kind: RuleKind::Underride,
                    rule_id: rule_id.to_owned(),
                    actions,
                },
                RuleWrite::Enabled {
                    kind: RuleKind::Underride,
                    rule_id: rule_id.to_owned(),
                    enabled: true,
                },
            ]
        })
        .collect())
}

const SHAPE_PREFIX: &str = "moe.sable.shape.";
const STICKER: &str = "moe.sable.sticker";
const STICKER_DIRECT: &str = "moe.sable.sticker_one_to_one";
const RING_ONE_TO_ONE: &str = "moe.sable.ring_one_to_one";
const RTC_INVITE_TYPES: [(&str, &str, &str); 3] = [
    (
        "m.rtc.invite",
        "moe.sable.rtc.invite_for_me",
        "moe.sable.rtc.invite_for_room",
    ),
    (
        "org.matrix.msc4075.rtc.notification",
        "moe.sable.rtc.invite_for_me.unstable",
        "moe.sable.rtc.invite_for_room.unstable",
    ),
    (
        "m.rtc.notification",
        "moe.sable.rtc.invite_for_me.legacy",
        "moe.sable.rtc.invite_for_room.legacy",
    ),
];
const RTC_INVITE_GUARDS: [(&str, &str); 3] = [
    ("m.rtc.invite", "moe.sable.rtc.suppress_invite"),
    (
        "org.matrix.msc4075.rtc.notification",
        "moe.sable.rtc.suppress_invite.unstable",
    ),
    ("m.rtc.notification", "moe.sable.rtc.suppress_invite.legacy"),
];
const RTC_SERVER_USER_RULES: [&str; 2] = [
    ".m.rule.rtc.invite_for_me",
    ".org.matrix.msc4075.rule.rtc.invite_for_me",
];
const RTC_SERVER_ROOM_RULES: [&str; 2] = [
    ".m.rule.rtc.invite_for_room",
    ".org.matrix.msc4075.rule.rtc.invite_for_room",
];
const SUPPRESS_BRIDGE_STATUS: &str = "moe.sable.suppress_bridge_status";
const SUPPRESS_REACTIONS: &str = "moe.sable.suppress_reactions";
/// A room rule matches every event, so these would notify in a room set to all messages.
const SUPPRESSED_ROOM_EVENTS: [&str; 15] = [
    "m.room.name",
    "m.room.topic",
    "m.room.avatar",
    "m.room.canonical_alias",
    "m.room.pinned_events",
    "m.room.power_levels",
    "m.room.join_rules",
    "m.room.history_visibility",
    "m.room.redaction",
    "org.matrix.msc3401.call.member",
    "m.call.member",
    "org.matrix.msc4143.rtc.member",
    "m.rtc.member",
    "m.rtc.decline",
    "org.matrix.msc4310.rtc.decline",
];

#[must_use]
pub fn plan_alignment(rules: &Ruleset) -> Vec<RuleWrite> {
    let mut writes: Vec<_> = [true, false]
        .into_iter()
        .filter_map(|direct| {
            let plain = rules.get(RuleKind::Underride, message_rule(direct).as_str())?;
            let encrypted_id = encrypted_rule(direct);
            let encrypted = rules.get(RuleKind::Underride, encrypted_id.as_str())?;
            let notify = rule_notifies(plain);
            (notify != rule_notifies(encrypted)).then(|| {
                [
                    RuleWrite::Actions {
                        kind: RuleKind::Underride,
                        rule_id: encrypted_id.to_string(),
                        actions: if notify { spec_actions(direct) } else { vec![] },
                    },
                    RuleWrite::Enabled {
                        kind: RuleKind::Underride,
                        rule_id: encrypted_id.to_string(),
                        enabled: true,
                    },
                ]
            })
        })
        .flatten()
        .collect();

    writes.extend(align_stickers(rules, false));
    writes.extend(align_stickers(rules, true));
    writes.extend(align_rtc_invites(rules));
    writes.extend(silence_event_type(
        rules,
        SUPPRESS_BRIDGE_STATUS,
        "com.beeper.message_send_status",
        None,
    ));
    writes.extend(silence_event_type(
        rules,
        SUPPRESS_REACTIONS,
        "m.reaction",
        Some(PredefinedOverrideRuleId::Reaction.as_str()),
    ));
    writes.extend(SUPPRESSED_ROOM_EVENTS.iter().filter_map(|event_type| {
        silence_event_type(
            rules,
            &format!("moe.sable.suppress.{event_type}"),
            event_type,
            None,
        )
    }));
    writes
}

fn sound(actions: &[Action]) -> bool {
    actions.iter().any(|action| action.sound().is_some())
}

/// The server picks the one-to-one rules by joined member count, so a room whose
/// direct flag disagrees gets its own copies of the rules of the kind it is flagged as.
/// `rooms` holds those rooms with their flag; every other room's copies are removed.
#[must_use]
pub fn plan_room_shapes(rules: &Ruleset, rooms: &[(OwnedRoomId, bool)]) -> Vec<RuleWrite> {
    let kinds = [
        (
            "message",
            ".m.rule.room_one_to_one",
            ".m.rule.message",
            "m.room.message",
        ),
        (
            "encrypted",
            ".m.rule.encrypted_room_one_to_one",
            ".m.rule.encrypted",
            "m.room.encrypted",
        ),
        ("sticker", STICKER_DIRECT, STICKER, "m.sticker"),
    ];
    let mut wanted = std::collections::BTreeMap::new();
    for (room_id, direct) in rooms {
        for (kind, one_to_one, group, event_type) in kinds {
            let Some(source) = rules.get(
                RuleKind::Underride,
                if *direct { one_to_one } else { group },
            ) else {
                continue;
            };
            let actions = if rule_notifies(source) {
                source.actions().to_vec()
            } else {
                vec![]
            };
            wanted.insert(
                format!("{SHAPE_PREFIX}{kind}.{room_id}"),
                (room_id, event_type, actions),
            );
        }
    }

    let mut writes = Vec::new();
    for (rule_id, (room_id, event_type, actions)) in &wanted {
        match rules.underride.iter().find(|rule| rule.rule_id == *rule_id) {
            Some(rule)
                if rule.enabled
                    && notifies(&rule.actions) == notifies(actions)
                    && sound(&rule.actions) == sound(actions) => {}
            Some(_) => writes.extend([
                RuleWrite::Actions {
                    kind: RuleKind::Underride,
                    rule_id: rule_id.clone(),
                    actions: actions.clone(),
                },
                RuleWrite::Enabled {
                    kind: RuleKind::Underride,
                    rule_id: rule_id.clone(),
                    enabled: true,
                },
            ]),
            None => writes.push(RuleWrite::Put(NewPushRule::Underride(
                NewConditionalPushRule::new(
                    rule_id.clone(),
                    vec![
                        PushCondition::EventMatch(EventMatchConditionData::new(
                            "room_id".to_owned(),
                            room_id.to_string(),
                        )),
                        PushCondition::EventMatch(EventMatchConditionData::new(
                            "type".to_owned(),
                            (*event_type).to_owned(),
                        )),
                    ],
                    actions.clone(),
                ),
            ))),
        }
    }
    writes.extend(
        rules
            .underride
            .iter()
            .filter(|rule| {
                rule.rule_id.starts_with(SHAPE_PREFIX) && !wanted.contains_key(&rule.rule_id)
            })
            .map(|rule| RuleWrite::Delete {
                kind: RuleKind::Underride,
                rule_id: rule.rule_id.clone(),
            }),
    );
    writes
}

/// The spec's default rules only match `m.room.message`, so a sticker would never notify.
fn align_stickers(rules: &Ruleset, direct: bool) -> Vec<RuleWrite> {
    let Some(message) = rules.get(RuleKind::Underride, message_rule(direct).as_str()) else {
        return vec![];
    };
    let notify = rule_notifies(message);
    let rule_id = if direct { STICKER_DIRECT } else { STICKER };
    let actions = if notify { spec_actions(direct) } else { vec![] };
    match rules.underride.iter().find(|rule| rule.rule_id == rule_id) {
        None => {
            let mut conditions = vec![PushCondition::EventMatch(EventMatchConditionData::new(
                "type".to_owned(),
                "m.sticker".to_owned(),
            ))];
            if direct {
                conditions.insert(
                    0,
                    PushCondition::RoomMemberCount(RoomMemberCountConditionData::new(
                        matrix_sdk::ruma::uint!(2).into(),
                    )),
                );
            }
            vec![RuleWrite::Put(NewPushRule::Underride(
                NewConditionalPushRule::new(rule_id.to_owned(), conditions, actions),
            ))]
        }
        Some(rule) if rule.enabled && notifies(&rule.actions) == notify => vec![],
        Some(_) => vec![
            RuleWrite::Actions {
                kind: RuleKind::Underride,
                rule_id: rule_id.to_owned(),
                actions,
            },
            RuleWrite::Enabled {
                kind: RuleKind::Underride,
                rule_id: rule_id.to_owned(),
                enabled: true,
            },
        ],
    }
}

fn is_rtc_rule(rule_id: &str) -> bool {
    RTC_SERVER_USER_RULES.contains(&rule_id)
        || RTC_SERVER_ROOM_RULES.contains(&rule_id)
        || RTC_INVITE_TYPES
            .iter()
            .any(|(_, user, room)| *user == rule_id || *room == rule_id)
}

fn rtc_server_rule<'a>(
    rules: &'a Ruleset,
    user: bool,
    event_type: Option<&str>,
) -> Option<&'a matrix_sdk::ruma::push::ConditionalPushRule> {
    let ids = if user {
        &RTC_SERVER_USER_RULES
    } else {
        &RTC_SERVER_ROOM_RULES
    };
    ids.iter()
        .filter_map(|id| rules.override_.get(*id))
        .find(|rule| {
            event_type.is_none_or(|event_type| {
                rule.conditions.iter().any(|condition| match condition {
                    PushCondition::EventPropertyIs(data) => {
                        data.key == "type"
                            && data.value == ScalarJsonValue::String(event_type.to_owned())
                    }
                    PushCondition::EventMatch(data) => {
                        data.key == "type" && data.pattern == event_type
                    }
                    _ => false,
                })
            })
        })
}

fn align_rtc_invites(rules: &Ruleset) -> Vec<RuleWrite> {
    let mut writes = Vec::new();
    if rules.override_.get(RING_ONE_TO_ONE).is_some() {
        writes.push(RuleWrite::Delete {
            kind: RuleKind::Override,
            rule_id: RING_ONE_TO_ONE.to_owned(),
        });
    }
    let user_condition = rules
        .override_
        .get(PredefinedOverrideRuleId::IsUserMention.as_str())
        .or_else(|| rtc_server_rule(rules, true, None))
        .and_then(|rule| {
            rule.conditions.iter().find(|condition| {
                matches!(condition, PushCondition::EventPropertyContains(data)
                if data.key == "content.m\\.mentions.user_ids")
            })
        })
        .cloned();
    let mut after = rules
        .override_
        .iter()
        .rev()
        .find(|rule| {
            !rule.default
                && rule.rule_id != RING_ONE_TO_ONE
                && !is_rtc_rule(&rule.rule_id)
                && !RTC_INVITE_GUARDS.iter().any(|(_, id)| *id == rule.rule_id)
        })
        .map(|rule| rule.rule_id.clone());
    for (event_type, user_id, room_id) in RTC_INVITE_TYPES {
        for (user, rule_id) in [(true, user_id), (false, room_id)] {
            let Some(conditions) = rtc_invite_conditions(event_type, user, user_condition.as_ref())
            else {
                continue;
            };
            let source = rtc_server_rule(rules, user, Some(event_type))
                .or_else(|| rtc_server_rule(rules, user, None));
            let actions = source.map_or_else(
                || {
                    if event_notifies(rules, EventNotificationView::Calls).unwrap_or(true) {
                        event_actions(EventNotificationView::Calls)
                    } else {
                        vec![]
                    }
                },
                |rule| rule.actions.clone(),
            );
            let enabled = source.is_none_or(|rule| rule.enabled);
            let existing = rules.override_.get(rule_id);
            match existing {
                None => {
                    let rule = NewPushRule::Override(NewConditionalPushRule::new(
                        rule_id.to_owned(),
                        conditions,
                        actions,
                    ));
                    writes.push(match &after {
                        Some(after) => RuleWrite::PutAfter {
                            rule,
                            after: after.clone(),
                        },
                        None => RuleWrite::Put(rule),
                    });
                }
                Some(rule) => {
                    if serde_json::to_value(&rule.conditions).ok()
                        != serde_json::to_value(&conditions).ok()
                    {
                        writes.push(RuleWrite::Put(NewPushRule::Override(
                            NewConditionalPushRule::new(
                                rule_id.to_owned(),
                                conditions,
                                actions.clone(),
                            ),
                        )));
                    } else if serde_json::to_value(&rule.actions).ok()
                        != serde_json::to_value(&actions).ok()
                    {
                        writes.push(RuleWrite::Actions {
                            kind: RuleKind::Override,
                            rule_id: rule_id.to_owned(),
                            actions,
                        });
                    }
                }
            }
            if existing.is_none_or(|rule| rule.enabled) != enabled {
                writes.push(RuleWrite::Enabled {
                    kind: RuleKind::Override,
                    rule_id: rule_id.to_owned(),
                    enabled,
                });
            }
            after = Some(rule_id.to_owned());
        }
    }
    writes.extend(align_invite_guards(rules, after));
    writes
}

fn rtc_invite_conditions(
    event_type: &str,
    user: bool,
    user_condition: Option<&PushCondition>,
) -> Option<Vec<PushCondition>> {
    let mut conditions = vec![PushCondition::EventPropertyIs(
        EventPropertyIsConditionData::new(
            "type".to_owned(),
            ScalarJsonValue::String(event_type.to_owned()),
        ),
    )];
    if user {
        conditions.push(user_condition?.clone());
    } else {
        conditions.extend([
            PushCondition::EventPropertyIs(EventPropertyIsConditionData::new(
                "content.m\\.mentions.room".to_owned(),
                ScalarJsonValue::Bool(true),
            )),
            PushCondition::SenderNotificationPermission(
                SenderNotificationPermissionConditionData::new("room".into()),
            ),
        ]);
    }
    Some(conditions)
}

fn align_invite_guards(rules: &Ruleset, mut after: Option<String>) -> Vec<RuleWrite> {
    let mut writes = Vec::new();
    // Invalid invites and withdrawals must not reach broad room rules.
    for (event_type, rule_id) in RTC_INVITE_GUARDS {
        let existing = rules.override_.get(rule_id);
        if existing.is_none_or(|rule| !rule.actions.is_empty()) {
            let rule = NewPushRule::Override(NewConditionalPushRule::new(
                rule_id.to_owned(),
                vec![PushCondition::EventPropertyIs(
                    EventPropertyIsConditionData::new(
                        "type".to_owned(),
                        ScalarJsonValue::String(event_type.to_owned()),
                    ),
                )],
                vec![],
            ));
            writes.push(match &after {
                Some(after) => RuleWrite::PutAfter {
                    rule,
                    after: after.clone(),
                },
                None => RuleWrite::Put(rule),
            });
        }
        if existing.is_some_and(|rule| !rule.enabled) {
            writes.push(RuleWrite::Enabled {
                kind: RuleKind::Override,
                rule_id: rule_id.to_owned(),
                enabled: true,
            });
        }
        after = Some(rule_id.to_owned());
    }
    writes
}

fn silence_event_type(
    rules: &Ruleset,
    rule_id: &str,
    event_type: &str,
    covered_by: Option<&str>,
) -> Option<RuleWrite> {
    let has = |id: &str| rules.override_.iter().find(|rule| rule.rule_id == id);
    match has(rule_id) {
        Some(rule) if rule.enabled => None,
        Some(_) => Some(RuleWrite::Enabled {
            kind: RuleKind::Override,
            rule_id: rule_id.to_owned(),
            enabled: true,
        }),
        None if covered_by.is_some_and(|id| has(id).is_some()) => None,
        None => Some(RuleWrite::Put(NewPushRule::Override(
            NewConditionalPushRule::new(
                rule_id.to_owned(),
                vec![PushCondition::EventMatch(EventMatchConditionData::new(
                    "type".to_owned(),
                    event_type.to_owned(),
                ))],
                vec![],
            ),
        ))),
    }
}

const ENCRYPTED_EVENT_RULES: [&str; 2] = [
    ".m.rule.encrypted_event",
    ".org.matrix.msc4028.encrypted_event",
];

#[must_use]
pub fn pushes_every_encrypted_event(rules: &Ruleset) -> bool {
    rules.override_.iter().any(|rule| {
        rule.enabled
            && ENCRYPTED_EVENT_RULES.contains(&rule.rule_id.as_str())
            && notifies(&rule.actions)
    })
}

fn mention_rule(rules: &Ruleset, rule: MentionRuleView) -> Option<(RuleKind, String)> {
    #[expect(
        deprecated,
        reason = "the legacy room-notif rule is still matched on older servers"
    )]
    let candidates: &[(RuleKind, &str)] = match rule {
        MentionRuleView::Room => &[
            (
                RuleKind::Override,
                PredefinedOverrideRuleId::IsRoomMention.as_str(),
            ),
            (
                RuleKind::Override,
                PredefinedOverrideRuleId::RoomNotif.as_str(),
            ),
        ],
        MentionRuleView::User => &[(
            RuleKind::Override,
            PredefinedOverrideRuleId::IsUserMention.as_str(),
        )],
        MentionRuleView::DisplayName => &[(
            RuleKind::Override,
            PredefinedOverrideRuleId::ContainsDisplayName.as_str(),
        )],
        MentionRuleView::Username => &[(
            RuleKind::Content,
            PredefinedContentRuleId::ContainsUserName.as_str(),
        )],
    };
    candidates
        .iter()
        .find(|(kind, rule_id)| rules.get(kind.clone(), rule_id).is_some())
        .map(|(kind, rule_id)| (kind.clone(), (*rule_id).to_owned()))
}

fn mention_level(rules: &Ruleset, rule: MentionRuleView) -> Option<MentionNotificationModeView> {
    let (kind, rule_id) = mention_rule(rules, rule)?;
    rules
        .get(kind, rule_id)
        .map(|rule| level(rule.enabled(), rule.actions()))
}

#[must_use]
pub fn mention_notifications(rules: &Ruleset) -> MentionNotificationsView {
    MentionNotificationsView {
        room: mention_level(rules, MentionRuleView::Room),
        user: mention_level(rules, MentionRuleView::User),
        display_name: mention_level(rules, MentionRuleView::DisplayName),
        username: mention_level(rules, MentionRuleView::Username),
    }
}

/// # Errors
///
/// When the server has no rule for this kind of mention.
pub fn plan_mention(
    rules: &Ruleset,
    rule: MentionRuleView,
    mode: MentionNotificationModeView,
) -> Result<Vec<RuleWrite>, CoreError> {
    let (kind, rule_id) =
        mention_rule(rules, rule).ok_or("the server has no rule for this mention")?;
    Ok(plan_level(kind, &rule_id, mode, true))
}

fn event_rule(rules: &Ruleset, event: EventNotificationView) -> Option<(RuleKind, String)> {
    let candidates = match event {
        EventNotificationView::Membership => {
            vec![(
                RuleKind::Override,
                PredefinedOverrideRuleId::MemberEvent.as_str(),
            )]
        }
        EventNotificationView::Reactions => vec![
            (
                RuleKind::Override,
                PredefinedOverrideRuleId::Reaction.as_str(),
            ),
            (RuleKind::Override, SUPPRESS_REACTIONS),
        ],
        EventNotificationView::Edits => {
            vec![(
                RuleKind::Override,
                PredefinedOverrideRuleId::SuppressEdits.as_str(),
            )]
        }
        EventNotificationView::Notices => {
            vec![(
                RuleKind::Override,
                PredefinedOverrideRuleId::SuppressNotices.as_str(),
            )]
        }
        EventNotificationView::Invites => {
            vec![(
                RuleKind::Override,
                PredefinedOverrideRuleId::InviteForMe.as_str(),
            )]
        }
        EventNotificationView::Calls => {
            let mut candidates = vec![(
                RuleKind::Underride,
                PredefinedUnderrideRuleId::Call.as_str(),
            )];
            candidates.extend(
                RTC_SERVER_USER_RULES
                    .into_iter()
                    .chain(RTC_SERVER_ROOM_RULES)
                    .chain(
                        RTC_INVITE_TYPES
                            .into_iter()
                            .flat_map(|(_, user, room)| [user, room]),
                    )
                    .map(|id| (RuleKind::Override, id)),
            );
            candidates
        }
    };
    candidates
        .into_iter()
        .find(|(kind, id)| rules.get(kind.clone(), id).is_some())
        .map(|(kind, id)| (kind, id.to_owned()))
}

fn event_actions(event: EventNotificationView) -> Vec<Action> {
    match event {
        EventNotificationView::Invites => vec![
            Action::Notify,
            Action::SetTweak(Tweak::Sound(SoundTweakValue::Default)),
        ],
        EventNotificationView::Calls => vec![
            Action::Notify,
            Action::SetTweak(Tweak::Sound("ring".into())),
        ],
        _ => vec![Action::Notify],
    }
}

fn event_notifies(rules: &Ruleset, event: EventNotificationView) -> Option<bool> {
    let (kind, rule_id) = event_rule(rules, event)?;
    rules.get(kind, &rule_id).map(rule_notifies)
}

#[must_use]
pub fn event_notifications(rules: &Ruleset) -> EventNotificationsView {
    EventNotificationsView {
        membership: event_notifies(rules, EventNotificationView::Membership),
        reactions: event_notifies(rules, EventNotificationView::Reactions),
        edits: event_notifies(rules, EventNotificationView::Edits),
        notices: event_notifies(rules, EventNotificationView::Notices),
        invites: event_notifies(rules, EventNotificationView::Invites),
        calls: event_notifies(rules, EventNotificationView::Calls),
    }
}

/// # Errors
///
/// When the server has no rule for this kind of event.
pub fn plan_event(
    rules: &Ruleset,
    event: EventNotificationView,
    enabled: bool,
) -> Result<Vec<RuleWrite>, CoreError> {
    let (kind, rule_id) =
        event_rule(rules, event).ok_or("the server has no rule for this kind of event")?;
    let mut targets = vec![(kind, rule_id)];
    if matches!(event, EventNotificationView::Calls) {
        for rule in rules
            .override_
            .iter()
            .filter(|rule| is_rtc_rule(&rule.rule_id) || rule.rule_id == RING_ONE_TO_ONE)
        {
            if !targets
                .iter()
                .any(|(kind, id)| *kind == RuleKind::Override && *id == rule.rule_id)
            {
                targets.push((RuleKind::Override, rule.rule_id.clone()));
            }
        }
    }
    Ok(targets
        .into_iter()
        .flat_map(|(kind, rule_id)| {
            [
                RuleWrite::Actions {
                    kind: kind.clone(),
                    rule_id: rule_id.clone(),
                    actions: if enabled {
                        event_actions(event)
                    } else {
                        vec![]
                    },
                },
                RuleWrite::Enabled {
                    kind,
                    rule_id,
                    enabled: true,
                },
            ]
        })
        .collect())
}

#[must_use]
pub fn master_muted(rules: &Ruleset) -> Option<bool> {
    rules
        .get(
            RuleKind::Override,
            PredefinedOverrideRuleId::Master.as_str(),
        )
        .map(ruma::push::AnyPushRuleRef::enabled)
}

#[must_use]
pub fn plan_master(muted: bool) -> Vec<RuleWrite> {
    vec![RuleWrite::Enabled {
        kind: RuleKind::Override,
        rule_id: PredefinedOverrideRuleId::Master.to_string(),
        enabled: muted,
    }]
}

#[must_use]
pub fn plan_membership(enabled: bool) -> Vec<RuleWrite> {
    let rule_id = PredefinedOverrideRuleId::MemberEvent.to_string();
    vec![
        RuleWrite::Actions {
            kind: RuleKind::Override,
            rule_id: rule_id.clone(),
            actions: if enabled {
                vec![Action::Notify]
            } else {
                vec![]
            },
        },
        RuleWrite::Enabled {
            kind: RuleKind::Override,
            rule_id,
            enabled: true,
        },
    ]
}

fn keyword_rules<'a>(rules: &'a Ruleset, keyword: &'a str) -> impl Iterator<Item = &'a str> {
    rules
        .content
        .iter()
        .filter(move |rule| !rule.default && rule.pattern == keyword)
        .map(|rule| rule.rule_id.as_str())
}

#[must_use]
pub fn keywords(rules: &Ruleset) -> Vec<KeywordNotificationView> {
    let mut keywords: Vec<KeywordNotificationView> = Vec::new();
    for rule in rules.content.iter().filter(|rule| !rule.default) {
        let mode = level(rule.enabled, &rule.actions);
        match keywords
            .iter_mut()
            .find(|entry| entry.keyword == rule.pattern)
        {
            Some(entry) if mode_rank(mode) > mode_rank(entry.mode) => entry.mode = mode,
            Some(_) => {}
            None => keywords.push(KeywordNotificationView {
                keyword: rule.pattern.clone(),
                mode,
            }),
        }
    }
    keywords.sort_unstable_by(|left, right| left.keyword.cmp(&right.keyword));
    keywords
}

const fn mode_rank(mode: MentionNotificationModeView) -> u8 {
    match mode {
        MentionNotificationModeView::Off => 0,
        MentionNotificationModeView::Notify => 1,
        MentionNotificationModeView::Loud => 2,
    }
}

fn keyword_rule_id(rules: &Ruleset, keyword: &str) -> String {
    let encoded = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(keyword);
    let base = format!("moe.sable.keyword.{encoded}");
    let mut id = base.clone();
    let mut suffix = 1_u64;
    while rules.content.iter().any(|rule| rule.rule_id == id) {
        id = format!("{base}.{suffix}");
        suffix += 1;
    }
    id
}

/// # Errors
///
/// When the keyword is blank.
pub fn plan_add_keyword(rules: &Ruleset, keyword: &str) -> Result<Vec<RuleWrite>, CoreError> {
    let pattern = keyword.trim();
    if pattern.is_empty() {
        return Err("a keyword cannot be blank".into());
    }
    if keyword_rules(rules, pattern).next().is_some() {
        return Ok(plan_keyword_mode(
            rules,
            pattern,
            MentionNotificationModeView::Notify,
        ));
    }
    let rule_id = keyword_rule_id(rules, pattern);
    Ok(vec![
        RuleWrite::Put(NewPushRule::Content(NewPatternedPushRule::new(
            rule_id.clone(),
            pattern.to_owned(),
            level_actions(MentionNotificationModeView::Notify, true),
        ))),
        RuleWrite::Enabled {
            kind: RuleKind::Content,
            rule_id,
            enabled: true,
        },
    ])
}

#[must_use]
pub fn plan_keyword_mode(
    rules: &Ruleset,
    keyword: &str,
    mode: MentionNotificationModeView,
) -> Vec<RuleWrite> {
    keyword_rules(rules, keyword)
        .flat_map(|rule_id| plan_level(RuleKind::Content, rule_id, mode, true))
        .collect()
}

#[must_use]
pub fn plan_remove_keyword(rules: &Ruleset, keyword: &str) -> Vec<RuleWrite> {
    keyword_rules(rules, keyword)
        .map(ToOwned::to_owned)
        .map(|rule_id| RuleWrite::Delete {
            kind: RuleKind::Content,
            rule_id,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use matrix_sdk::ruma::push::{
        ConditionalPushRule, NewPushRule, PredefinedOverrideRuleId, PredefinedUnderrideRuleId,
        RuleKind, Ruleset,
    };
    use matrix_sdk::ruma::{RoomId, room_id, user_id};
    use serde_json::json;

    use super::{
        RuleWrite, STICKER, STICKER_DIRECT, SUPPRESS_BRIDGE_STATUS, SUPPRESS_REACTIONS,
        default_modes, event_notifications, event_notifies, keywords, level_actions, master_muted,
        mention_notifications, plan_add_keyword, plan_alignment, plan_default_mode, plan_event,
        plan_keyword_mode, plan_master, plan_mention, plan_remove_keyword, plan_room_mode,
        plan_room_shapes, pushes_every_encrypted_event, room_mode, rule_notifies,
    };
    use crate::protocol::{
        EventNotificationView, MentionNotificationModeView, MentionRuleView, NotificationModeView,
    };

    fn describe(writes: &[RuleWrite]) -> Vec<String> {
        writes
            .iter()
            .map(|write| match write {
                RuleWrite::Put(rule) => {
                    let actions = match rule {
                        NewPushRule::Override(rule) | NewPushRule::Underride(rule) => &rule.actions,
                        NewPushRule::Content(rule) => &rule.actions,
                        NewPushRule::Room(rule) => &rule.actions,
                        NewPushRule::Sender(rule) => &rule.actions,
                        _ => panic!("an unexpected push rule kind"),
                    };
                    format!(
                        "put {} {}",
                        rule.rule_id(),
                        serde_json::to_value(actions).unwrap_or_default()
                    )
                }
                RuleWrite::Actions {
                    kind,
                    rule_id,
                    actions,
                } => format!(
                    "actions {kind} {rule_id} {}",
                    serde_json::to_value(actions).unwrap_or_default()
                ),
                RuleWrite::Enabled {
                    kind,
                    rule_id,
                    enabled,
                } => format!("enabled {kind} {rule_id} {enabled}"),
                RuleWrite::Delete { kind, rule_id } => format!("delete {kind} {rule_id}"),
                RuleWrite::PutAfter { rule, after } => {
                    format!("put {} after {after}", rule.rule_id())
                }
            })
            .collect()
    }

    fn applied(mut rules: Ruleset, writes: Vec<RuleWrite>) -> Ruleset {
        for write in writes {
            write.apply_to(&mut rules);
        }
        rules
    }

    fn me() -> &'static matrix_sdk::ruma::UserId {
        user_id!("@me:example.org")
    }

    #[test]
    fn a_room_mode_does_not_depend_on_what_the_cache_believed() {
        let room = room_id!("!r:example.org");
        let rules = Ruleset::server_default(me());

        assert_eq!(
            describe(&plan_room_mode(
                &rules,
                room,
                false,
                Some(NotificationModeView::All)
            )),
            vec![
                r#"put !r:example.org ["notify"]"#,
                "enabled room !r:example.org true",
                "delete override !r:example.org",
            ]
        );
        assert_eq!(
            describe(&plan_room_mode(&rules, room, false, None)),
            vec![
                "delete override !r:example.org",
                "delete room !r:example.org"
            ]
        );
    }

    #[test]
    fn a_room_rule_matching_the_default_is_still_an_explicit_choice() {
        let room = room_id!("!bridged:example.org");
        let rules = Ruleset::server_default(me());
        let chosen = applied(
            rules.clone(),
            plan_room_mode(&rules, room, true, Some(NotificationModeView::All)),
        );
        let settings = super::room_settings(&chosen, room, false);
        assert_eq!(settings.room, Some(NotificationModeView::All));
    }

    #[test]
    fn a_room_mode_round_trips_through_the_ruleset() {
        let room = room_id!("!r:example.org");
        let mut rules = Ruleset::server_default(me());
        for mode in [
            Some(NotificationModeView::Mute),
            Some(NotificationModeView::All),
            Some(NotificationModeView::Mentions),
            Some(NotificationModeView::Mute),
            None,
            Some(NotificationModeView::Mentions),
            Some(NotificationModeView::All),
        ] {
            rules = applied(rules.clone(), plan_room_mode(&rules, room, false, mode));
            assert_eq!(room_mode(&rules, room), mode);
        }
    }

    #[test]
    fn all_messages_in_a_room_rings_only_where_the_spec_default_does() {
        let room = room_id!("!r:example.org");
        let rules = Ruleset::server_default(me());

        assert_eq!(
            describe(&plan_room_mode(
                &rules,
                room,
                false,
                Some(NotificationModeView::All)
            ))[0],
            r#"put !r:example.org ["notify"]"#
        );
        assert_eq!(
            describe(&plan_room_mode(
                &rules,
                room,
                true,
                Some(NotificationModeView::All)
            ))[0],
            r#"put !r:example.org ["notify",{"set_tweak":"sound","value":"default"}]"#
        );
    }

    #[test]
    fn a_mute_from_another_client_under_its_own_id_is_cleared() {
        let room = room_id!("!r:example.org");
        let mut rules = Ruleset::server_default(me());
        rules.override_.insert(
            serde_json::from_value::<ConditionalPushRule>(json!({
                "rule_id": "other-client-mute",
                "default": false,
                "enabled": true,
                "conditions": [{"kind": "event_match", "key": "room_id", "pattern": "!r:example.org"}],
                "actions": [],
            }))
            .unwrap(),
        );
        assert_eq!(room_mode(&rules, room), Some(NotificationModeView::Mute));

        let rules = applied(rules.clone(), plan_room_mode(&rules, room, false, None));

        assert_eq!(room_mode(&rules, room), None);
    }

    #[test]
    fn a_disabled_room_rule_is_not_the_room_mode() {
        let room = room_id!("!r:example.org");
        let mut rules = Ruleset::server_default(me());
        rules = applied(
            rules.clone(),
            plan_room_mode(&rules, room, false, Some(NotificationModeView::All)),
        );
        rules
            .set_enabled(RuleKind::Room, room.as_str(), false)
            .unwrap();

        assert_eq!(room_mode(&rules, room), None);
    }

    #[test]
    fn a_default_switched_back_to_all_restores_the_spec_actions() {
        let rules = Ruleset::server_default(me());
        let mentions = applied(
            rules.clone(),
            plan_default_mode(&rules, false, NotificationModeView::Mentions).unwrap(),
        );
        assert_eq!(
            default_modes(&mentions).group,
            NotificationModeView::Mentions
        );

        let all = applied(
            mentions.clone(),
            plan_default_mode(&mentions, false, NotificationModeView::All).unwrap(),
        );

        assert_eq!(default_modes(&all).group, NotificationModeView::All);
        for rule_id in [
            PredefinedUnderrideRuleId::Message,
            PredefinedUnderrideRuleId::Encrypted,
            PredefinedUnderrideRuleId::PollStart,
            PredefinedUnderrideRuleId::PollEnd,
        ] {
            let actions = |rules: &Ruleset| {
                serde_json::to_value(
                    rules
                        .get(RuleKind::Underride, rule_id.as_str())
                        .unwrap()
                        .actions(),
                )
                .unwrap()
            };
            assert_eq!(
                actions(&all),
                actions(&rules),
                "{rule_id} should be back to its spec default"
            );
        }
    }

    #[test]
    fn a_default_is_refused_where_the_server_has_no_rule() {
        let mut rules = Ruleset::server_default(me());
        rules.underride.clear();

        plan_default_mode(&rules, false, NotificationModeView::All).unwrap_err();
    }

    #[test]
    fn a_default_left_notifying_for_encrypted_rooms_is_aligned() {
        let defaults = Ruleset::server_default(me());
        let mut rules = applied(defaults.clone(), plan_alignment(&defaults));
        assert!(plan_alignment(&rules).is_empty());

        rules
            .set_actions(
                RuleKind::Underride,
                PredefinedUnderrideRuleId::Message.as_str(),
                vec![],
            )
            .unwrap();
        rules
            .set_enabled(
                RuleKind::Underride,
                PredefinedUnderrideRuleId::EncryptedRoomOneToOne.as_str(),
                false,
            )
            .unwrap();

        assert_eq!(
            describe(&plan_alignment(&rules)),
            vec![
                r#"actions underride .m.rule.encrypted_room_one_to_one ["notify",{"set_tweak":"sound","value":"default"}]"#,
                "enabled underride .m.rule.encrypted_room_one_to_one true",
                "actions underride .m.rule.encrypted []",
                "enabled underride .m.rule.encrypted true",
                "actions underride moe.sable.sticker []",
                "enabled underride moe.sable.sticker true",
            ]
        );
        let aligned = applied(rules.clone(), plan_alignment(&rules));
        assert!(plan_alignment(&aligned).is_empty());
    }

    #[test]
    fn stickers_notify_exactly_where_messages_do() {
        let defaults = Ruleset::server_default(me());
        let mut rules = applied(defaults.clone(), plan_alignment(&defaults));
        for mode in [NotificationModeView::Mentions, NotificationModeView::All] {
            for direct in [false, true] {
                rules = applied(
                    rules.clone(),
                    plan_default_mode(&rules, direct, mode).unwrap(),
                );
                let sticker = rules
                    .get(
                        RuleKind::Underride,
                        if direct { STICKER_DIRECT } else { STICKER },
                    )
                    .unwrap();
                assert_eq!(rule_notifies(sticker), mode == NotificationModeView::All);
            }
        }
        assert!(plan_alignment(&rules).is_empty());
    }

    #[test]
    fn a_direct_sticker_rule_ranks_above_the_group_one() {
        let defaults = Ruleset::server_default(me());
        let rules = applied(defaults.clone(), plan_alignment(&defaults));
        let position = |id: &str| rules.underride.iter().position(|rule| rule.rule_id == id);

        assert!(position(STICKER_DIRECT) < position(STICKER));
    }

    #[tokio::test]
    async fn a_room_set_to_all_messages_ignores_room_changes_but_not_messages() {
        use matrix_sdk::ruma::push::PushConditionRoomCtx;
        use matrix_sdk::ruma::serde::Raw;

        let room = room_id!("!ann:example.org");
        let defaults = Ruleset::server_default(me());
        let mut rules = applied(defaults.clone(), plan_alignment(&defaults));
        rules = applied(
            rules.clone(),
            plan_room_mode(&rules, room, false, Some(NotificationModeView::All)),
        );
        let context = PushConditionRoomCtx::new(
            room.to_owned(),
            3_u8.into(),
            me().to_owned(),
            "me".to_owned(),
        );
        let notifies_for = async |event_type: &str, content: serde_json::Value| {
            let event = Raw::new(&json!({
                "type": event_type, "event_id": "$e", "sender": "@them:example.org",
                "origin_server_ts": 0, "content": content,
            }))
            .unwrap();
            super::notifies(rules.get_actions(&event, &context).await)
        };

        assert!(notifies_for("m.room.message", json!({"msgtype": "m.text", "body": "hi"})).await);
        for event_type in super::SUPPRESSED_ROOM_EVENTS {
            assert!(!notifies_for(event_type, json!({})).await, "{event_type}");
        }
        assert!(plan_alignment(&rules).is_empty());
    }

    async fn notifies_in(rules: &Ruleset, room: &RoomId, members: u8) -> bool {
        use matrix_sdk::ruma::push::PushConditionRoomCtx;
        use matrix_sdk::ruma::serde::Raw;

        let context = PushConditionRoomCtx::new(
            room.to_owned(),
            members.into(),
            me().to_owned(),
            "me".to_owned(),
        );
        let event = Raw::new(&json!({
            "type": "m.room.message", "event_id": "$e", "room_id": room,
            "sender": "@them:example.org", "origin_server_ts": 0,
            "content": {"msgtype": "m.text", "body": "hi"},
        }))
        .unwrap();
        super::notifies(rules.get_actions(&event, &context).await)
    }

    async fn rings_in(rules: &Ruleset, room: &RoomId, members: u8) -> bool {
        use matrix_sdk::ruma::power_levels::NotificationPowerLevels;
        use matrix_sdk::ruma::push::{PushConditionPowerLevelsCtx, PushConditionRoomCtx};
        use matrix_sdk::ruma::room_version_rules::{AuthorizationRules, RoomPowerLevelsRules};
        use matrix_sdk::ruma::serde::Raw;

        let context = PushConditionRoomCtx::new(
            room.to_owned(),
            members.into(),
            me().to_owned(),
            "me".to_owned(),
        )
        .with_power_levels(PushConditionPowerLevelsCtx::new(
            std::collections::BTreeMap::new(),
            0.into(),
            NotificationPowerLevels::new(),
            RoomPowerLevelsRules::new(&AuthorizationRules::V1, None),
        ));
        let event = Raw::new(&json!({
            "type": crate::calls::NOTIFICATION_EVENT_TYPE, "event_id": "$e", "room_id": room,
            "sender": "@them:example.org", "origin_server_ts": 0,
            "content": {"notification_type": "ring", "m.mentions": {"user_ids": [me()]}, "sender_ts": 0, "lifetime": 30000},
        }))
        .unwrap();
        super::notifies(rules.get_actions(&event, &context).await)
    }

    fn aligned() -> Ruleset {
        let defaults = Ruleset::server_default(me());
        applied(defaults.clone(), plan_alignment(&defaults))
    }

    #[tokio::test]
    async fn a_named_invitation_does_not_depend_on_room_size() {
        let room = room_id!("!call:example.org");
        let rules = aligned();
        assert!(rings_in(&rules, room, 2).await);
        assert!(rings_in(&rules, room, 5).await);
        assert!(plan_alignment(&rules).is_empty());
    }

    #[tokio::test]
    async fn a_one_to_one_ring_follows_the_room_and_calls_settings() {
        let room = room_id!("!call:example.org");
        let rules = aligned();

        let mentions = applied(
            rules.clone(),
            plan_room_mode(&rules, room, true, Some(NotificationModeView::Mentions)),
        );
        assert!(rings_in(&mentions, room, 2).await);

        let muted = applied(
            rules.clone(),
            plan_room_mode(&rules, room, true, Some(NotificationModeView::Mute)),
        );
        assert!(!rings_in(&muted, room, 2).await);

        let off = applied(
            rules.clone(),
            plan_event(&rules, EventNotificationView::Calls, false).unwrap(),
        );
        assert!(!rings_in(&off, room, 2).await);
        assert!(plan_alignment(&off).is_empty());
    }

    #[tokio::test]
    async fn a_room_muted_before_the_ring_rule_existed_stays_muted() {
        let room = room_id!("!call:example.org");
        let defaults = Ruleset::server_default(me());
        let muted = applied(
            defaults.clone(),
            plan_room_mode(&defaults, room, true, Some(NotificationModeView::Mute)),
        );

        let rules = applied(muted.clone(), plan_alignment(&muted));
        assert!(!rings_in(&rules, room, 2).await);
        assert!(rings_in(&rules, room_id!("!other:example.org"), 2).await);
    }

    fn mentions_for_direct_only() -> Ruleset {
        let defaults = Ruleset::server_default(me());
        let rules = applied(defaults.clone(), plan_alignment(&defaults));
        applied(
            rules.clone(),
            plan_default_mode(&rules, true, NotificationModeView::Mentions).unwrap(),
        )
    }

    #[tokio::test]
    async fn a_flagged_room_with_three_members_follows_the_direct_default() {
        let room = room_id!("!bridged:example.org");
        let rules = mentions_for_direct_only();
        assert!(notifies_in(&rules, room, 3).await);

        let shaped = applied(
            rules.clone(),
            plan_room_shapes(&rules, &[(room.to_owned(), true)]),
        );

        assert!(!notifies_in(&shaped, room, 3).await);
        assert!(notifies_in(&shaped, room_id!("!other:example.org"), 3).await);
        assert!(plan_room_shapes(&shaped, &[(room.to_owned(), true)]).is_empty());
    }

    #[tokio::test]
    async fn an_unflagged_pair_follows_the_group_default() {
        let room = room_id!("!pair:example.org");
        let rules = mentions_for_direct_only();
        assert!(!notifies_in(&rules, room, 2).await);

        let shaped = applied(
            rules.clone(),
            plan_room_shapes(&rules, &[(room.to_owned(), false)]),
        );

        assert!(notifies_in(&shaped, room, 2).await);
    }

    #[tokio::test]
    async fn room_copies_follow_the_default_and_go_with_the_room() {
        let room = room_id!("!bridged:example.org");
        let rules = mentions_for_direct_only();
        let shaped = applied(
            rules.clone(),
            plan_room_shapes(&rules, &[(room.to_owned(), true)]),
        );

        let louder = applied(
            shaped.clone(),
            plan_default_mode(&shaped, true, NotificationModeView::All).unwrap(),
        );
        let followed = applied(
            louder.clone(),
            plan_room_shapes(&louder, &[(room.to_owned(), true)]),
        );
        assert!(notifies_in(&followed, room, 3).await);

        let gone = applied(followed.clone(), plan_room_shapes(&followed, &[]));
        assert!(
            gone.underride
                .iter()
                .all(|rule| !rule.rule_id.starts_with(super::SHAPE_PREFIX))
        );
    }

    #[tokio::test]
    async fn a_room_mode_survives_and_keeps_the_room_copies() {
        let room = room_id!("!bridged:example.org");
        let rules = mentions_for_direct_only();
        let shaped = applied(
            rules.clone(),
            plan_room_shapes(&rules, &[(room.to_owned(), true)]),
        );

        let chosen = applied(
            shaped.clone(),
            plan_room_mode(&shaped, room, true, Some(NotificationModeView::All)),
        );

        assert!(notifies_in(&chosen, room, 3).await);
        assert!(plan_room_shapes(&chosen, &[(room.to_owned(), true)]).is_empty());
    }

    #[test]
    fn bridge_status_rule_is_enabled_without_rewriting() {
        let defaults = Ruleset::server_default(me());
        let mut rules = applied(defaults.clone(), plan_alignment(&defaults));
        assert!(plan_alignment(&rules).is_empty());

        rules
            .set_enabled(RuleKind::Override, SUPPRESS_BRIDGE_STATUS, false)
            .unwrap();
        let aligned = applied(rules.clone(), plan_alignment(&rules));
        assert!(
            aligned
                .get(RuleKind::Override, SUPPRESS_BRIDGE_STATUS)
                .unwrap()
                .enabled()
        );
        assert!(plan_alignment(&aligned).is_empty());
    }

    #[test]
    fn reactions_are_silenced_only_when_the_account_lacks_the_default_rule() {
        let defaults = Ruleset::server_default(me());
        let kept = applied(defaults.clone(), plan_alignment(&defaults));
        assert!(kept.get(RuleKind::Override, SUPPRESS_REACTIONS).is_none());

        let mut old = defaults;
        old.override_
            .retain(|rule| rule.rule_id != PredefinedOverrideRuleId::Reaction.as_str());
        let aligned = applied(old.clone(), plan_alignment(&old));
        assert!(
            aligned
                .get(RuleKind::Override, SUPPRESS_REACTIONS)
                .is_some()
        );
        assert!(plan_alignment(&aligned).is_empty());
    }

    #[test]
    fn mention_levels_write_highlighting_actions() {
        assert_eq!(
            serde_json::to_value(level_actions(MentionNotificationModeView::Notify, true)).unwrap(),
            json!(["notify", {"set_tweak": "highlight"}])
        );
        assert_eq!(
            serde_json::to_value(level_actions(MentionNotificationModeView::Loud, true)).unwrap(),
            json!(["notify", {"set_tweak": "sound", "value": "default"}, {"set_tweak": "highlight"}])
        );
        assert_eq!(
            serde_json::to_value(level_actions(MentionNotificationModeView::Off, true)).unwrap(),
            json!([])
        );
    }

    #[test]
    fn a_mention_turned_off_is_disabled_and_turned_on_is_rewritten_then_enabled() {
        let rules = Ruleset::server_default(me());

        assert_eq!(
            describe(
                &plan_mention(
                    &rules,
                    MentionRuleView::User,
                    MentionNotificationModeView::Off
                )
                .unwrap()
            ),
            vec!["enabled override .m.rule.is_user_mention false"]
        );
        let off = applied(
            rules.clone(),
            plan_mention(
                &rules,
                MentionRuleView::User,
                MentionNotificationModeView::Off,
            )
            .unwrap(),
        );
        assert_eq!(
            mention_notifications(&off).user,
            Some(MentionNotificationModeView::Off)
        );

        let on = applied(
            off.clone(),
            plan_mention(
                &off,
                MentionRuleView::User,
                MentionNotificationModeView::Notify,
            )
            .unwrap(),
        );
        assert_eq!(
            mention_notifications(&on).user,
            Some(MentionNotificationModeView::Notify)
        );
    }

    #[test]
    fn room_mentions_fall_back_to_the_legacy_rule_and_absent_rules_hide() {
        let mut rules = Ruleset::server_default(me());
        let view = mention_notifications(&rules);
        assert_eq!(view.room, Some(MentionNotificationModeView::Notify));
        assert_eq!(view.user, Some(MentionNotificationModeView::Loud));
        assert_eq!(view.display_name, None);
        assert_eq!(view.username, None);

        rules
            .override_
            .shift_remove(PredefinedOverrideRuleId::IsRoomMention.as_str());
        rules.override_.insert(
            serde_json::from_value::<ConditionalPushRule>(json!({
                "rule_id": ".m.rule.roomnotif",
                "default": true,
                "enabled": true,
                "conditions": [{"kind": "event_match", "key": "content.body", "pattern": "@room"}],
                "actions": ["notify", {"set_tweak": "highlight"}],
            }))
            .unwrap(),
        );
        assert_eq!(
            describe(
                &plan_mention(
                    &rules,
                    MentionRuleView::Room,
                    MentionNotificationModeView::Off
                )
                .unwrap()
            ),
            vec!["enabled override .m.rule.roomnotif false"]
        );

        rules.override_.clear();
        assert_eq!(mention_notifications(&rules).room, None);
        plan_mention(
            &rules,
            MentionRuleView::Room,
            MentionNotificationModeView::Off,
        )
        .unwrap_err();
    }

    #[test]
    fn the_master_rule_reads_as_muted_only_while_enabled() {
        let mut rules = Ruleset::server_default(me());
        assert_eq!(master_muted(&rules), Some(false));

        rules = applied(rules.clone(), plan_master(true));
        assert_eq!(master_muted(&rules), Some(true));

        rules = applied(rules.clone(), plan_master(false));
        assert_eq!(master_muted(&rules), Some(false));

        rules.override_.clear();
        assert_eq!(master_muted(&rules), None);
    }

    #[test]
    fn each_event_rule_reads_as_on_only_while_it_notifies() {
        use EventNotificationView::{Calls, Edits, Invites, Membership, Notices, Reactions};

        let defaults = Ruleset::server_default(me());
        let read = |rules: &Ruleset| {
            let view = event_notifications(rules);
            [
                view.membership,
                view.reactions,
                view.edits,
                view.notices,
                view.invites,
                view.calls,
            ]
        };
        assert_eq!(
            read(&defaults),
            [
                Some(false),
                Some(false),
                Some(false),
                Some(false),
                Some(true),
                Some(true)
            ]
        );

        for event in [Membership, Reactions, Edits, Notices, Invites, Calls] {
            let on = applied(
                defaults.clone(),
                plan_event(&defaults, event, true).unwrap(),
            );
            assert_eq!(event_notifies(&on, event), Some(true));
            let off = applied(on.clone(), plan_event(&on, event, false).unwrap());
            assert_eq!(event_notifies(&off, event), Some(false));
        }
    }

    #[test]
    fn turning_an_event_back_on_restores_the_spec_actions() {
        let defaults = Ruleset::server_default(me());
        let off = applied(
            defaults.clone(),
            plan_event(&defaults, EventNotificationView::Calls, false).unwrap(),
        );
        let on = applied(
            off.clone(),
            plan_event(&off, EventNotificationView::Calls, true).unwrap(),
        );
        let actions = |rules: &Ruleset| {
            serde_json::to_value(
                rules
                    .get(
                        RuleKind::Underride,
                        PredefinedUnderrideRuleId::Call.as_str(),
                    )
                    .unwrap()
                    .actions(),
            )
            .unwrap()
        };
        assert_eq!(actions(&on), actions(&defaults));
    }

    #[test]
    fn a_reaction_toggle_falls_back_to_the_rule_alignment_added() {
        let mut rules = Ruleset::server_default(me());
        rules
            .override_
            .retain(|rule| rule.rule_id != PredefinedOverrideRuleId::Reaction.as_str());
        assert_eq!(event_notifications(&rules).reactions, None);

        let aligned = applied(rules.clone(), plan_alignment(&rules));
        assert_eq!(event_notifications(&aligned).reactions, Some(false));
        let on = applied(
            aligned.clone(),
            plan_event(&aligned, EventNotificationView::Reactions, true).unwrap(),
        );
        assert_eq!(event_notifications(&on).reactions, Some(true));
        assert!(plan_alignment(&on).is_empty());
    }

    #[test]
    fn a_missing_event_rule_has_no_state_and_no_plan() {
        let mut rules = Ruleset::server_default(me());
        rules.override_.clear();
        assert_eq!(event_notifications(&rules).membership, None);
        plan_event(&rules, EventNotificationView::Membership, true).unwrap_err();
    }

    #[test]
    fn a_keyword_disabled_elsewhere_is_listed_and_re_enabled_by_adding_it() {
        let mut rules = Ruleset::server_default(me());
        rules.content.insert(
            serde_json::from_value(json!({
                "rule_id": "keyword-1",
                "pattern": "sable",
                "default": false,
                "enabled": false,
                "actions": ["notify"],
            }))
            .unwrap(),
        );
        assert_eq!(keywords(&rules)[0].mode, MentionNotificationModeView::Off);

        let rules = applied(rules.clone(), plan_add_keyword(&rules, " sable ").unwrap());

        assert_eq!(keywords(&rules).len(), 1);
        assert_eq!(
            keywords(&rules)[0].mode,
            MentionNotificationModeView::Notify
        );
    }

    #[test]
    fn a_new_keyword_notifies_with_a_highlight_under_a_valid_rule_id() {
        let rules = Ruleset::server_default(me());

        assert_eq!(
            describe(&plan_add_keyword(&rules, ".net").unwrap()),
            vec![
                r#"put moe.sable.keyword.Lm5ldA ["notify",{"set_tweak":"highlight"}]"#,
                "enabled content moe.sable.keyword.Lm5ldA true",
            ]
        );
        let rules = applied(rules.clone(), plan_add_keyword(&rules, "a/b").unwrap());
        assert_eq!(keywords(&rules)[0].keyword, "a/b");
        plan_add_keyword(&rules, "  ").unwrap_err();
    }

    #[test]
    fn distinct_keywords_never_replace_each_other() {
        let mut rules = Ruleset::server_default(me());
        let patterns = ["a/b", "a_b", "a\\b", ".alert", "keyword.alert", "café"];
        for pattern in patterns {
            let writes = plan_add_keyword(&rules, pattern).unwrap();
            rules = applied(rules, writes);
        }
        for pattern in patterns {
            assert_eq!(
                rules
                    .content
                    .iter()
                    .filter(|rule| rule.pattern == pattern)
                    .count(),
                1
            );
        }
        let removed = applied(rules.clone(), plan_remove_keyword(&rules, "a/b"));
        assert!(
            !keywords(&removed)
                .iter()
                .any(|entry| entry.keyword == "a/b")
        );
        assert!(
            keywords(&removed)
                .iter()
                .any(|entry| entry.keyword == "a_b")
        );
        assert!(plan_remove_keyword(&removed, "a/b").is_empty());
    }

    #[test]
    fn a_reserved_keyword_id_keeps_the_existing_rule() {
        let mut rules = Ruleset::server_default(me());
        rules.content.insert(
            serde_json::from_value(json!({
                "rule_id": "moe.sable.keyword.YS9i", "pattern": "other", "default": false,
                "enabled": true, "actions": ["notify"]
            }))
            .unwrap(),
        );
        let writes = plan_add_keyword(&rules, "a/b").unwrap();
        let updated = applied(rules, writes);
        assert_eq!(
            updated
                .content
                .iter()
                .find(|rule| rule.rule_id == "moe.sable.keyword.YS9i")
                .unwrap()
                .pattern,
            "other"
        );
        assert!(updated.content.iter().any(|rule| rule.pattern == "a/b"));
    }

    #[test]
    fn a_keyword_level_and_removal_reach_every_rule_carrying_it() {
        let mut rules = Ruleset::server_default(me());
        for id in ["one", "two"] {
            rules.content.insert(
                serde_json::from_value(json!({
                    "rule_id": id, "pattern": "sable", "default": false, "enabled": true,
                    "actions": ["notify"],
                }))
                .unwrap(),
            );
        }

        let loud = applied(
            rules.clone(),
            plan_keyword_mode(&rules, "sable", MentionNotificationModeView::Loud),
        );
        assert_eq!(keywords(&loud)[0].mode, MentionNotificationModeView::Loud);

        let removed = applied(loud.clone(), plan_remove_keyword(&loud, "sable"));
        assert_eq!(
            keywords(&removed),
            [] as [crate::protocol::KeywordNotificationView; 0]
        );
        assert!(plan_remove_keyword(&removed, "other").is_empty());
    }

    #[test]
    fn the_msc4028_rule_is_detected_only_while_it_notifies() {
        let mut rules = Ruleset::server_default(me());
        assert!(!pushes_every_encrypted_event(&rules));

        let rule = |enabled: bool, actions: serde_json::Value| {
            serde_json::from_value::<ConditionalPushRule>(json!({
                "rule_id": ".org.matrix.msc4028.encrypted_event",
                "default": true,
                "enabled": enabled,
                "conditions": [{"kind": "event_match", "key": "type", "pattern": "m.room.encrypted"}],
                "actions": actions,
            }))
            .unwrap()
        };

        rules.override_.insert(rule(true, json!(["notify"])));
        assert!(pushes_every_encrypted_event(&rules));

        rules
            .override_
            .shift_remove(".org.matrix.msc4028.encrypted_event");
        rules.override_.insert(rule(false, json!(["notify"])));
        assert!(!pushes_every_encrypted_event(&rules));

        rules
            .override_
            .shift_remove(".org.matrix.msc4028.encrypted_event");
        rules.override_.insert(rule(true, json!([])));
        assert!(!pushes_every_encrypted_event(&rules));
    }

    async fn invite_actions(
        rules: &Ruleset,
        event_type: &str,
        mentions: serde_json::Value,
        sender_power: i8,
    ) -> Vec<super::Action> {
        use matrix_sdk::ruma::power_levels::NotificationPowerLevels;
        use matrix_sdk::ruma::push::{PushConditionPowerLevelsCtx, PushConditionRoomCtx};
        use matrix_sdk::ruma::room_version_rules::{AuthorizationRules, RoomPowerLevelsRules};
        use matrix_sdk::ruma::serde::Raw;

        let context = PushConditionRoomCtx::new(
            room_id!("!call:example.org").to_owned(),
            5_u8.into(),
            me().to_owned(),
            "me".to_owned(),
        )
        .with_power_levels(PushConditionPowerLevelsCtx::new(
            std::collections::BTreeMap::new(),
            sender_power.into(),
            NotificationPowerLevels::new(),
            RoomPowerLevelsRules::new(&AuthorizationRules::V1, None),
        ));
        let event = Raw::new(&json!({
            "type": event_type, "event_id": "$announcement", "sender": "@caller:example.org",
            "room_id": "!call:example.org", "origin_server_ts": 1000,
            "content": {
                "slot_id": "m.call#room", "sender_ts": 1000, "lifetime": 90000,
                "notification_type": "notification", "m.mentions": mentions,
                "m.relates_to": {"rel_type": "m.reference", "event_id": "$membership"},
                "m.text": [{"body": "Call started"}]
            }
        }))
        .unwrap();
        rules.get_actions(&event, &context).await.to_vec()
    }

    #[tokio::test]
    async fn call_announcements_notify_without_becoming_mentions() {
        let rules = aligned();
        for (event_type, _, _) in super::RTC_INVITE_TYPES {
            let actions = invite_actions(&rules, event_type, json!({"room": true}), 100).await;
            assert!(super::notifies(&actions), "{event_type}");
            assert!(
                !actions.iter().any(super::Action::is_highlight),
                "{event_type}"
            );
            assert_eq!(
                serde_json::to_value(actions.iter().find_map(super::Action::sound)).unwrap(),
                json!("ring")
            );
            assert!(!super::notifies(
                &invite_actions(&rules, event_type, json!({"room": true}), 0).await
            ));
        }
        let mention = invite_actions(&rules, "m.room.message", json!({"room": true}), 100).await;
        assert!(mention.iter().any(super::Action::is_highlight));
    }

    #[tokio::test]
    async fn invitations_target_users_without_room_notification_permission() {
        let rules = aligned();
        for (event_type, _, _) in super::RTC_INVITE_TYPES {
            let actions = invite_actions(&rules, event_type, json!({"user_ids": [me()]}), 0).await;
            assert!(super::notifies(&actions), "{event_type}");
            assert!(!actions.iter().any(super::Action::is_highlight));
            assert!(!super::notifies(
                &invite_actions(
                    &rules,
                    event_type,
                    json!({"user_ids": ["@someone:example.org"]}),
                    0,
                )
                .await
            ));
            assert!(!super::notifies(
                &invite_actions(&rules, event_type, json!({}), 100).await
            ));
        }
    }

    #[tokio::test]
    async fn invitation_rules_respect_mentions_only_mute_and_call_settings() {
        let rules = aligned();
        let room = room_id!("!call:example.org");
        let mentions = applied(
            rules.clone(),
            plan_room_mode(&rules, room, false, Some(NotificationModeView::Mentions)),
        );
        let muted = applied(
            rules.clone(),
            plan_room_mode(&rules, room, false, Some(NotificationModeView::Mute)),
        );
        let off = applied(
            rules.clone(),
            plan_event(&rules, EventNotificationView::Calls, false).unwrap(),
        );
        for (event_type, _, _) in super::RTC_INVITE_TYPES {
            for target in [json!({"room": true}), json!({"user_ids": [me()]})] {
                assert!(super::notifies(
                    &invite_actions(&mentions, event_type, target.clone(), 100).await
                ));
                assert!(!super::notifies(
                    &invite_actions(&muted, event_type, target.clone(), 100).await
                ));
                assert!(!super::notifies(
                    &invite_actions(&off, event_type, target, 100).await
                ));
            }
        }
        assert!(plan_alignment(&off).is_empty());
    }

    #[test]
    fn invitation_alignment_preserves_server_rules_and_other_overrides() {
        let mut rules = Ruleset::server_default(me());
        let server: ConditionalPushRule = serde_json::from_value(json!({
            "rule_id": ".m.rule.rtc.invite_for_me", "default": true, "enabled": true,
            "conditions": [
                {"kind": "event_property_is", "key": "type", "value": "m.rtc.invite"},
                {"kind": "event_property_contains", "key": "content.m\\.mentions.user_ids", "value": me()}
            ], "actions": []
        })).unwrap();
        let server_json = serde_json::to_value(&server).unwrap();
        let mention_index = rules
            .override_
            .get_index_of(".m.rule.is_user_mention")
            .unwrap();
        rules.override_.insert(server);
        rules
            .override_
            .move_index(rules.override_.len() - 1, mention_index);
        let custom: ConditionalPushRule = serde_json::from_value(json!({
            "rule_id": "another-client-custom-rule", "default": false, "enabled": false,
            "conditions": [], "actions": ["notify", {"set_tweak": "highlight"}]
        }))
        .unwrap();
        let custom_json = serde_json::to_value(&custom).unwrap();
        rules.override_.insert(custom);
        rules.override_.move_index(rules.override_.len() - 1, 1);
        let aligned = applied(rules.clone(), plan_alignment(&rules));
        assert_eq!(
            serde_json::to_value(aligned.override_.get(".m.rule.rtc.invite_for_me").unwrap())
                .unwrap(),
            server_json
        );
        assert_eq!(
            serde_json::to_value(aligned.override_.get("another-client-custom-rule").unwrap())
                .unwrap(),
            custom_json
        );
        assert!(
            aligned
                .override_
                .get("moe.sable.rtc.invite_for_me")
                .unwrap()
                .actions
                .is_empty()
        );
        assert!(
            aligned
                .override_
                .get("moe.sable.rtc.invite_for_me.unstable")
                .unwrap()
                .actions
                .is_empty()
        );
        assert!(plan_alignment(&aligned).is_empty());
    }

    #[test]
    fn invitation_alignment_removes_the_old_room_size_bypass() {
        let mut rules = Ruleset::server_default(me());
        rules
            .insert(
                NewPushRule::Override(super::NewConditionalPushRule::new(
                    super::RING_ONE_TO_ONE.to_owned(),
                    vec![],
                    vec![super::Action::Notify],
                )),
                None,
                None,
            )
            .unwrap();
        let rules = applied(rules.clone(), plan_alignment(&rules));
        assert!(rules.override_.get(super::RING_ONE_TO_ONE).is_none());
        assert!(plan_alignment(&rules).is_empty());
    }

    #[tokio::test]
    async fn broad_room_rules_do_not_notify_for_withdrawals_or_invalid_targets() {
        let rules = aligned();
        let rules = applied(
            rules.clone(),
            plan_room_mode(
                &rules,
                room_id!("!call:example.org"),
                false,
                Some(NotificationModeView::All),
            ),
        );
        for (event_type, _, _) in super::RTC_INVITE_TYPES {
            for (mentions, power) in [
                (json!({}), 100),
                (json!({"room": true}), 0),
                (json!({"user_ids": ["@other:example.org"]}), 100),
            ] {
                assert!(
                    !super::notifies(&invite_actions(&rules, event_type, mentions, power).await),
                    "{event_type}"
                );
            }
            assert!(super::notifies(
                &invite_actions(&rules, event_type, json!({"room": true}), 100).await
            ));
            assert!(super::notifies(
                &invite_actions(&rules, event_type, json!({"user_ids": [me()]}), 0).await
            ));
        }
        for event_type in ["m.rtc.decline", "org.matrix.msc4310.rtc.decline"] {
            assert!(!super::notifies(
                &invite_actions(&rules, event_type, json!({}), 100).await
            ));
        }
    }

    #[tokio::test]
    async fn server_invitation_settings_are_mirrored_without_reenabling_disabled_rules() {
        let mut rules = Ruleset::server_default(me());
        for (id, enabled, target) in [
            (
                ".m.rule.rtc.invite_for_me",
                false,
                json!([
                    {"kind": "event_property_contains", "key": "content.m\\.mentions.user_ids", "value": me()}
                ]),
            ),
            (
                ".m.rule.rtc.invite_for_room",
                true,
                json!([
                    {"kind": "event_property_is", "key": "content.m\\.mentions.room", "value": true},
                    {"kind": "sender_notification_permission", "key": "room"}
                ]),
            ),
        ] {
            let mut conditions =
                vec![json!({"kind": "event_property_is", "key": "type", "value": "m.rtc.invite"})];
            conditions.extend(target.as_array().unwrap().clone());
            let rule: ConditionalPushRule = serde_json::from_value(json!({
                "rule_id": id, "default": true, "enabled": enabled, "conditions": conditions,
                "actions": ["notify", {"set_tweak": "sound", "value": "ring"}]
            }))
            .unwrap();
            let index = rules
                .override_
                .get_index_of(".m.rule.is_user_mention")
                .unwrap();
            rules.override_.insert(rule);
            rules.override_.move_index(rules.override_.len() - 1, index);
        }
        let rules = applied(rules.clone(), plan_alignment(&rules));
        assert!(
            !rules
                .override_
                .get(".m.rule.rtc.invite_for_me")
                .unwrap()
                .enabled
        );
        for (event_type, _, _) in super::RTC_INVITE_TYPES {
            assert!(!super::notifies(
                &invite_actions(&rules, event_type, json!({"user_ids": [me()]}), 0).await
            ));
            let actions = invite_actions(&rules, event_type, json!({"room": true}), 100).await;
            assert!(super::notifies(&actions));
            assert!(!actions.iter().any(super::Action::is_highlight));
        }
        let mut changed = rules;
        changed
            .set_actions(RuleKind::Override, ".m.rule.rtc.invite_for_room", vec![])
            .unwrap();
        let changed = applied(changed.clone(), plan_alignment(&changed));
        for (event_type, _, _) in super::RTC_INVITE_TYPES {
            assert!(!super::notifies(
                &invite_actions(&changed, event_type, json!({"room": true}), 100).await
            ));
        }
        assert!(plan_alignment(&changed).is_empty());
    }

    #[test]
    fn calls_can_be_configured_without_the_legacy_call_rule() {
        let mut rules = aligned();
        rules
            .underride
            .shift_remove(PredefinedUnderrideRuleId::Call.as_str());
        let rules = applied(
            rules.clone(),
            plan_event(&rules, EventNotificationView::Calls, false).unwrap(),
        );
        for rule in rules
            .override_
            .iter()
            .filter(|rule| super::is_rtc_rule(&rule.rule_id))
        {
            assert!(rule.actions.is_empty());
        }
        assert!(plan_alignment(&rules).is_empty());
    }
}
