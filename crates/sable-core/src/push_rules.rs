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
    Action, AnyPushRuleRef, EventMatchConditionData, HighlightTweakValue, NewConditionalPushRule,
    NewPatternedPushRule, NewPushRule, NewSimplePushRule, PredefinedContentRuleId,
    PredefinedOverrideRuleId, PredefinedUnderrideRuleId, PushCondition, RuleKind, Ruleset,
    SoundTweakValue, Tweak,
};
use matrix_sdk::ruma::{OwnedRoomId, RoomId};
use tokio::sync::{RwLock, broadcast};

use crate::protocol::{
    DefaultNotificationModesView, EventNotificationView, EventNotificationsView,
    KeywordNotificationView, MentionNotificationModeView, MentionNotificationsView,
    MentionRuleView, NotificationModeView, NotificationSettingsView, RoomNotificationModeView,
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

    #[must_use]
    pub fn subscribe(&self) -> broadcast::Receiver<()> {
        self.changes.subscribe()
    }

    /// # Errors
    ///
    /// When the server rejects a write.
    pub async fn apply(&self, writes: Vec<RuleWrite>) -> Result<(), CoreError> {
        let mut result = Ok(());
        let mut applied = false;
        for write in writes {
            if let Err(error) = self.send(&write).await {
                result = Err(error);
                break;
            }
            write.apply_to(&mut *self.rules.write().await);
            applied = true;
        }
        if applied {
            let _ = self.changes.send(());
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
        sent.map_err(CoreError::backend)
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
    fn apply_to(self, rules: &mut Ruleset) {
        match self {
            Self::Put(rule) => {
                let _ = rules.insert(rule, None, None);
            }
            Self::Actions {
                kind,
                rule_id,
                actions,
            } => {
                let _ = rules.set_actions(kind, rule_id, actions);
            }
            Self::Enabled {
                kind,
                rule_id,
                enabled,
            } => {
                let _ = rules.set_enabled(kind, rule_id, enabled);
            }
            Self::Delete { kind, rule_id } => {
                let _ = rules.remove(kind, rule_id);
            }
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
    } else if actions.iter().any(|action| action.sound().is_some()) {
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

const fn default_family(direct: bool) -> [&'static str; 6] {
    if direct {
        [
            ".m.rule.room_one_to_one",
            ".m.rule.encrypted_room_one_to_one",
            ".m.rule.poll_start_one_to_one",
            ".m.rule.poll_end_one_to_one",
            ".org.matrix.msc3930.rule.poll_start_one_to_one",
            ".org.matrix.msc3930.rule.poll_end_one_to_one",
        ]
    } else {
        [
            ".m.rule.message",
            ".m.rule.encrypted",
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
pub fn room_modes(
    rules: &Ruleset,
    rooms: impl IntoIterator<Item = (OwnedRoomId, bool)>,
) -> Vec<RoomNotificationModeView> {
    rooms
        .into_iter()
        .map(|(room_id, direct)| RoomNotificationModeView {
            room: room_mode(rules, &room_id),
            default: default_mode(rules, direct),
            room_id,
        })
        .collect()
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
            .filter(|rule| !rule.default && targets_room(&rule.conditions, room_id))
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
                    rule_id: rule_id.to_string(),
                    actions,
                },
                RuleWrite::Enabled {
                    kind: RuleKind::Underride,
                    rule_id: rule_id.to_string(),
                    enabled: true,
                },
            ]
        })
        .collect())
}

const SUPPRESS_BRIDGE_STATUS: &str = "moe.sable.suppress_bridge_status";
const SUPPRESS_REACTIONS: &str = "moe.sable.suppress_reactions";

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
            vec![(
                RuleKind::Underride,
                PredefinedUnderrideRuleId::Call.as_str(),
            )]
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
    Ok(vec![
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
    ])
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
    use matrix_sdk::ruma::{room_id, user_id};
    use serde_json::json;

    use super::{
        RuleWrite, SUPPRESS_BRIDGE_STATUS, SUPPRESS_REACTIONS, default_modes, event_notifications,
        event_notifies, keywords, level_actions, master_muted, mention_notifications,
        plan_add_keyword, plan_alignment, plan_default_mode, plan_event, plan_keyword_mode,
        plan_master, plan_mention, plan_remove_keyword, plan_room_mode,
        pushes_every_encrypted_event, room_mode,
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
        let modes = super::room_modes(&chosen, [(room.to_owned(), false)]);
        assert_eq!(settings.room, Some(NotificationModeView::All));
        assert_eq!(modes[0].room, Some(NotificationModeView::All));
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
            ]
        );
        let aligned = applied(rules.clone(), plan_alignment(&rules));
        assert!(plan_alignment(&aligned).is_empty());
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
        assert!(keywords(&removed).is_empty());
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
}
