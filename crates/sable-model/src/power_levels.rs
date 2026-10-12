//! `m.room.power_levels`: where each permission lives, the catalogue a settings
//! screen lists, and what a level allows.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

pub const TAGS_EVENT: &str = "in.cinny.room.power_level_tags";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
pub struct RoomPowerLevelsView {
    #[cfg_attr(feature = "typegen", specta(type = specta_typescript::Number))]
    pub ban: i64,
    #[cfg_attr(feature = "typegen", specta(type = specta_typescript::Number))]
    pub kick: i64,
    #[cfg_attr(feature = "typegen", specta(type = specta_typescript::Number))]
    pub redact: i64,
    #[cfg_attr(feature = "typegen", specta(type = specta_typescript::Number))]
    pub invite: i64,
    #[cfg_attr(feature = "typegen", specta(type = specta_typescript::Number))]
    pub events_default: i64,
    #[cfg_attr(feature = "typegen", specta(type = specta_typescript::Number))]
    pub state_default: i64,
    #[cfg_attr(feature = "typegen", specta(type = specta_typescript::Number))]
    pub users_default: i64,
    #[cfg_attr(feature = "typegen", specta(type = BTreeMap<String, specta_typescript::Number<i64>>))]
    pub events: BTreeMap<String, i64>,
    #[cfg_attr(feature = "typegen", specta(type = BTreeMap<String, specta_typescript::Number<i64>>))]
    pub users: BTreeMap<String, i64>,
    #[cfg_attr(feature = "typegen", specta(type = specta_typescript::Number))]
    pub notifications_room: i64,
}

/// Where one permission lives in `m.room.power_levels`. `Event` and `State`
/// share the `events` map and differ only in the default they fall back to.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum PowerLevelLocation {
    Event { event_type: String },
    State { event_type: String },
    EventsDefault,
    StateDefault,
    UsersDefault,
    Action { action: PowerLevelAction },
    NotificationRoom,
}

impl PowerLevelLocation {
    #[must_use]
    pub fn state(event_type: &str) -> Self {
        Self::State {
            event_type: event_type.to_owned(),
        }
    }

    #[must_use]
    pub fn event(event_type: &str) -> Self {
        Self::Event {
            event_type: event_type.to_owned(),
        }
    }

    #[must_use]
    pub const fn action(action: PowerLevelAction) -> Self {
        Self::Action { action }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
#[serde(rename_all = "snake_case")]
pub enum PowerLevelAction {
    Invite,
    Kick,
    Ban,
    Redact,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
pub struct PermissionItem {
    /// A translation key.
    pub label: &'static str,
    pub location: PowerLevelLocation,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
pub struct PermissionGroup {
    /// A translation key.
    pub label: &'static str,
    pub items: Vec<PermissionItem>,
}

#[must_use]
pub fn level_at(levels: &RoomPowerLevelsView, location: &PowerLevelLocation) -> i64 {
    match location {
        PowerLevelLocation::Event { event_type } => levels
            .events
            .get(event_type)
            .copied()
            .unwrap_or(levels.events_default),
        PowerLevelLocation::State { event_type } => levels
            .events
            .get(event_type)
            .copied()
            .unwrap_or(levels.state_default),
        PowerLevelLocation::EventsDefault => levels.events_default,
        PowerLevelLocation::StateDefault => levels.state_default,
        PowerLevelLocation::UsersDefault => levels.users_default,
        PowerLevelLocation::Action { action } => match action {
            PowerLevelAction::Invite => levels.invite,
            PowerLevelAction::Kick => levels.kick,
            PowerLevelAction::Ban => levels.ban,
            PowerLevelAction::Redact => levels.redact,
        },
        PowerLevelLocation::NotificationRoom => levels.notifications_room,
    }
}

#[must_use]
pub fn with_level(
    levels: &RoomPowerLevelsView,
    location: &PowerLevelLocation,
    level: i64,
) -> RoomPowerLevelsView {
    let mut next = levels.clone();
    match location {
        PowerLevelLocation::Event { event_type } | PowerLevelLocation::State { event_type } => {
            next.events.insert(event_type.clone(), level);
        }
        PowerLevelLocation::EventsDefault => next.events_default = level,
        PowerLevelLocation::StateDefault => next.state_default = level,
        PowerLevelLocation::UsersDefault => next.users_default = level,
        PowerLevelLocation::Action { action } => match action {
            PowerLevelAction::Invite => next.invite = level,
            PowerLevelAction::Kick => next.kick = level,
            PowerLevelAction::Ban => next.ban = level,
            PowerLevelAction::Redact => next.redact = level,
        },
        PowerLevelLocation::NotificationRoom => next.notifications_room = level,
    }
    next
}

#[must_use]
pub fn can_send_state(levels: &RoomPowerLevelsView, own_level: i64, event_type: &str) -> bool {
    own_level >= level_at(levels, &PowerLevelLocation::state(event_type))
}

const fn item(label: &'static str, location: PowerLevelLocation) -> PermissionItem {
    PermissionItem { label, location }
}

const fn group(label: &'static str, items: Vec<PermissionItem>) -> PermissionGroup {
    PermissionGroup { label, items }
}

#[must_use]
pub fn permission_groups(is_space: bool) -> Vec<PermissionGroup> {
    let (state, event, action) = (
        PowerLevelLocation::state,
        PowerLevelLocation::event,
        PowerLevelLocation::action,
    );
    let defaults = group(
        "room.permGroupDefaults",
        vec![item(
            "room.permUsersDefault",
            PowerLevelLocation::UsersDefault,
        )],
    );
    let calls = group(
        "room.permGroupCalls",
        vec![
            item("room.permStartCalls", state("org.matrix.msc3401.call")),
            item(
                "room.permJoinCalls",
                state("org.matrix.msc3401.call.member"),
            ),
        ],
    );
    let moderation = group(
        "room.permGroupModeration",
        vec![
            item("room.permInvite", action(PowerLevelAction::Invite)),
            item("room.permKick", action(PowerLevelAction::Kick)),
            item("room.permBan", action(PowerLevelAction::Ban)),
            item("room.permRedactOthers", action(PowerLevelAction::Redact)),
            item("room.permRedactSelf", event("m.room.redaction")),
        ],
    );
    let overview = group(
        if is_space {
            "room.permGroupSpaceOverview"
        } else {
            "room.permGroupRoomOverview"
        },
        vec![
            item("room.permAvatar", state("m.room.avatar")),
            item("room.permName", state("m.room.name")),
            item("room.permTopic", state("m.room.topic")),
        ],
    );

    let mut settings = vec![
        item("room.permAccess", state("m.room.join_rules")),
        item("room.permPublishAddress", state("m.room.canonical_alias")),
        item("room.permChangePermissions", state("m.room.power_levels")),
        item("room.permPowerLevelTags", state(TAGS_EVENT)),
    ];
    if !is_space {
        settings.push(item("room.permEncryption", state("m.room.encryption")));
        settings.push(item(
            "room.permHistoryVisibility",
            state("m.room.history_visibility"),
        ));
    }
    settings.push(item("room.permUpgrade", state("m.room.tombstone")));
    settings.push(item(
        "room.permOtherSettings",
        PowerLevelLocation::StateDefault,
    ));

    let mut other = vec![
        item("room.permImagePacks", state("m.room.image_pack")),
        item("room.permServerAcl", state("m.room.server_acl")),
    ];
    if !is_space {
        other.push(item("room.permWidgets", state("im.vector.modular.widgets")));
    }

    let content = if is_space {
        group(
            "room.permGroupManage",
            vec![
                item("room.permManageRooms", state("m.space.child")),
                item("room.permOtherMessages", PowerLevelLocation::EventsDefault),
            ],
        )
    } else {
        group(
            "room.permGroupMessages",
            vec![
                item("room.permSendMessages", event("m.room.message")),
                item("room.permSendStickers", event("m.sticker")),
                item("room.permSendReactions", event("m.reaction")),
                item("room.permPingRoom", PowerLevelLocation::NotificationRoom),
                item("room.permPinMessages", state("m.room.pinned_events")),
                item("room.permOtherMessages", PowerLevelLocation::EventsDefault),
            ],
        )
    };

    vec![
        defaults,
        content,
        calls,
        moderation,
        overview,
        group("room.permGroupSettings", settings),
        group("room.permGroupOther", other),
    ]
}
