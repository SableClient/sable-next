//! MSC4075 invitations and their MSC4354 ephemeral map.
#![expect(
    clippy::indexing_slicing,
    reason = "serde_json::Value indexing returns Null for missing fields"
)]

use std::collections::{BTreeMap, HashMap, HashSet};

use serde_json::Value;

const NOTIFICATION_EVENT_TYPE: &str = "org.matrix.msc4075.rtc.notification";
const DECLINE_EVENT_TYPE: &str = "org.matrix.msc4310.rtc.decline";
const RTC_MEMBER_EVENT_TYPE: &str = "org.matrix.msc4143.rtc.member";

fn is_rtc_member_type(event_type: &str) -> bool {
    matches!(event_type, "m.rtc.member" | RTC_MEMBER_EVENT_TYPE)
}

const MAX_LIFETIME_MS: u64 = 120_000;
const MAX_STICKY_MS: u64 = 3_600_000;
const MAX_ENTRIES: usize = 5_000;

type MapKey = (String, String, String);

fn kind(value: &Value) -> &str {
    value["type"].as_str().unwrap_or_default()
}

fn invite_type(value: &Value) -> bool {
    matches!(
        kind(value),
        "m.rtc.invite" | "m.rtc.notification" | NOTIFICATION_EVENT_TYPE
    )
}

fn decline_type(value: &Value) -> bool {
    matches!(kind(value), "m.rtc.decline" | DECLINE_EVENT_TYPE)
}

fn sticky_key(content: &Value) -> Option<&str> {
    let stable = content.get("sticky_key").and_then(Value::as_str);
    let unstable = content.get("msc4354_sticky_key").and_then(Value::as_str);
    if stable.is_some() && unstable.is_some() && stable != unstable {
        return None;
    }
    stable.or(unstable).filter(|key| !key.is_empty())
}

fn duration(value: &Value) -> Option<u64> {
    let stable = value.get("sticky");
    let unstable = value.get("msc4354_sticky");
    if stable.is_some() && unstable.is_some() && stable != unstable {
        return None;
    }
    stable
        .or(unstable)?
        .get("duration_ms")?
        .as_u64()
        .map(|ms| ms.min(MAX_STICKY_MS))
}

fn expiry(value: &Value, now: u64) -> Option<(u64, u64)> {
    let duration = duration(value)?;
    let origin = value.get("origin_server_ts")?.as_u64()?;
    let ttl = value
        .get("unsigned")
        .and_then(|unsigned| {
            unsigned
                .get("sticky_duration_remaining_ms")
                .or_else(|| unsigned.get("msc4354_sticky_duration_ttl_ms"))
                .or_else(|| unsigned.get("sticky_duration_ttl_ms"))
        })
        .and_then(Value::as_u64);
    let expires = ttl.map_or_else(
        || origin.min(now).saturating_add(duration),
        |ttl| now.saturating_add(ttl.min(duration)),
    );
    (duration > 0 && expires > now).then_some((expires, origin.saturating_add(duration)))
}

fn valid_mentions(content: &Value) -> bool {
    let Some(mentions) = content.get("m.mentions").and_then(Value::as_object) else {
        return false;
    };
    if mentions.get("room").is_some_and(|room| !room.is_boolean()) {
        return false;
    }
    let users = match mentions.get("user_ids") {
        Some(Value::Array(users)) => users,
        None => return mentions.get("room").and_then(Value::as_bool) == Some(true),
        Some(_) => return false,
    };
    users.iter().all(|user| {
        user.as_str()
            .is_some_and(|user| ruma_common::UserId::parse(user).is_ok())
    }) && (!users.is_empty() || mentions.get("room").and_then(Value::as_bool) == Some(true))
}

fn legacy_acted(event: &Value, state_key: &str, invite: &Invite, now: u64) -> bool {
    let content = &event["content"];
    let origin = event["origin_server_ts"].as_u64().unwrap_or_default();
    let joined = |content: &Value| {
        content["application"] == "m.call"
            && content["scope"] == "m.room"
            && content["call_id"] == ""
            && content["created_ts"]
                .as_u64()
                .unwrap_or(origin)
                .saturating_add(content["expires"].as_u64().unwrap_or(14_400_000))
                > now
    };
    if let Some(memberships) = content["memberships"].as_array() {
        return memberships.iter().any(joined)
            || (memberships.is_empty() && origin >= invite.origin());
    }
    joined(content)
        || (state_key.ends_with("_m.call")
            && content.get("application").is_none()
            && origin >= invite.origin())
}

#[derive(Clone, Debug)]
pub struct Invite {
    pub event: Value,
    pub id: String,
    pub sender: String,
    pub slot: String,
    pub expires: u64,
    pub modern: bool,
    pub room_allowed: bool,
}

impl Invite {
    #[must_use]
    pub fn has_video(&self, events: &[Value]) -> bool {
        self.event["content"]["m.call.intent"] == "video"
            || events.iter().any(|event| {
                is_rtc_member_type(kind(event))
                    && event["content"]["slot_id"] == self.slot
                    && (event["content"]["application"]["intent"] == "m.video"
                        || event["content"]["application"]["m.call.intent"] == "video")
            })
    }

    #[must_use]
    pub fn parse(value: &Value, now: u64) -> Option<Self> {
        if !invite_type(value) || value["unsigned"].get("redacted_because").is_some() {
            return None;
        }
        let content = value.get("content")?.as_object()?;
        // The deployed SDK keeps slot/key fields when falling back to a regular event.
        let legacy = kind(value) != "m.rtc.invite"
            && value.get("sticky").is_none()
            && value.get("msc4354_sticky").is_none()
            && matches!(
                content.get("notification_type").and_then(Value::as_str),
                Some("ring" | "notification")
            );
        let modern = !legacy
            && (content.contains_key("slot_id")
                || kind(value) == "m.rtc.invite"
                || sticky_key(&value["content"]).is_some());
        let slot = if modern {
            let slot = content.get("slot_id")?.as_str()?;
            if slot.is_empty()
                || sticky_key(&value["content"])? != slot
                || expiry(value, now).is_none()
            {
                return None;
            }
            if kind(value) == "m.rtc.invite"
                && content.get("sticky_key").and_then(Value::as_str) != Some(slot)
            {
                return None;
            }
            slot
        } else {
            if !matches!(
                content.get("notification_type").and_then(Value::as_str),
                Some("ring" | "notification")
            ) {
                return None;
            }
            if let Some(slot) = content.get("slot_id") {
                let slot = slot.as_str().filter(|slot| !slot.is_empty())?;
                if (content.contains_key("sticky_key")
                    || content.contains_key("msc4354_sticky_key"))
                    && sticky_key(&value["content"]) != Some(slot)
                {
                    return None;
                }
                slot
            } else {
                if content.contains_key("sticky_key") || content.contains_key("msc4354_sticky_key")
                {
                    return None;
                }
                "m.call#ROOM"
            }
        };
        if !valid_mentions(&value["content"]) {
            return None;
        }
        let origin = value.get("origin_server_ts")?.as_u64()?;
        let start = content.get("sender_ts")?.as_u64()?.min(origin);
        let lifetime = match content.get("lifetime") {
            Some(lifetime) => lifetime.as_u64()?,
            None if !modern && content.get("notification_type")?.as_str()? == "notification" => {
                30_000
            }
            None => return None,
        };
        let expires = start
            .saturating_add(lifetime)
            .min(now.saturating_add(MAX_LIFETIME_MS));
        if expires <= now {
            return None;
        }
        let sender = value.get("sender")?.as_str()?;
        ruma_common::UserId::parse(sender).ok()?;
        let id = value.get("event_id")?.as_str()?;
        ruma_common::EventId::parse(id).ok()?;
        Some(Self {
            event: value.clone(),
            id: id.to_owned(),
            sender: sender.to_owned(),
            slot: slot.to_owned(),
            expires,
            modern,
            room_allowed: false,
        })
    }

    fn origin(&self) -> u64 {
        self.event["origin_server_ts"].as_u64().unwrap_or_default()
    }

    #[must_use]
    pub fn should_ring(&self, user: &str, direct: bool) -> bool {
        if self.modern {
            direct
                || self.event["content"]["m.mentions"]["user_ids"]
                    .as_array()
                    .is_some_and(|users| users.iter().any(|id| id.as_str() == Some(user)))
        } else {
            self.event["content"]["notification_type"] == "ring"
        }
    }

    fn targets(&self, user: &str) -> bool {
        let mentions = &self.event["content"]["m.mentions"];
        user != self.sender
            && (mentions["user_ids"]
                .as_array()
                .is_some_and(|users| users.iter().any(|id| id.as_str() == Some(user)))
                || (self.room_allowed && mentions["room"].as_bool() == Some(true)))
    }
}

struct Entry {
    value: Value,
    invite: Option<Invite>,
    expires: u64,
    order: (u64, String),
    removed: bool,
}

#[derive(Default)]
pub struct Invitations {
    entries: HashMap<MapKey, Entry>,
    legacy: HashMap<String, Invite>,
    legacy_declines: HashMap<(String, String), u64>,
    redacted: HashMap<String, u64>,
    seen: HashMap<String, u64>,
    shown: BTreeMap<String, Invite>,
    pub slots: HashMap<String, bool>,
    legacy_members: HashMap<(String, String), Value>,
}

impl Invitations {
    #[must_use]
    pub fn clear(&mut self) -> Vec<String> {
        let ended = self
            .shown
            .values()
            .map(|invite| invite.id.clone())
            .collect();
        *self = Self::default();
        ended
    }

    pub fn apply(&mut self, value: &Value, now: u64, room_allowed: bool) {
        let event_type = kind(value);
        if event_type == "m.room.redaction" {
            if let Some(id) = value
                .get("redacts")
                .or_else(|| value["content"].get("redacts"))
                .and_then(Value::as_str)
            {
                self.remove(id, now);
            }
            return;
        }
        if matches!(
            event_type,
            "org.matrix.msc3401.call.member" | "m.call.member"
        ) {
            if let (Some(sender), Some(key)) =
                (value["sender"].as_str(), value["state_key"].as_str())
            {
                let map_key = (sender.to_owned(), key.to_owned());
                if self.legacy_members.len() < MAX_ENTRIES
                    || self.legacy_members.contains_key(&map_key)
                {
                    let newer = self.legacy_members.get(&map_key).is_none_or(|old| {
                        (
                            value["origin_server_ts"].as_u64(),
                            value["event_id"].as_str(),
                        ) > (old["origin_server_ts"].as_u64(), old["event_id"].as_str())
                    });
                    if newer {
                        self.legacy_members.insert(map_key, value.clone());
                    }
                }
            }
            return;
        }
        if !invite_type(value) && !decline_type(value) && !is_rtc_member_type(event_type) {
            return;
        }
        let Some(id) = value["event_id"].as_str() else {
            return;
        };
        if self.redacted.contains_key(id) {
            return;
        }
        if self.apply_legacy_decline(value, now) {
            return;
        }
        if invite_type(value)
            && let Some(mut invite) = Invite::parse(value, now)
            && !invite.modern
        {
            if self.legacy.len() < MAX_ENTRIES {
                invite.room_allowed = room_allowed;
                self.legacy.entry(id.to_owned()).or_insert(invite);
            }
            return;
        }
        let Some(key) = sticky_key(&value["content"]) else {
            return;
        };
        let Some(sender) = value["sender"].as_str() else {
            return;
        };
        if ruma_common::UserId::parse(sender).is_err() || ruma_common::EventId::parse(id).is_err() {
            return;
        }
        let Some((expires, order)) = expiry(value, now) else {
            return;
        };
        let map_key = (sender.to_owned(), event_type.to_owned(), key.to_owned());
        let order = (order, id.to_owned());
        if self
            .entries
            .get(&map_key)
            .is_some_and(|old| old.order >= order)
            || (self.entries.len() >= MAX_ENTRIES && !self.entries.contains_key(&map_key))
        {
            return;
        }
        let invite = Invite::parse(value, now).map(|mut invite| {
            invite.room_allowed = room_allowed;
            invite.expires = invite.expires.min(expires);
            invite
        });
        self.entries.insert(
            map_key,
            Entry {
                value: value.clone(),
                invite,
                expires,
                order,
                removed: false,
            },
        );
    }

    fn apply_legacy_decline(&mut self, value: &Value, now: u64) -> bool {
        if !decline_type(value)
            || sticky_key(&value["content"]).is_some()
            || value["content"]["m.relates_to"]["rel_type"] != "m.reference"
        {
            return false;
        }
        let (Some(sender), Some(target), Some(origin)) = (
            value["sender"].as_str(),
            value["content"]["m.relates_to"]["event_id"].as_str(),
            value["origin_server_ts"].as_u64(),
        ) else {
            return false;
        };
        if ruma_common::UserId::parse(sender).is_err()
            || ruma_common::EventId::parse(target).is_err()
            || self.legacy_declines.len() >= MAX_ENTRIES
        {
            return false;
        }
        self.legacy_declines.insert(
            (sender.to_owned(), target.to_owned()),
            origin.min(now).saturating_add(MAX_LIFETIME_MS),
        );
        true
    }

    pub fn remove(&mut self, id: &str, now: u64) {
        if self.redacted.len() < MAX_ENTRIES {
            self.redacted
                .entry(id.to_owned())
                .or_insert_with(|| now.saturating_add(MAX_STICKY_MS));
        }
        self.legacy.remove(id);
        for entry in self.entries.values_mut() {
            if entry.order.1 == id {
                entry.removed = true;
            }
        }
    }

    pub fn remove_key(&mut self, sender: &str, event_type: &str, key: &str, now: u64) {
        if let Some(entry) =
            self.entries
                .get_mut(&(sender.to_owned(), event_type.to_owned(), key.to_owned()))
        {
            entry.removed = true;
            let id = entry.order.1.clone();
            self.remove(&id, now);
        }
    }

    pub fn reconcile_snapshot(&mut self, live_ids: &HashSet<String>, now: u64) {
        let removed: Vec<_> = self
            .entries
            .values()
            .filter(|entry| !entry.removed && !live_ids.contains(&entry.order.1))
            .map(|entry| entry.order.1.clone())
            .collect();
        for id in removed {
            self.remove(&id, now);
        }
    }

    #[must_use]
    pub fn outgoing(&self, user: &str, now: u64) -> Vec<Invite> {
        self.entries
            .values()
            .filter(|entry| !entry.removed && entry.expires > now)
            .filter_map(|entry| entry.invite.as_ref())
            .filter(|invite| {
                invite.sender == user
                    && invite.expires > now
                    && !self.redacted.contains_key(&invite.id)
            })
            .cloned()
            .collect()
    }

    #[must_use]
    pub fn is_active_for(&self, id: &str, user: &str, now: u64) -> bool {
        self.entries
            .values()
            .filter(|entry| !entry.removed && entry.expires > now)
            .filter_map(|entry| entry.invite.as_ref())
            .filter(|invite| self.slots.get(&invite.slot) == Some(&true))
            .chain(self.legacy.values())
            .any(|invite| {
                invite.id == id
                    && invite.expires > now
                    && !self.redacted.contains_key(id)
                    && invite.targets(user)
                    && !self.acted(invite, user, now)
            })
    }

    fn acted(&self, invite: &Invite, user: &str, now: u64) -> bool {
        if !invite.modern
            && self
                .legacy_declines
                .get(&(user.to_owned(), invite.id.clone()))
                .is_some_and(|expires| *expires > now)
        {
            return true;
        }
        self.entries
            .values()
            .filter(|entry| !entry.removed && entry.expires > now)
            .any(|entry| {
                let event = &entry.value;
                if event["sender"].as_str() != Some(user) {
                    return false;
                }
                let content = &event["content"];
                if decline_type(event) {
                    return sticky_key(content) == Some(invite.id.as_str())
                        && content["m.relates_to"]["rel_type"] == "m.reference"
                        && content["m.relates_to"]["event_id"] == invite.id;
                }
                if !is_rtc_member_type(kind(event))
                    || content["slot_id"].as_str() != Some(invite.slot.as_str())
                    || content["member"]["id"].as_str() != sticky_key(content)
                    || content["member"]
                        .get("user_id")
                        .is_some_and(|id| id.as_str() != Some(user))
                {
                    return false;
                }
                match content["member"]["membership"].as_str() {
                    Some("join") => true,
                    Some("leave") => event["origin_server_ts"]
                        .as_u64()
                        .is_some_and(|ts| ts >= invite.origin()),
                    None => kind(event) == RTC_MEMBER_EVENT_TYPE && content.get("member").is_some(),
                    _ => false,
                }
            })
            || ((!invite.modern || invite.slot == "m.call#ROOM")
                && self.legacy_members.iter().any(|((sender, key), event)| {
                    sender == user && legacy_acted(event, key, invite, now)
                }))
    }

    #[must_use]
    pub fn slots_to_check(&self, now: u64) -> HashSet<String> {
        self.entries
            .values()
            .filter(|entry| !entry.removed && entry.expires > now)
            .filter_map(|entry| entry.invite.as_ref())
            .filter(|invite| invite.expires > now)
            .map(|invite| invite.slot.clone())
            .collect()
    }

    #[must_use]
    pub fn active(&mut self, now: u64) -> Vec<Invite> {
        // Keep expired ranks long enough to reject a stale snapshot with an older map value.
        self.entries
            .retain(|_, entry| entry.expires.saturating_add(MAX_STICKY_MS) > now);
        self.legacy
            .retain(|_, invite| invite.expires.saturating_add(MAX_STICKY_MS) > now);
        self.redacted.retain(|_, expires| *expires > now);
        self.legacy_declines.retain(|_, expires| *expires > now);
        self.seen.retain(|_, expires| *expires > now);
        let mut invites: Vec<_> = self
            .entries
            .values()
            .filter(|entry| !entry.removed && entry.expires > now)
            .filter_map(|entry| entry.invite.as_ref())
            .filter(|invite| {
                invite.expires > now
                    && self.slots.get(&invite.slot) == Some(&true)
                    && !self.redacted.contains_key(&invite.id)
            })
            .cloned()
            .collect();
        invites.extend(
            self.legacy
                .values()
                .filter(|invite| invite.expires > now && !self.redacted.contains_key(&invite.id))
                .cloned(),
        );
        invites
    }

    #[must_use]
    pub fn reconcile(&mut self, user: &str, now: u64) -> (Vec<Invite>, Vec<String>) {
        let mut active = Vec::new();
        for invite in self.active(now) {
            if !invite.targets(user) {
                continue;
            }
            if self.acted(&invite, user, now) {
                if self.seen.len() < MAX_ENTRIES {
                    self.seen.entry(invite.id).or_insert(invite.expires);
                }
            } else {
                active.push(invite);
            }
        }
        active.sort_by_key(|invite| (invite.origin(), invite.id.clone()));
        let mut next = BTreeMap::new();
        for invite in &active {
            if self
                .shown
                .get(&invite.slot)
                .is_some_and(|old| old.id == invite.id)
            {
                next.insert(invite.slot.clone(), invite.clone());
            }
        }
        let mut starts = Vec::new();
        for invite in active {
            if !next.contains_key(&invite.slot)
                && !self.seen.contains_key(&invite.id)
                && self.seen.len() < MAX_ENTRIES
            {
                next.insert(invite.slot.clone(), invite.clone());
                starts.push(invite.clone());
            }
            if self.seen.len() < MAX_ENTRIES {
                self.seen.entry(invite.id).or_insert(invite.expires);
            }
        }
        let ends = self
            .shown
            .values()
            .filter(|old| !next.values().any(|new| old.id == new.id))
            .map(|invite| invite.id.clone())
            .collect();
        self.shown = next;
        (starts, ends)
    }

    pub fn retry(&mut self, id: &str) {
        self.seen.remove(id);
        self.shown.retain(|_, invite| invite.id != id);
    }

    #[must_use]
    pub fn duplicate(&mut self, content: &Value, members: &[String], now: u64) -> bool {
        let Some(slot) = content["slot_id"].as_str() else {
            return false;
        };
        let new_mentions = &content["m.mentions"];
        let recipients: HashSet<_> = members
            .iter()
            .filter(|user| {
                new_mentions["room"] == true
                    || new_mentions["user_ids"].as_array().is_some_and(|users| {
                        users.iter().any(|id| id.as_str() == Some(user.as_str()))
                    })
            })
            .collect();
        self.active(now).iter().any(|invite| {
            let targets: HashSet<_> = members.iter().filter(|user| invite.targets(user)).collect();
            invite.slot == slot
                && targets == recipients
                && targets.iter().any(|user| !self.acted(invite, user, now))
        })
    }
}

fn snapshot_state<'a>(events: &'a [Value], event_type: &str, key: &str) -> Option<&'a Value> {
    events
        .iter()
        .rev()
        .find(|event| kind(event) == event_type && event["state_key"].as_str() == Some(key))
}

fn snapshot_slot<'a>(events: &'a [Value], slot: &str) -> Option<&'a Value> {
    snapshot_state(events, "m.rtc.slot", slot).or_else(|| {
        (slot == "m.call#ROOM")
            .then(|| snapshot_state(events, "org.matrix.msc4143.rtc.slot", slot))
            .flatten()
    })
}

fn snapshot_permission(events: &[Value], sender: &str) -> bool {
    let create = snapshot_state(events, "m.room.create", "");
    let version = create
        .and_then(|event| event["content"]["room_version"].as_str())
        .unwrap_or("1");
    let rules = ruma_common::RoomVersionId::try_from(version)
        .ok()
        .and_then(|version| version.rules())
        .unwrap_or(ruma_common::room_version_rules::RoomVersionRules::V1)
        .authorization;
    let creator = create.and_then(|event| {
        if rules.use_room_create_sender {
            event["sender"].as_str()
        } else {
            event["content"]["creator"].as_str()
        }
    });
    let is_creator = creator == Some(sender)
        || (rules.additional_room_creators
            && create.is_some_and(|event| {
                event["content"]["additional_creators"]
                    .as_array()
                    .is_some_and(|creators| {
                        creators
                            .iter()
                            .any(|creator| creator.as_str() == Some(sender))
                    })
            }));
    if rules.explicitly_privilege_room_creators && is_creator {
        return true;
    }
    let levels = snapshot_state(events, "m.room.power_levels", "");
    let level = |value: &Value| {
        value.as_i64().or_else(|| {
            (!rules.integer_power_levels)
                .then(|| value.as_str()?.parse::<i64>().ok())
                .flatten()
        })
    };
    let user_level = levels.map_or_else(
        || if is_creator { 100 } else { 0 },
        |event| {
            level(&event["content"]["users"][sender])
                .or_else(|| level(&event["content"]["users_default"]))
                .unwrap_or_default()
        },
    );
    let required = levels
        .and_then(|event| level(&event["content"]["notifications"]["room"]))
        .unwrap_or(50);
    user_level >= required
}

/// Validate against a complete current sticky map and room state from the same room.
/// Modern invitations missing from the map are inactive, even if a fetched event is still unexpired.
#[must_use]
pub fn validate_snapshot(event: &Value, events: &[Value], user: &str, now: u64) -> Option<Invite> {
    ruma_common::UserId::parse(user).ok()?;
    let id = event["event_id"].as_str()?;
    let current = events
        .iter()
        .find(|candidate| candidate["event_id"].as_str() == Some(id));
    let source = current.unwrap_or(event);
    let invite = Invite::parse(source, now)?;
    if invite.modern && current.is_none() {
        return None;
    }
    let mut invitations = Invitations::default();
    for value in events {
        let allowed = value["sender"]
            .as_str()
            .is_some_and(|sender| snapshot_permission(events, sender));
        invitations.apply(value, now, allowed);
    }
    if !invite.modern && current.is_none() {
        invitations.apply(source, now, snapshot_permission(events, &invite.sender));
    }
    for slot in invitations.slots_to_check(now) {
        let state = snapshot_slot(events, &slot);
        invitations.slots.insert(
            slot,
            state.is_some_and(|event| event["content"]["status"] == "open"),
        );
    }
    if !invitations.is_active_for(id, user, now) {
        return None;
    }
    invitations
        .active(now)
        .into_iter()
        .find(|invite| invite.id == id)
}

/// Presentation metadata for a validated invitation.
#[derive(Debug, serde::Serialize)]
pub struct InvitePresentation {
    pub expires_at_ms: u64,
    pub has_video: bool,
}

impl InvitePresentation {
    #[must_use]
    pub fn from_invite(invite: &Invite, events: &[Value]) -> Option<Self> {
        if invite.modern
            && snapshot_slot(events, &invite.slot)?["content"]["application"]["type"] != "m.call"
        {
            return None;
        }
        Some(Self {
            expires_at_ms: invite.expires,
            has_video: invite.has_video(events),
        })
    }
}

#[cfg(test)]
#[path = "rtc_invites_tests.rs"]
mod tests;
