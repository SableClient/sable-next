use sable_model::text::visible_name;

use crate::Core;
use crate::ResultExt;
use crate::api::room_state::EnableEncryptionParams;
use crate::api::room_state::SetHistoryVisibilityParams;
use crate::api::room_state::SetMemberListThresholdParams;
use crate::probed_state::Probed;
use crate::protocol::{CoreEvent, CreateJoinRuleView, RoomStateEventView, RpcError};
use crate::view;
use matrix_sdk::deserialized_responses::RawAnySyncOrStrippedState;
use matrix_sdk::ruma::api::client::state::get_state_event_for_key;
use matrix_sdk::ruma::api::error::ErrorKind;
use matrix_sdk::ruma::events::InitialStateEvent;
use matrix_sdk::ruma::events::room::encryption::RoomEncryptionEventContent;
use matrix_sdk::ruma::events::room::history_visibility::{
    HistoryVisibility, RoomHistoryVisibilityEventContent,
};
use matrix_sdk::ruma::events::room::join_rules::RoomJoinRulesEventContent;
use matrix_sdk::ruma::events::room::tombstone::RoomTombstoneEventContent;
use matrix_sdk::ruma::room::{AllowRule, JoinRule, Restricted};
use matrix_sdk::ruma::serde::Raw;
use matrix_sdk::ruma::{OwnedEventId, OwnedRoomId, RoomId};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use serde_with::VecSkipError;
use serde_with::{DefaultOnError, serde_as};
use std::collections::{BTreeMap, HashMap};

use crate::protocol::{AbbreviationView, HistoryVisibilityView};

const HISTORY_VISIBILITY_EVENT: &str = "m.room.history_visibility";
const ENCRYPTION_EVENT: &str = "m.room.encryption";
const CANONICAL_ALIAS_EVENT: &str = "m.room.canonical_alias";
const TOMBSTONE_EVENT: &str = "m.room.tombstone";
const SERVER_ACL_EVENT: &str = "m.room.server_acl";
pub(crate) const BANNER_EVENT: &str = "page.codeberg.everypizza.room.banner";
pub(crate) const MEMBER_LIST_EVENT: &str = "moe.sable.room.member_list";
const ABBREVIATIONS_EVENT: &str = "moe.sable.room.abbreviations";

const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;

fn read<T: Default + serde::de::DeserializeOwned>(content: Option<&Value>) -> T {
    content
        .and_then(|content| T::deserialize(content).ok())
        .unwrap_or_default()
}

#[serde_as]
#[derive(Default, Deserialize)]
struct HistoryVisibilityIn {
    #[serde_as(deserialize_as = "DefaultOnError")]
    #[serde(default)]
    history_visibility: Option<String>,
}

/// The spec's default when the event is missing or unreadable.
pub(crate) fn history_visibility(content: Option<&Value>) -> HistoryVisibilityView {
    match read::<HistoryVisibilityIn>(content)
        .history_visibility
        .as_deref()
    {
        Some("invited") => HistoryVisibilityView::Invited,
        Some("joined") => HistoryVisibilityView::Joined,
        Some("world_readable") => HistoryVisibilityView::WorldReadable,
        _ => HistoryVisibilityView::Shared,
    }
}

#[serde_as]
#[derive(Default, Deserialize)]
struct CanonicalAliasIn {
    #[serde_as(deserialize_as = "DefaultOnError")]
    #[serde(default)]
    alias: Option<String>,
    #[serde_as(deserialize_as = "DefaultOnError<VecSkipError<_>>")]
    #[serde(default)]
    alt_aliases: Vec<String>,
}

pub(crate) fn canonical_alias(content: Option<&Value>) -> (Option<String>, Vec<String>) {
    let content = read::<CanonicalAliasIn>(content);
    let mut alternatives: Vec<String> = Vec::new();
    for entry in content.alt_aliases {
        if !alternatives.contains(&entry) {
            alternatives.push(entry);
        }
    }
    (content.alias, alternatives)
}

/// The `{}` that clears a state event or account-data document.
#[derive(Serialize)]
pub(crate) struct EmptyContent {}

#[derive(Serialize)]
struct BannerOut {
    url: String,
}

#[derive(Serialize)]
struct MemberListOut {
    #[serde(skip_serializing_if = "Option::is_none")]
    always_listed_from: Option<i64>,
}

#[derive(Serialize)]
pub(crate) struct CanonicalAliasOut {
    #[serde(skip_serializing_if = "Option::is_none")]
    alias: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    alt_aliases: Vec<String>,
}

/// Each alternative appears once and never repeats the main address.
pub(crate) fn canonical_alias_content(
    alias: Option<&str>,
    alternatives: &[String],
) -> CanonicalAliasOut {
    let mut rest: Vec<String> = Vec::new();
    for entry in alternatives {
        if Some(entry.as_str()) != alias && !rest.contains(entry) {
            rest.push(entry.clone());
        }
    }
    CanonicalAliasOut {
        alias: alias.map(ToOwned::to_owned),
        alt_aliases: rest,
    }
}

#[serde_as]
#[derive(Default, Deserialize)]
struct BannerIn {
    #[serde(default, deserialize_with = "sable_model::field::present")]
    url: Option<UrlField>,
    #[serde_as(deserialize_as = "DefaultOnError")]
    #[serde(default)]
    content: Option<NestedBannerIn>,
}

#[serde_as]
#[derive(Deserialize)]
struct NestedBannerIn {
    #[serde_as(deserialize_as = "DefaultOnError")]
    #[serde(default)]
    url: Option<String>,
}

/// Present even when wrong-typed, so the nested url only applies to a missing one.
#[serde_as]
#[derive(Deserialize)]
struct UrlField(#[serde_as(deserialize_as = "DefaultOnError")] Option<String>);

/// Older writers nested the url under `content`.
pub(crate) fn banner_url(content: Option<&Value>) -> Option<String> {
    let banner = read::<BannerIn>(content);
    banner
        .url
        .map_or_else(|| banner.content.and_then(|nested| nested.url), |url| url.0)
        .filter(|url| url.starts_with("mxc://"))
}

#[serde_as]
#[derive(Default, Deserialize)]
struct MemberListIn {
    #[serde_as(deserialize_as = "DefaultOnError")]
    #[serde(default)]
    always_listed_from: Option<i64>,
}

pub(crate) fn always_listed_from(content: Option<&Value>) -> Option<i64> {
    read::<MemberListIn>(content)
        .always_listed_from
        .filter(|level| (-MAX_SAFE_INTEGER..=MAX_SAFE_INTEGER).contains(level))
}

pub(crate) struct AclEdit {
    pub(crate) allow: Vec<String>,
    pub(crate) deny: Vec<String>,
    pub(crate) remove_allow: Vec<String>,
    pub(crate) remove_deny: Vec<String>,
}

fn edited_list(current: &[String], added: &[String], removed: &[String]) -> Vec<String> {
    let mut list: Vec<String> = Vec::new();
    for entry in current.iter().chain(added) {
        if !removed.contains(entry) && !list.contains(entry) {
            list.push(entry.clone());
        }
    }
    list
}

#[serde_as]
#[derive(Default, Deserialize, Serialize)]
pub(crate) struct ServerAclContent {
    #[serde_as(deserialize_as = "DefaultOnError<VecSkipError<_>>")]
    #[serde(default)]
    allow: Vec<String>,
    #[serde_as(deserialize_as = "DefaultOnError<VecSkipError<_>>")]
    #[serde(default)]
    deny: Vec<String>,
    #[serde(flatten)]
    extra: Map<String, Value>,
}

/// Adds and removes server globs, keeping every other field of the event.
pub(crate) fn server_acl_content(stored: Option<Value>, edit: &AclEdit) -> ServerAclContent {
    let mut content: ServerAclContent = stored
        .and_then(|stored| serde_json::from_value(stored).ok())
        .unwrap_or_default();
    content.allow = edited_list(&content.allow, &edit.allow, &edit.remove_allow);
    content.deny = edited_list(&content.deny, &edit.deny, &edit.remove_deny);
    content
}

#[serde_as]
#[derive(Default, Deserialize)]
struct AbbreviationsIn {
    #[serde_as(deserialize_as = "DefaultOnError<VecSkipError<_>>")]
    #[serde(default)]
    entries: Vec<AbbreviationIn>,
}

#[serde_as]
#[derive(Deserialize)]
struct AbbreviationIn {
    #[serde_as(deserialize_as = "DefaultOnError")]
    #[serde(default)]
    term: Option<String>,
    #[serde_as(deserialize_as = "DefaultOnError")]
    #[serde(default)]
    definition: Option<String>,
    #[serde_as(deserialize_as = "DefaultOnError")]
    #[serde(default)]
    cased: Option<bool>,
}

pub(crate) fn abbreviations(content: Option<&Value>) -> Vec<AbbreviationView> {
    read::<AbbreviationsIn>(content)
        .entries
        .into_iter()
        .filter_map(|entry| {
            let (term, definition) = (entry.term?, entry.definition?);
            (!term.trim().is_empty()).then(|| AbbreviationView {
                term,
                definition,
                cased: entry.cased == Some(true),
            })
        })
        .collect()
}

#[derive(Serialize)]
struct AbbreviationOut {
    term: String,
    definition: String,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    cased: bool,
}

#[derive(Serialize)]
pub(crate) struct AbbreviationsOut {
    entries: Vec<AbbreviationOut>,
}

/// `cased` is written only when set, as other writers of the event expect.
pub(crate) fn abbreviations_content(entries: &[AbbreviationView]) -> AbbreviationsOut {
    AbbreviationsOut {
        entries: entries
            .iter()
            .map(|entry| AbbreviationOut {
                term: entry.term.clone(),
                definition: entry.definition.clone(),
                cased: entry.cased,
            })
            .collect(),
    }
}

impl Core {
    async fn room_state(
        &self,
        room_id: &OwnedRoomId,
        event_type: &str,
    ) -> Result<Option<Value>, RpcError> {
        self.room_state_event_content(room_id.clone(), event_type.to_owned(), String::new())
            .await
    }

    async fn write_room_state(
        &self,
        room_id: OwnedRoomId,
        event_type: &str,
        content: &impl Serialize,
    ) -> Result<(), RpcError> {
        self.send_state(room_id, event_type, "", content).await?;
        Ok(())
    }

    pub(crate) async fn history_visibility(
        &self,
        room_id: &OwnedRoomId,
    ) -> Result<HistoryVisibilityView, RpcError> {
        Ok(history_visibility(
            self.room_state(room_id, HISTORY_VISIBILITY_EVENT)
                .await?
                .as_ref(),
        ))
    }

    pub(crate) async fn set_history_visibility(
        &self,
        SetHistoryVisibilityParams {
            room_id,
            visibility,
        }: SetHistoryVisibilityParams,
    ) -> Result<(), RpcError> {
        self.write_room_state(
            room_id,
            HISTORY_VISIBILITY_EVENT,
            &RoomHistoryVisibilityEventContent::new(match visibility {
                HistoryVisibilityView::Shared => HistoryVisibility::Shared,
                HistoryVisibilityView::Invited => HistoryVisibility::Invited,
                HistoryVisibilityView::Joined => HistoryVisibility::Joined,
                HistoryVisibilityView::WorldReadable => HistoryVisibility::WorldReadable,
            }),
        )
        .await
    }

    pub(crate) async fn enable_encryption(
        &self,
        EnableEncryptionParams { room_id }: EnableEncryptionParams,
    ) -> Result<(), RpcError> {
        self.write_room_state(
            room_id,
            ENCRYPTION_EVENT,
            &RoomEncryptionEventContent::with_recommended_defaults(),
        )
        .await
    }

    pub(crate) async fn canonical_alias(
        &self,
        room_id: &OwnedRoomId,
    ) -> Result<(Option<String>, Vec<String>), RpcError> {
        Ok(canonical_alias(
            self.room_state(room_id, CANONICAL_ALIAS_EVENT)
                .await?
                .as_ref(),
        ))
    }

    pub(crate) async fn set_canonical_alias(
        &self,
        room_id: OwnedRoomId,
        alias: Option<&str>,
        alternatives: &[String],
    ) -> Result<(Option<String>, Vec<String>), RpcError> {
        let content = canonical_alias_content(alias, alternatives);
        self.write_room_state(room_id, CANONICAL_ALIAS_EVENT, &content)
            .await?;
        Ok((content.alias, content.alt_aliases))
    }

    pub(crate) async fn room_banner(
        &self,
        room_id: &OwnedRoomId,
    ) -> Result<Option<String>, RpcError> {
        Ok(banner_url(
            self.room_state(room_id, BANNER_EVENT).await?.as_ref(),
        ))
    }

    pub(crate) async fn set_room_banner(
        &self,
        room_id: OwnedRoomId,
        url: Option<&str>,
    ) -> Result<(), RpcError> {
        self.write_room_state(
            room_id,
            BANNER_EVENT,
            &BannerOut {
                url: url.unwrap_or_default().to_owned(),
            },
        )
        .await
    }

    pub(crate) async fn member_list_threshold(
        &self,
        room_id: &OwnedRoomId,
    ) -> Result<Option<i64>, RpcError> {
        Ok(always_listed_from(
            self.room_state(room_id, MEMBER_LIST_EVENT).await?.as_ref(),
        ))
    }

    pub(crate) async fn set_member_list_threshold(
        &self,
        SetMemberListThresholdParams {
            room_id,
            always_listed_from: level,
        }: SetMemberListThresholdParams,
    ) -> Result<(), RpcError> {
        self.write_room_state(
            room_id,
            MEMBER_LIST_EVENT,
            &MemberListOut {
                always_listed_from: level,
            },
        )
        .await
    }

    pub(crate) async fn update_server_acl(
        &self,
        room_id: OwnedRoomId,
        edit: &AclEdit,
    ) -> Result<(), RpcError> {
        let stored = self.room_state(&room_id, SERVER_ACL_EVENT).await?;
        self.write_room_state(room_id, SERVER_ACL_EVENT, &server_acl_content(stored, edit))
            .await
    }

    pub(crate) async fn room_abbreviations(
        &self,
        room_id: &OwnedRoomId,
    ) -> Result<Vec<AbbreviationView>, RpcError> {
        Ok(abbreviations(
            self.room_state(room_id, ABBREVIATIONS_EVENT)
                .await?
                .as_ref(),
        ))
    }

    pub(crate) async fn set_room_abbreviations(
        &self,
        room_id: OwnedRoomId,
        entries: &[AbbreviationView],
    ) -> Result<(), RpcError> {
        self.write_room_state(
            room_id,
            ABBREVIATIONS_EVENT,
            &abbreviations_content(entries),
        )
        .await
    }

    pub(crate) async fn set_tombstone(
        &self,
        room_id: OwnedRoomId,
        replacement_room: &OwnedRoomId,
        body: &str,
    ) -> Result<(), RpcError> {
        self.write_room_state(
            room_id,
            TOMBSTONE_EVENT,
            &RoomTombstoneEventContent::new(body.to_owned(), replacement_room.clone()),
        )
        .await
    }
}

#[derive(serde::Serialize)]
pub(crate) struct StateEventOut<C> {
    #[serde(rename = "type")]
    pub(crate) kind: &'static str,
    pub(crate) state_key: &'static str,
    pub(crate) content: C,
}

pub(crate) fn join_rule_content(
    rule: Option<CreateJoinRuleView>,
    parent_space: Option<&RoomId>,
) -> Option<InitialStateEvent<RoomJoinRulesEventContent>> {
    let restricted = || {
        parent_space
            .map(|space| Restricted::new(vec![AllowRule::room_membership(space.to_owned())]))
    };
    let join_rule = match rule? {
        CreateJoinRuleView::Public => JoinRule::Public,
        CreateJoinRuleView::Invite => JoinRule::Invite,
        CreateJoinRuleView::Knock => JoinRule::Knock,
        CreateJoinRuleView::Restricted => {
            restricted().map_or(JoinRule::Invite, JoinRule::Restricted)
        }
        CreateJoinRuleView::KnockRestricted => {
            restricted().map_or(JoinRule::Invite, JoinRule::KnockRestricted)
        }
    };
    Some(InitialStateEvent::with_empty_state_key(
        RoomJoinRulesEventContent::new(join_rule),
    ))
}

pub(crate) fn state_event_content(raw: &str) -> Option<serde_json::Value> {
    let value = serde_json::from_str::<serde_json::Value>(raw).ok()?;
    let is_event = value
        .as_object()
        .is_some_and(|object| object.contains_key("type") || object.contains_key("event_id"));

    if is_event {
        value.get("content").cloned()
    } else {
        Some(value)
    }
}

#[derive(serde::Serialize)]
pub(crate) struct PowerLevelsOverrideOut {
    events: BTreeMap<&'static str, i64>,
}

pub(crate) fn voice_power_level_override() -> PowerLevelsOverrideOut {
    PowerLevelsOverrideOut {
        events: BTreeMap::from([
            ("m.room.avatar", 50),
            ("m.room.canonical_alias", 50),
            ("m.room.encryption", 100),
            ("m.room.history_visibility", 100),
            ("m.room.name", 50),
            ("m.room.power_levels", 100),
            ("m.room.server_acl", 100),
            ("m.room.tombstone", 100),
            (view::CALL_MEMBER_TYPE, 0),
        ]),
    }
}

fn room_state_by_type(
    events: &[Raw<matrix_sdk::ruma::events::AnyStateEvent>],
) -> HashMap<String, Vec<RoomStateEventView>> {
    let mut state: HashMap<String, Vec<RoomStateEventView>> = HashMap::new();
    for raw in events {
        let Some(event_type) = raw.get_field::<String>("type").ok().flatten() else {
            continue;
        };
        if event_type == "m.room.member" {
            continue;
        }
        let (Some(state_key), Some(content)) = (
            raw.get_field::<String>("state_key").ok().flatten(),
            raw.get_field::<serde_json::Value>("content").ok().flatten(),
        ) else {
            continue;
        };
        state
            .entry(event_type)
            .or_default()
            .push(RoomStateEventView { state_key, content });
    }
    state
}

fn has_out_of_range_integer(value: &serde_json::Value) -> bool {
    match value {
        serde_json::Value::Number(number) => number.as_i64().map_or_else(
            || number.is_u64(),
            |int| !(-MAX_SAFE_INTEGER..=MAX_SAFE_INTEGER).contains(&int),
        ),
        serde_json::Value::Array(values) => values.iter().any(has_out_of_range_integer),
        serde_json::Value::Object(map) => map.values().any(has_out_of_range_integer),
        _ => false,
    }
}

impl Core {
    /// Every global account data write goes through here so the pack cache
    /// never serves what we just replaced.
    pub(crate) async fn set_account_data(
        &self,
        event_type: &str,
        content: &impl serde::Serialize,
    ) -> Result<(), RpcError> {
        self.remember_account_data_type(event_type).await;
        self.put_global_account_data(event_type.into(), content, "set_account_data")
            .await?;
        self.pack_cache.lock().await.forget_account_data(event_type);
        Ok(())
    }

    /// Every state write goes through here so the caches that read state back
    /// are invalidated and the cosmetic and profile listeners hear about it.
    pub(crate) async fn send_state(
        &self,
        room_id: OwnedRoomId,
        event_type: &str,
        state_key: &str,
        content: &impl serde::Serialize,
    ) -> Result<OwnedEventId, RpcError> {
        let content = &serde_json::to_value(content).or_failed(self, "send_state")?;
        if has_out_of_range_integer(content) {
            return Err(RpcError::IntegerOutOfRange);
        }
        let response = self
            .room(&room_id)
            .await?
            .send_state_event_raw(event_type, state_key, content)
            .await
            .or_failed(self, "send_state_event")?;
        self.pack_cache
            .lock()
            .await
            .note_state(&room_id, event_type, state_key, content);
        self.forget_room_state(&room_id, event_type);
        self.probed_state().remember_written(
            &room_id,
            event_type,
            state_key,
            content.clone(),
            crate::now_ms(),
        );
        if self.note_cosmetic_state(&room_id, event_type, state_key, content) {
            self.emit(CoreEvent::RoomCosmeticsChanged {
                room_id: room_id.clone(),
            });
        }
        if event_type == "m.room.member"
            && content.get("membership").and_then(|value| value.as_str()) == Some("join")
            && let Ok(user_id) = matrix_sdk::ruma::OwnedUserId::try_from(state_key)
        {
            let text = |key| {
                content
                    .get(key)
                    .and_then(|value| value.as_str())
                    .map(ToOwned::to_owned)
            };
            let (display_name, avatar_url) = (
                text("displayname").and_then(visible_name),
                text("avatar_url"),
            );
            self.overlay_profile(&room_id, &user_id, display_name.clone(), avatar_url.clone())
                .await;
            self.emit(CoreEvent::ProfileChanged {
                room_id,
                user_id,
                display_name,
                avatar_url,
            });
        }

        Ok(response.event_id)
    }

    pub(crate) async fn room_permissions(
        &self,
        room_id: &OwnedRoomId,
    ) -> Result<crate::protocol::RoomPermissionsView, RpcError> {
        self.room_access(room_id)
            .await
            .map(|(permissions, _)| permissions)
    }

    /// Permissions and the power levels they come from, in one read.
    pub(crate) async fn room_access(
        &self,
        room_id: &OwnedRoomId,
    ) -> Result<
        (
            crate::protocol::RoomPermissionsView,
            crate::protocol::RoomPowerLevelsView,
        ),
        RpcError,
    > {
        let room = self.room(room_id).await?;
        let user_id = room
            .client()
            .user_id()
            .ok_or_else(|| self.failed("room_permissions", "no session"))?
            .to_owned();
        // An invited room carries only stripped state, so the levels are
        // often absent. Spec defaults beat failing the whole command.
        let power_levels = self
            .with_open_stores(async || room.power_levels_or_default().await)
            .await;

        Ok((
            view::room_permissions(
                &power_levels,
                &user_id,
                room.encryption_state().is_encrypted(),
            ),
            view::room_power_levels(&power_levels),
        ))
    }

    pub(crate) async fn room_state_events(
        &self,
        room_id: &OwnedRoomId,
        event_type: &str,
    ) -> Result<Vec<RoomStateEventView>, RpcError> {
        let client = self.client().await?;
        let room = self.room(room_id).await?;
        let stored = self
            .with_open_stores(async || room.get_state_events(event_type.into()).await)
            .await
            .or_failed(self, "room_state_events")?;

        let events: Vec<RoomStateEventView> = stored
            .iter()
            .filter_map(|raw| {
                let (state_key, content) = match raw {
                    RawAnySyncOrStrippedState::Sync(event) => (
                        event.get_field::<String>("state_key"),
                        event.get_field::<serde_json::Value>("content"),
                    ),
                    RawAnySyncOrStrippedState::Stripped(event) => (
                        event.get_field::<String>("state_key"),
                        event.get_field::<serde_json::Value>("content"),
                    ),
                };
                Some(RoomStateEventView {
                    state_key: state_key.ok().flatten()?,
                    content: content.ok().flatten()?,
                })
            })
            .collect();

        if !events.is_empty() {
            return Ok(events);
        }
        let probed = self.probed_state().events(room_id, event_type);
        if let Some(events) = probed {
            return Ok(events);
        }

        let snapshot = self
            .room_state_snapshot(&client, room.room_id())
            .await
            .or_failed(self, "room_state_events")?;
        let state = room_state_by_type(&snapshot);
        let events = state.get(event_type).cloned().unwrap_or_default();
        self.probed_state().remember_full(room_id, state);

        Ok(events)
    }

    pub(crate) async fn room_state_event_content(
        &self,
        room_id: OwnedRoomId,
        event_type: String,
        state_key: String,
    ) -> Result<Option<serde_json::Value>, RpcError> {
        let written =
            self.probed_state()
                .written(&room_id, &event_type, &state_key, crate::now_ms());
        if written.is_some() {
            return Ok(written);
        }
        let client = self.client().await?;
        let room = self.room(&room_id).await?;
        let event = self
            .with_open_stores(async || {
                room.get_state_event(event_type.clone().into(), &state_key)
                    .await
            })
            .await
            .ok()
            .flatten();

        let content = event.and_then(|raw| {
            let field = match raw {
                RawAnySyncOrStrippedState::Sync(event) => event.get_field("content"),
                RawAnySyncOrStrippedState::Stripped(event) => event.get_field("content"),
            };
            field.ok().flatten()
        });

        if content.is_some() {
            return Ok(content);
        }
        let probed = self
            .probed_state()
            .content(&room_id, &event_type, &state_key);
        match probed {
            Probed::Present(content) => return Ok(Some(content)),
            Probed::Absent => return Ok(None),
            Probed::Unknown => {}
        }

        let content = match client
            .send(get_state_event_for_key::v3::Request::new(
                room_id.clone(),
                event_type.clone().into(),
                state_key.clone(),
            ))
            .await
        {
            Ok(response) => state_event_content(response.event_or_content.get()),
            Err(error) if error.client_api_error_kind() == Some(&ErrorKind::NotFound) => None,
            Err(error) => {
                return Err(self.rpc_error("room_state_event", &error));
            }
        };
        self.probed_state()
            .remember_content(&room_id, &event_type, &state_key, content.clone());

        Ok(content)
    }
}

#[cfg(test)]
mod tests {
    use super::state_event_content;

    use matrix_sdk::ruma::RoomId;

    use crate::protocol::CreateJoinRuleView;

    use serde_json::json;

    use super::{
        AclEdit, abbreviations, abbreviations_content, always_listed_from, banner_url,
        canonical_alias, canonical_alias_content, has_out_of_range_integer, history_visibility,
        server_acl_content,
    };

    #[test]
    fn integers_beyond_the_matrix_range_are_caught_anywhere_in_the_content() {
        assert!(!has_out_of_range_integer(&json!({
            "users_default": 9_007_199_254_740_991_i64,
            "kick": -9_007_199_254_740_991_i64,
            "ratio": 1.5,
        })));
        assert!(has_out_of_range_integer(
            &json!({ "users_default": 9_007_199_254_740_992_i64 })
        ));
        assert!(has_out_of_range_integer(
            &json!({ "users": { "@a:b": -9_007_199_254_740_992_i64 } })
        ));
        assert!(has_out_of_range_integer(&json!({ "list": [u64::MAX] })));
    }

    fn to_json(content: impl serde::Serialize) -> serde_json::Value {
        serde_json::to_value(content).unwrap()
    }

    fn owned(entries: &[&str]) -> Vec<String> {
        entries.iter().map(|entry| (*entry).to_owned()).collect()
    }

    #[test]
    fn an_acl_edit_adds_once_removes_and_keeps_other_fields() {
        let stored =
            json!({ "allow": ["*"], "deny": ["bad.example", 3], "allow_ip_literals": false });
        let edit = AclEdit {
            allow: owned(&["*", "good.example"]),
            deny: owned(&["worse.example"]),
            remove_allow: Vec::new(),
            remove_deny: owned(&["bad.example"]),
        };

        assert_eq!(
            to_json(server_acl_content(Some(stored), &edit)),
            json!({
                "allow": ["*", "good.example"],
                "deny": ["worse.example"],
                "allow_ip_literals": false,
            })
        );
    }
    use crate::protocol::{AbbreviationView, HistoryVisibilityView};

    fn entry(term: &str, definition: &str, cased: bool) -> AbbreviationView {
        AbbreviationView {
            term: term.to_owned(),
            definition: definition.to_owned(),
            cased,
        }
    }

    #[test]
    fn abbreviations_drop_malformed_entries() {
        let content = json!({ "entries": [
            null,
            "MSC",
            { "term": "", "definition": "empty term" },
            { "term": "MSC" },
            { "term": "DO", "definition": "Ocean", "cased": "yes" },
            { "term": "PR", "definition": "Pull request", "cased": true },
        ]});

        assert_eq!(
            abbreviations(Some(&content)),
            vec![
                entry("DO", "Ocean", false),
                entry("PR", "Pull request", true)
            ]
        );
        assert_eq!(
            abbreviations(Some(&json!({ "entries": "nope" }))),
            [] as [crate::protocol::AbbreviationView; 0]
        );
        assert_eq!(
            abbreviations(None),
            [] as [crate::protocol::AbbreviationView; 0]
        );
    }

    #[test]
    fn abbreviations_write_cased_only_when_set() {
        assert_eq!(
            to_json(abbreviations_content(&[
                entry("MSC", "Spec change", false),
                entry("DO", "Ocean", true)
            ])),
            json!({ "entries": [
                { "term": "MSC", "definition": "Spec change" },
                { "term": "DO", "definition": "Ocean", "cased": true },
            ]})
        );
    }

    #[test]
    fn history_visibility_falls_back_to_shared() {
        assert_eq!(
            history_visibility(Some(&json!({ "history_visibility": "joined" }))),
            HistoryVisibilityView::Joined
        );
        assert_eq!(
            history_visibility(Some(&json!({ "history_visibility": "nonsense" }))),
            HistoryVisibilityView::Shared
        );
        assert_eq!(history_visibility(None), HistoryVisibilityView::Shared);
    }

    #[test]
    fn canonical_alias_reads_unique_string_alternatives() {
        let content = json!({
            "alias": "#main:example.org",
            "alt_aliases": ["#a:example.org", 3, "#a:example.org", "#b:example.org"],
        });

        assert_eq!(
            canonical_alias(Some(&content)),
            (
                Some("#main:example.org".to_owned()),
                vec!["#a:example.org".to_owned(), "#b:example.org".to_owned()]
            )
        );
        assert_eq!(canonical_alias(None), (None, Vec::new()));
    }

    #[test]
    fn canonical_alias_content_drops_repeats_and_empty_fields() {
        let alternatives = vec![
            "#main:example.org".to_owned(),
            "#a:example.org".to_owned(),
            "#a:example.org".to_owned(),
        ];

        assert_eq!(
            to_json(canonical_alias_content(
                Some("#main:example.org"),
                &alternatives
            )),
            json!({ "alias": "#main:example.org", "alt_aliases": ["#a:example.org"] })
        );
        assert_eq!(to_json(canonical_alias_content(None, &[])), json!({}));
    }

    #[test]
    fn a_banner_must_be_an_mxc_uri_at_either_depth() {
        assert_eq!(
            banner_url(Some(&json!({ "url": "mxc://a/b" }))),
            Some("mxc://a/b".to_owned())
        );
        assert_eq!(
            banner_url(Some(&json!({ "content": { "url": "mxc://a/c" } }))),
            Some("mxc://a/c".to_owned())
        );
        assert_eq!(banner_url(Some(&json!({ "url": "https://a/b" }))), None);
        assert_eq!(banner_url(Some(&json!({ "url": "" }))), None);
    }

    #[test]
    fn the_member_list_threshold_is_a_safe_integer() {
        assert_eq!(
            always_listed_from(Some(&json!({ "always_listed_from": 50 }))),
            Some(50)
        );
        assert_eq!(
            always_listed_from(Some(&json!({ "always_listed_from": 1.5 }))),
            None
        );
        assert_eq!(
            always_listed_from(Some(
                &json!({ "always_listed_from": 9_007_199_254_740_992_i64 })
            )),
            None
        );
        assert_eq!(always_listed_from(Some(&json!({}))), None);
    }

    #[test]
    fn a_present_wrong_typed_banner_url_blocks_the_nested_one() {
        assert_eq!(
            banner_url(Some(
                &json!({ "url": 3, "content": { "url": "mxc://a/b" } })
            )),
            None
        );
        assert_eq!(
            banner_url(Some(
                &json!({ "url": null, "content": { "url": "mxc://a/b" } })
            )),
            None
        );
        assert_eq!(
            banner_url(Some(&json!({ "content": "x", "url": "mxc://a/c" }))),
            Some("mxc://a/c".to_owned())
        );
    }

    #[test]
    fn wrong_typed_settings_read_as_defaults() {
        assert_eq!(
            history_visibility(Some(&json!({ "history_visibility": 3 }))),
            HistoryVisibilityView::Shared
        );
        assert_eq!(
            canonical_alias(Some(&json!({ "alias": 3, "alt_aliases": "x" }))),
            (None, Vec::new())
        );
        assert_eq!(always_listed_from(Some(&json!("x"))), None);
    }

    #[test]
    fn the_voice_power_level_override_restates_the_default_events() {
        let value = serde_json::to_value(super::voice_power_level_override()).unwrap();
        assert_eq!(value["events"]["m.room.name"], 50);
        assert_eq!(value["events"]["m.room.encryption"], 100);
        assert_eq!(value["events"][crate::view::CALL_MEMBER_TYPE], 0);
        assert_eq!(value.as_object().unwrap().len(), 1);
    }

    #[test]
    fn a_restricted_room_without_a_space_falls_back_to_invite() {
        let rule = |kind, space: Option<&str>| {
            super::join_rule_content(
                Some(kind),
                space.map(|id| <&RoomId>::try_from(id).expect("a room id")),
            )
            .map(|rule| serde_json::to_value(rule).expect("serializes"))
            .expect("a rule")["content"]["join_rule"]
                .as_str()
                .expect("a string")
                .to_owned()
        };

        assert_eq!(rule(CreateJoinRuleView::Restricted, None), "invite");
        assert_eq!(rule(CreateJoinRuleView::KnockRestricted, None), "invite");
        assert_eq!(
            rule(CreateJoinRuleView::Restricted, Some("!s:example.org")),
            "restricted"
        );
        assert_eq!(rule(CreateJoinRuleView::Knock, None), "knock");
        assert_eq!(rule(CreateJoinRuleView::Public, None), "public");
    }

    #[test]
    fn a_restricted_room_allows_the_parent_space() {
        let content = super::join_rule_content(
            Some(CreateJoinRuleView::Restricted),
            Some(<&RoomId>::try_from("!space:example.org").expect("a room id")),
        )
        .map(|rule| serde_json::to_value(rule).expect("serializes"))
        .expect("a rule");

        assert_eq!(
            content["content"]["allow"][0]["room_id"],
            "!space:example.org"
        );
        assert_eq!(content["content"]["allow"][0]["type"], "m.room_membership");
    }

    #[test]
    fn no_join_rule_leaves_the_preset_alone() {
        assert!(super::join_rule_content(None, None).is_none());
    }

    #[test]
    fn state_event_content_accepts_content_and_full_event_responses() {
        assert_eq!(
            state_event_content(r#"{"url":"mxc://example.org/banner"}"#),
            Some(serde_json::json!({"url": "mxc://example.org/banner"}))
        );
        assert_eq!(
            state_event_content(
                r#"{"type":"page.codeberg.everypizza.room.banner","content":{"url":"mxc://example.org/banner"}}"#
            ),
            Some(serde_json::json!({"url": "mxc://example.org/banner"}))
        );
    }
}
