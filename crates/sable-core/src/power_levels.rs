use std::collections::{BTreeMap, BTreeSet};

use matrix_sdk::ruma::OwnedRoomId;
use sable_model::color::is_hex_color;
pub(crate) use sable_model::power_levels::{TAGS_EVENT, level_at, with_level};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use serde_with::{DefaultOnError, serde_as};

use crate::protocol::{
    PowerLevelAction, PowerLevelLocation, PowerLevelTagView, PowerLevelTagsView,
    RoomPowerLevelsView, RpcCode, RpcError,
};
use crate::view;
use crate::{Core, ResultExt};

pub(crate) const POWER_LEVELS_EVENT: &str = "m.room.power_levels";

const MAX_SAFE_LEVEL: i64 = 9_007_199_254_740_991;
/// The key the tag contract uses for room v12 creators, one above any real level.
const FOUNDER_LEVEL: i64 = MAX_SAFE_LEVEL + 1;

/// What a room takes from its space: moderation, overview and settings. Message
/// and call permissions are the room's own business.
fn synced_locations() -> [PowerLevelLocation; 16] {
    [
        PowerLevelLocation::StateDefault,
        PowerLevelLocation::action(PowerLevelAction::Invite),
        PowerLevelLocation::action(PowerLevelAction::Kick),
        PowerLevelLocation::action(PowerLevelAction::Ban),
        PowerLevelLocation::action(PowerLevelAction::Redact),
        PowerLevelLocation::Event {
            event_type: "m.room.redaction".to_owned(),
        },
        PowerLevelLocation::state("m.room.avatar"),
        PowerLevelLocation::state("m.room.name"),
        PowerLevelLocation::state("m.room.topic"),
        PowerLevelLocation::state("m.room.join_rules"),
        PowerLevelLocation::state("m.room.canonical_alias"),
        PowerLevelLocation::state(POWER_LEVELS_EVENT),
        PowerLevelLocation::state(TAGS_EVENT),
        PowerLevelLocation::state("m.room.tombstone"),
        PowerLevelLocation::state("m.room.image_pack"),
        PowerLevelLocation::state("m.room.server_acl"),
    ]
}

const fn editable_by(own_level: i64, from: i64, to: i64) -> bool {
    from != to && from <= own_level && to <= own_level
}

fn synced_user_level(
    from: Option<i64>,
    to: Option<i64>,
    is_own: bool,
    own_level: i64,
) -> Option<i64> {
    if is_own || from.is_some_and(|from| from >= own_level) || to.is_some_and(|to| to > own_level) {
        return from;
    }
    to
}

/// Each change is one the server would accept from `own_level`: nothing at or
/// above it moves, and our own entry is never touched.
pub(crate) fn synced_from_space(
    room: &RoomPowerLevelsView,
    space: &RoomPowerLevelsView,
    own_user_id: &str,
    own_level: i64,
) -> RoomPowerLevelsView {
    let mut next = room.clone();
    for location in synced_locations() {
        if let PowerLevelLocation::Event { event_type } = &location
            && !space.events.contains_key(event_type)
        {
            continue;
        }
        let to = level_at(space, &location);
        if editable_by(own_level, level_at(&next, &location), to) {
            next = with_level(&next, &location, to);
        }
    }

    let user_ids: BTreeSet<&String> = room.users.keys().chain(space.users.keys()).collect();
    next.users = user_ids
        .into_iter()
        .filter_map(|user_id| {
            synced_user_level(
                room.users.get(user_id).copied(),
                space.users.get(user_id).copied(),
                user_id == own_user_id,
                own_level,
            )
            .map(|level| (user_id.clone(), level))
        })
        .collect();
    if editable_by(own_level, room.users_default, space.users_default) {
        next.users_default = space.users_default;
    }
    next
}

#[serde_as]
#[derive(Default, Deserialize, Serialize)]
#[serde(default)]
struct NotificationsContent {
    #[serde_as(deserialize_as = "DefaultOnError")]
    room: i64,
    #[serde(flatten)]
    extra: Map<String, Value>,
}

#[serde_as]
#[derive(Default, Deserialize, Serialize)]
#[serde(default)]
pub(crate) struct PowerLevelsContent {
    #[serde_as(deserialize_as = "DefaultOnError")]
    ban: i64,
    #[serde_as(deserialize_as = "DefaultOnError")]
    kick: i64,
    #[serde_as(deserialize_as = "DefaultOnError")]
    redact: i64,
    #[serde_as(deserialize_as = "DefaultOnError")]
    invite: i64,
    #[serde_as(deserialize_as = "DefaultOnError")]
    events_default: i64,
    #[serde_as(deserialize_as = "DefaultOnError")]
    state_default: i64,
    #[serde_as(deserialize_as = "DefaultOnError")]
    users_default: i64,
    #[serde_as(deserialize_as = "DefaultOnError")]
    events: BTreeMap<String, i64>,
    #[serde_as(deserialize_as = "DefaultOnError")]
    users: BTreeMap<String, i64>,
    #[serde_as(deserialize_as = "DefaultOnError")]
    notifications: NotificationsContent,
    #[serde(flatten)]
    extra: Map<String, Value>,
}

/// Writes the modelled fields over the stored content so anything we do not
/// model survives the edit.
pub(crate) fn power_levels_content(
    stored: Option<Value>,
    levels: &RoomPowerLevelsView,
) -> PowerLevelsContent {
    let mut content: PowerLevelsContent = stored
        .and_then(|stored| serde_json::from_value(stored).ok())
        .unwrap_or_default();
    content.ban = levels.ban;
    content.kick = levels.kick;
    content.redact = levels.redact;
    content.invite = levels.invite;
    content.events_default = levels.events_default;
    content.state_default = levels.state_default;
    content.users_default = levels.users_default;
    content.events = levels.events.clone();
    content.users = levels.users.clone();
    content.notifications.room = levels.notifications_room;
    content
}

fn tag_level(key: &str) -> Option<i64> {
    let level = key.parse::<i64>().ok()?;
    ((-MAX_SAFE_LEVEL..=MAX_SAFE_LEVEL).contains(&level) || level == FOUNDER_LEVEL).then_some(level)
}

#[serde_as]
#[derive(Deserialize)]
struct TagIn {
    #[serde_as(deserialize_as = "DefaultOnError")]
    #[serde(default)]
    name: Option<String>,
    #[serde_as(deserialize_as = "DefaultOnError")]
    #[serde(default)]
    color: Option<String>,
    #[serde_as(deserialize_as = "DefaultOnError")]
    #[serde(default)]
    icon: Option<IconIn>,
}

#[serde_as]
#[derive(Deserialize)]
struct IconIn {
    #[serde_as(deserialize_as = "DefaultOnError")]
    #[serde(default)]
    key: Option<String>,
}

fn tag(value: &Value) -> Option<PowerLevelTagView> {
    let tag = TagIn::deserialize(value).ok()?;
    let name = tag.name.filter(|name| !name.trim().is_empty())?;
    Some(PowerLevelTagView {
        name,
        color: tag.color.filter(|color| is_hex_color(color, &[6])),
        icon: tag
            .icon
            .and_then(|icon| icon.key)
            .map(|key| key.trim().to_owned())
            .filter(|key| !key.is_empty()),
    })
}

pub(crate) fn parse_tags(content: Option<&Value>) -> PowerLevelTagsView {
    content
        .and_then(Value::as_object)
        .map(|entries| {
            entries
                .iter()
                .filter_map(|(key, value)| Some((tag_level(key)?, tag(value)?)))
                .collect()
        })
        .unwrap_or_default()
}

fn object(value: Option<Value>) -> Map<String, Value> {
    match value {
        Some(Value::Object(map)) => map,
        _ => Map::new(),
    }
}

#[derive(Deserialize, Serialize)]
struct IconKey {
    key: String,
}

#[serde_as]
#[derive(Default, Deserialize, Serialize)]
#[serde(default)]
struct TagEntry {
    #[serde_as(deserialize_as = "DefaultOnError")]
    name: String,
    #[serde_as(deserialize_as = "DefaultOnError")]
    #[serde(skip_serializing_if = "Option::is_none")]
    color: Option<String>,
    #[serde_as(deserialize_as = "DefaultOnError")]
    #[serde(skip_serializing_if = "Option::is_none")]
    icon: Option<IconKey>,
    #[serde(flatten)]
    extra: Map<String, Value>,
}

/// Unknown fields on the entry are kept; a missing colour or icon removes it.
pub(crate) fn with_tag(
    stored: Option<Value>,
    level: i64,
    tag: Option<&PowerLevelTagView>,
) -> serde_json::Result<Value> {
    let mut content = object(stored);
    let key = level.to_string();
    let Some(tag) = tag else {
        content.remove(&key);
        return Ok(Value::Object(content));
    };
    let mut entry: TagEntry = content
        .remove(&key)
        .and_then(|stored| serde_json::from_value(stored).ok())
        .unwrap_or_default();
    entry.name.clone_from(&tag.name);
    entry.color = tag.color.clone().filter(|color| is_hex_color(color, &[6]));
    entry.icon = tag
        .icon
        .as_deref()
        .map(str::trim)
        .filter(|icon| !icon.is_empty())
        .map(|key| IconKey {
            key: key.to_owned(),
        });
    content.insert(key, serde_json::to_value(entry)?);
    Ok(Value::Object(content))
}

/// Each level the source names takes the source's role; the rest are kept.
pub(crate) fn with_tags_from(stored: Option<Value>, source: Option<Value>) -> Value {
    let mut content = object(stored);
    content.extend(object(source));
    Value::Object(content)
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct ChildSync {
    pub(crate) updated: u32,
    pub(crate) skipped: u32,
}

impl Core {
    async fn power_levels_view(
        &self,
        room_id: &OwnedRoomId,
    ) -> Result<RoomPowerLevelsView, RpcError> {
        let room = self.room(room_id).await?;
        Ok(view::room_power_levels(
            &room.power_levels_or_default().await,
        ))
    }

    async fn own_power_level(&self, room_id: &OwnedRoomId) -> Result<(String, i64), RpcError> {
        let room = self.room(room_id).await?;
        let user_id = room
            .client()
            .user_id()
            .ok_or(RpcCode::NotLoggedIn)?
            .to_owned();
        let levels = room.power_levels_or_default().await;
        Ok((
            user_id.to_string(),
            view::clamp_power_level(levels.for_user(&user_id)),
        ))
    }

    async fn state_content(
        &self,
        room_id: &OwnedRoomId,
        event_type: &str,
    ) -> Result<Option<Value>, RpcError> {
        self.room_state_event_content(room_id.clone(), event_type.to_owned(), String::new())
            .await
    }

    async fn write_power_levels(
        &self,
        room_id: &OwnedRoomId,
        levels: &RoomPowerLevelsView,
    ) -> Result<(), RpcError> {
        let stored = self.state_content(room_id, POWER_LEVELS_EVENT).await?;
        self.send_state(
            room_id.clone(),
            POWER_LEVELS_EVENT,
            "",
            &power_levels_content(stored, levels),
        )
        .await?;
        Ok(())
    }

    /// `base` is the levels the reader is looking at, which may be newer than
    /// the store until our last write syncs back.
    pub(crate) async fn set_power_level(
        &self,
        room_id: OwnedRoomId,
        base: Option<RoomPowerLevelsView>,
        location: &PowerLevelLocation,
        level: i64,
    ) -> Result<RoomPowerLevelsView, RpcError> {
        let current = match base {
            Some(levels) => levels,
            None => self.power_levels_view(&room_id).await?,
        };
        let next = with_level(&current, location, level);
        self.write_power_levels(&room_id, &next).await?;
        Ok(next)
    }

    pub(crate) async fn power_level_tags(
        &self,
        room_id: &OwnedRoomId,
    ) -> Result<PowerLevelTagsView, RpcError> {
        Ok(parse_tags(
            self.state_content(room_id, TAGS_EVENT).await?.as_ref(),
        ))
    }

    pub(crate) async fn set_power_level_tag(
        &self,
        room_id: OwnedRoomId,
        level: i64,
        tag: Option<&PowerLevelTagView>,
    ) -> Result<PowerLevelTagsView, RpcError> {
        let next = with_tag(self.state_content(&room_id, TAGS_EVENT).await?, level, tag)
            .or_failed(self, "power_level_tag")?;
        self.send_state(room_id, TAGS_EVENT, "", &next).await?;
        Ok(parse_tags(Some(&next)))
    }

    async fn sync_tags_from(
        &self,
        room_id: &OwnedRoomId,
        source: Option<Value>,
    ) -> Result<(), RpcError> {
        let stored = self.state_content(room_id, TAGS_EVENT).await?;
        self.send_state(
            room_id.clone(),
            TAGS_EVENT,
            "",
            &with_tags_from(stored, source),
        )
        .await?;
        Ok(())
    }

    pub(crate) async fn sync_power_levels_from_space(
        &self,
        room_id: OwnedRoomId,
        space_id: OwnedRoomId,
        base: Option<RoomPowerLevelsView>,
    ) -> Result<(RoomPowerLevelsView, PowerLevelTagsView), RpcError> {
        let current = match base {
            Some(levels) => levels,
            None => self.power_levels_view(&room_id).await?,
        };
        let (user_id, own_level) = self.own_power_level(&room_id).await?;
        let space_levels = self.power_levels_view(&space_id).await?;
        let space_tags = self.state_content(&space_id, TAGS_EVENT).await?;

        let next = synced_from_space(&current, &space_levels, &user_id, own_level);
        self.write_power_levels(&room_id, &next).await?;
        if space_tags.is_some()
            && own_level >= level_at(&next, &PowerLevelLocation::state(TAGS_EVENT))
        {
            self.sync_tags_from(&room_id, space_tags).await?;
        }
        let tags = self.power_level_tags(&room_id).await?;
        Ok((next, tags))
    }

    async fn sync_child(
        &self,
        child_id: &OwnedRoomId,
        space_levels: &RoomPowerLevelsView,
        space_tags: Option<&Value>,
    ) -> Result<bool, RpcError> {
        let (user_id, own_level) = self.own_power_level(child_id).await?;
        let levels = self.power_levels_view(child_id).await?;
        if own_level < level_at(&levels, &PowerLevelLocation::state(POWER_LEVELS_EVENT)) {
            return Ok(false);
        }
        let next = synced_from_space(&levels, space_levels, &user_id, own_level);
        if next != levels {
            self.write_power_levels(child_id, &next).await?;
        }
        if space_tags.is_some()
            && own_level >= level_at(&next, &PowerLevelLocation::state(TAGS_EVENT))
        {
            self.sync_tags_from(child_id, space_tags.cloned()).await?;
        }
        Ok(true)
    }

    pub(crate) async fn sync_child_power_levels(
        &self,
        space_id: OwnedRoomId,
        child_ids: &[OwnedRoomId],
    ) -> Result<ChildSync, RpcError> {
        let space_levels = self.power_levels_view(&space_id).await?;
        let space_tags = self.state_content(&space_id, TAGS_EVENT).await?;
        let mut result = ChildSync::default();
        for child_id in child_ids {
            match self
                .sync_child(child_id, &space_levels, space_tags.as_ref())
                .await
            {
                Ok(true) => result.updated += 1,
                Ok(false) => result.skipped += 1,
                Err(error) => {
                    tracing::warn!(room = %child_id, ?error, "child permission sync failed");
                    result.skipped += 1;
                }
            }
        }
        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use serde_json::json;

    use super::{
        FOUNDER_LEVEL, MAX_SAFE_LEVEL, level_at, parse_tags, power_levels_content,
        synced_from_space, with_level, with_tag, with_tags_from,
    };
    use crate::protocol::{
        PowerLevelAction, PowerLevelLocation, PowerLevelTagView, RoomPowerLevelsView,
    };

    fn to_json(content: impl serde::Serialize) -> serde_json::Value {
        serde_json::to_value(content).unwrap()
    }

    fn map(entries: &[(&str, i64)]) -> BTreeMap<String, i64> {
        entries
            .iter()
            .map(|(key, level)| ((*key).to_owned(), *level))
            .collect()
    }

    fn room() -> RoomPowerLevelsView {
        RoomPowerLevelsView {
            ban: 50,
            kick: 50,
            redact: 50,
            invite: 0,
            events_default: 0,
            state_default: 50,
            users_default: 0,
            events: map(&[
                ("im.vector.modular.widgets", 20),
                ("m.reaction", 25),
                ("m.room.name", 75),
                ("m.room.tombstone", 100),
            ]),
            users: map(&[("@admin:example.org", 100)]),
            notifications_room: 50,
        }
    }

    fn space() -> RoomPowerLevelsView {
        RoomPowerLevelsView {
            ban: 75,
            kick: 75,
            redact: 50,
            invite: 50,
            events_default: 100,
            state_default: 100,
            users_default: 0,
            events: map(&[("m.space.child", 50), ("m.room.name", 50)]),
            users: map(&[("@admin:example.org", 100), ("@mod:example.org", 50)]),
            notifications_room: 50,
        }
    }

    fn tag(name: &str, color: Option<&str>, icon: Option<&str>) -> PowerLevelTagView {
        PowerLevelTagView {
            name: name.to_owned(),
            color: color.map(ToOwned::to_owned),
            icon: icon.map(ToOwned::to_owned),
        }
    }

    #[test]
    fn an_absent_type_falls_back_to_the_default_of_its_kind() {
        let levels = room();
        assert_eq!(
            level_at(&levels, &PowerLevelLocation::event("m.reaction")),
            25
        );
        assert_eq!(
            level_at(&levels, &PowerLevelLocation::state("m.room.name")),
            75
        );
        assert_eq!(
            level_at(&levels, &PowerLevelLocation::event("m.room.message")),
            0
        );
        assert_eq!(
            level_at(&levels, &PowerLevelLocation::state("m.room.topic")),
            50
        );
        assert_eq!(
            level_at(
                &levels,
                &PowerLevelLocation::Action {
                    action: PowerLevelAction::Invite
                }
            ),
            0
        );
    }

    #[test]
    fn setting_an_action_or_default_writes_the_field_not_the_event_map() {
        let levels = room();
        let kick = with_level(
            &levels,
            &PowerLevelLocation::Action {
                action: PowerLevelAction::Kick,
            },
            0,
        );
        assert_eq!(kick.kick, 0);
        assert_eq!(kick.events, levels.events);
        assert_eq!(
            with_level(&levels, &PowerLevelLocation::NotificationRoom, 0).notifications_room,
            0
        );
        assert_eq!(
            with_level(&levels, &PowerLevelLocation::state("m.room.topic"), 100)
                .events
                .get("m.room.topic"),
            Some(&100)
        );
    }

    #[test]
    fn setting_send_messages_also_gates_encrypted_messages() {
        let next = with_level(&room(), &PowerLevelLocation::event("m.room.message"), 50);
        assert_eq!(next.events.get("m.room.message"), Some(&50));
        assert_eq!(next.events.get("m.room.encrypted"), Some(&50));
    }

    #[test]
    fn setting_a_call_or_pack_permission_also_gates_its_other_event_types() {
        let join = with_level(&room(), &PowerLevelLocation::event("m.rtc.member"), 10);
        assert_eq!(join.events.get("org.matrix.msc4143.rtc.member"), Some(&10));
        assert_eq!(join.events.get("org.matrix.msc3401.call.member"), Some(&10));
        let start = with_level(&room(), &PowerLevelLocation::state("m.rtc.slot"), 20);
        assert_eq!(start.events.get("org.matrix.msc4143.rtc.slot"), Some(&20));
        assert_eq!(start.events.get("org.matrix.msc3401.call"), Some(&20));
        let packs = with_level(&room(), &PowerLevelLocation::state("m.room.image_pack"), 30);
        assert_eq!(packs.events.get("im.ponies.room_emotes"), Some(&30));
    }

    #[test]
    fn the_content_keeps_what_the_view_does_not_model() {
        let stored = json!({
            "ban": 50,
            "historical": 100,
            "notifications": { "room": 50, "other": 10 },
        });
        let content = to_json(power_levels_content(Some(stored), &room()));

        assert_eq!(content["historical"], json!(100));
        assert_eq!(content["notifications"], json!({ "room": 50, "other": 10 }));
        assert_eq!(content["events"]["m.reaction"], json!(25));
        assert_eq!(content["users"], json!({ "@admin:example.org": 100 }));
        assert_eq!(content["state_default"], json!(50));
    }

    #[test]
    fn unreadable_stored_fields_are_replaced_and_foreign_keys_kept() {
        let stored = json!({
            "ban": "high",
            "events": [1],
            "notifications": 5,
            "historical": { "a": null },
            "x.other": null,
        });
        let content = to_json(power_levels_content(Some(stored), &room()));

        assert_eq!(content["historical"], json!({ "a": null }));
        assert_eq!(content["x.other"], json!(null));
        assert_eq!(content["notifications"], json!({ "room": 50 }));
        assert_eq!(content["ban"], json!(50));
        assert_eq!(content["events"]["m.reaction"], json!(25));
        assert_eq!(
            to_json(power_levels_content(Some(json!("junk")), &room())),
            to_json(power_levels_content(None, &room()))
        );
    }

    #[test]
    fn large_levels_survive_an_edit() {
        let mut levels = room();
        levels.ban = MAX_SAFE_LEVEL;
        levels.kick = -MAX_SAFE_LEVEL;
        levels.users = map(&[("@admin:example.org", -3_000_000_000)]);
        let content = to_json(power_levels_content(
            None,
            &with_level(&levels, &PowerLevelLocation::state("m.room.name"), 3),
        ));

        assert_eq!(content["ban"], json!(MAX_SAFE_LEVEL));
        assert_eq!(content["kick"], json!(-MAX_SAFE_LEVEL));
        assert_eq!(
            content["users"]["@admin:example.org"],
            json!(-3_000_000_000_i64)
        );
    }

    #[test]
    fn a_sync_takes_the_space_levels_a_room_shares_with_it() {
        let next = synced_from_space(&room(), &space(), "@admin:example.org", 100);

        assert_eq!(next.ban, 75);
        assert_eq!(next.kick, 75);
        assert_eq!(next.invite, 50);
        assert_eq!(next.state_default, 100);
        assert_eq!(next.events.get("m.room.name"), Some(&50));
        assert_eq!(next.users.get("@mod:example.org"), Some(&50));
    }

    #[test]
    fn a_sync_keeps_what_only_a_room_has_or_only_a_space_means() {
        let next = synced_from_space(&room(), &space(), "@admin:example.org", 100);

        assert_eq!(next.events_default, 0);
        assert_eq!(next.events.get("m.reaction"), Some(&25));
        assert_eq!(next.events.get("im.vector.modular.widgets"), Some(&20));
        assert_eq!(next.events.get("m.space.child"), None);
        assert_eq!(next.events.get("m.room.redaction"), None);
    }

    #[test]
    fn a_sync_applies_the_space_default_before_the_types_that_fall_back_to_it() {
        let mut source = room();
        source.events = BTreeMap::new();
        let mut target = space();
        target.events = map(&[("m.room.topic", 50)]);
        let next = synced_from_space(&source, &target, "@admin:example.org", 100);

        assert_eq!(
            level_at(&next, &PowerLevelLocation::state("m.room.topic")),
            50
        );
        assert_eq!(
            level_at(&next, &PowerLevelLocation::state("m.room.avatar")),
            100
        );
    }

    #[test]
    fn a_sync_removes_members_the_space_does_not_list() {
        let mut source = room();
        source.users = map(&[("@admin:example.org", 100), ("@bot:example.org", 50)]);
        let next = synced_from_space(&source, &space(), "@admin:example.org", 100);

        assert_eq!(
            next.users,
            map(&[("@admin:example.org", 100), ("@mod:example.org", 50)])
        );
    }

    #[test]
    fn a_sync_leaves_everything_the_server_would_refuse_to_change() {
        let mut source = room();
        source.users = map(&[("@self:example.org", 50), ("@peer:example.org", 50)]);
        let mut target = space();
        target.users = map(&[("@self:example.org", 0), ("@new:example.org", 100)]);
        let next = synced_from_space(&source, &target, "@self:example.org", 50);

        assert_eq!(
            next.users,
            map(&[("@self:example.org", 50), ("@peer:example.org", 50)])
        );
        assert_eq!(next.ban, 50);
        assert_eq!(next.state_default, 50);
        assert_eq!(next.redact, 50);
        assert_eq!(next.invite, 50);
    }

    #[test]
    fn tags_are_read_with_name_colour_and_icon() {
        let tags = parse_tags(Some(&json!({
            "100": { "name": "Admin", "color": "#0088ff", "icon": { "key": "✨" } },
            "50": { "name": "Moderator", "color": "javascript:alert(1)" },
        })));

        assert_eq!(
            tags.get(&100),
            Some(&tag("Admin", Some("#0088ff"), Some("✨")))
        );
        assert_eq!(tags.get(&50), Some(&tag("Moderator", None, None)));
    }

    #[test]
    fn hostile_tag_content_yields_no_tags() {
        for content in [
            json!(null),
            json!("not an object"),
            json!([1, 2, 3]),
            json!({ "100": "not an object" }),
            json!({ "100": { "name": 42 } }),
            json!({ "100": { "name": "  " } }),
            json!({ "notALevel": { "name": "Admin" } }),
        ] {
            assert!(parse_tags(Some(&content)).is_empty(), "{content}");
        }
        assert!(parse_tags(None).is_empty());
    }

    #[test]
    fn tags_reject_levels_outside_the_safe_range_except_the_founder_key() {
        let tags = parse_tags(Some(&json!({
            "-9007199254740991": { "name": "Minimum" },
            "9007199254740991": { "name": "Maximum" },
            "9007199254740992": { "name": "Founder" },
            "9007199254740993": { "name": "Too high" },
            "-9007199254740992": { "name": "Too low" },
        })));

        assert_eq!(
            tags.keys().copied().collect::<Vec<_>>(),
            vec![-MAX_SAFE_LEVEL, MAX_SAFE_LEVEL, FOUNDER_LEVEL]
        );
    }

    #[test]
    fn writing_a_tag_keeps_other_entries_and_unknown_fields() {
        let stored = json!({
            "100": { "name": "Admin", "color": "#0088ff", "since": 1 },
            "50": { "name": "Moderator" },
        });
        let next = with_tag(Some(stored), 100, Some(&tag("Owner", None, Some("✨")))).unwrap();

        assert_eq!(
            next,
            json!({
                "100": { "name": "Owner", "since": 1, "icon": { "key": "✨" } },
                "50": { "name": "Moderator" },
            })
        );
    }

    #[test]
    fn writing_a_tag_replaces_unreadable_fields_and_drops_stale_ones() {
        let stored = json!({
            "100": { "name": 7, "color": 3, "icon": "x", "since": null },
            "50": { "name": "Moderator", "color": "#112233", "icon": { "key": "a", "z": 1 } },
        });
        let next = with_tag(Some(stored), 50, Some(&tag("Mod", Some("nope"), None))).unwrap();

        assert_eq!(
            next,
            json!({
                "100": { "name": 7, "color": 3, "icon": "x", "since": null },
                "50": { "name": "Mod" },
            })
        );
        let next = with_tag(Some(next), 100, Some(&tag("Admin", Some("#0088ff"), None))).unwrap();
        assert_eq!(
            next["100"],
            json!({ "name": "Admin", "color": "#0088ff", "since": null })
        );
    }

    #[test]
    fn writing_no_tag_removes_the_entry_and_hostile_content_starts_fresh() {
        let stored = json!({ "100": { "name": "Admin" }, "50": { "name": "Moderator" } });
        assert_eq!(
            with_tag(Some(stored), 100, None).unwrap(),
            json!({ "50": { "name": "Moderator" } })
        );
        assert_eq!(
            with_tag(
                Some(json!("nonsense")),
                100,
                Some(&tag("Admin", None, None))
            )
            .unwrap(),
            json!({ "100": { "name": "Admin" } })
        );
    }

    #[test]
    fn syncing_tags_takes_the_source_role_at_each_level_and_keeps_the_rest() {
        let next = with_tags_from(
            Some(json!({ "100": { "name": "Owner" }, "20": { "name": "Helper" } })),
            Some(json!({ "100": { "name": "Admin" }, "50": { "name": "Moderator" } })),
        );

        assert_eq!(
            next,
            json!({
                "100": { "name": "Admin" },
                "50": { "name": "Moderator" },
                "20": { "name": "Helper" },
            })
        );
        assert_eq!(with_tags_from(None, None), json!({}));
    }
}
