use crate::api::account::SetMediaPreviewConfigParams;
use std::collections::{BTreeMap, BTreeSet};

use matrix_sdk::ruma::{OwnedEventId, OwnedRoomId};
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{Map, Value};
use serde_with::{DefaultOnError, VecSkipError, serde_as};

use crate::protocol::{
    InviteAvatarsView, MediaPreviewConfigView, MediaPreviewsView, NotificationModeView, RpcError,
    ThreadRefView, ThreadSidebarView,
};
use crate::{Core, ResultExt, SignedIn};

const MEDIA_PREVIEW_EVENT: &str = "m.media_preview_config";
const UNSTABLE_MEDIA_PREVIEW_EVENT: &str = "io.element.msc4278.media_preview_config";
const DISMISSED_INVITES_EVENT: &str = "moe.sable.dismissed_invites";
pub(crate) const DM_SPACES_EVENT: &str = "moe.sable.dm_spaces";
const SPACE_NOTIFICATIONS_EVENT: &str = "moe.sable.space_notifications";
pub(crate) const THREAD_SIDEBAR_EVENT: &str = "moe.sable.next.thread_sidebar";

#[derive(Default, Deserialize)]
struct MediaPreviewIn {
    #[serde(default, deserialize_with = "media_previews")]
    media_previews: Option<MediaPreviewsView>,
    #[serde(default, deserialize_with = "invite_avatars")]
    invite_avatars: Option<InviteAvatarsView>,
}

/// A present but unknown value means the safest choice, `off`.
fn media_previews<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<MediaPreviewsView>, D::Error> {
    Ok(Some(match Value::deserialize(deserializer)?.as_str() {
        Some("on") => MediaPreviewsView::On,
        Some("private") => MediaPreviewsView::Private,
        _ => MediaPreviewsView::Off,
    }))
}

fn invite_avatars<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<InviteAvatarsView>, D::Error> {
    Ok(Some(match Value::deserialize(deserializer)?.as_str() {
        Some("on") => InviteAvatarsView::On,
        _ => InviteAvatarsView::Off,
    }))
}

/// MSC4278: a present but unknown value means the safest choice, `off`.
pub(crate) fn media_preview_config(content: Option<&Value>) -> MediaPreviewConfigView {
    let config = content
        .and_then(|content| MediaPreviewIn::deserialize(content).ok())
        .unwrap_or_default();
    MediaPreviewConfigView {
        media_previews: config.media_previews,
        invite_avatars: config.invite_avatars,
    }
}

/// The room's own level, which wins over the account's. `Err` when the store could not be read,
/// so the caller can keep what it had.
pub(crate) async fn room_media_previews(
    room: &matrix_sdk::Room,
) -> Result<Option<MediaPreviewsView>, ()> {
    for event in [MEDIA_PREVIEW_EVENT, UNSTABLE_MEDIA_PREVIEW_EVENT] {
        let content = room
            .account_data(event.into())
            .await
            .map_err(|_| ())?
            .and_then(|raw| raw.get_field::<Value>("content").ok().flatten());
        if let Some(level) = media_preview_config(content.as_ref()).media_previews {
            return Ok(Some(level));
        }
    }
    Ok(None)
}

pub(crate) fn is_media_preview_event(event_type: &str) -> bool {
    [MEDIA_PREVIEW_EVENT, UNSTABLE_MEDIA_PREVIEW_EVENT].contains(&event_type)
}

/// Mirrors the app's `previewsShown`.
#[cfg(not(target_family = "wasm"))]
pub(crate) async fn shows_media_previews(room: &matrix_sdk::Room) -> bool {
    use matrix_sdk::ruma::events::room::join_rules::JoinRule;

    let mut level = room_media_previews(room).await.ok().flatten();
    for event in [MEDIA_PREVIEW_EVENT, UNSTABLE_MEDIA_PREVIEW_EVENT] {
        let content = room
            .client()
            .account()
            .account_data_raw(event.into())
            .await
            .ok()
            .flatten()
            .and_then(|raw| raw.deserialize_as::<Value>().ok());
        level = level.or_else(|| media_preview_config(content.as_ref()).media_previews);
    }
    match level.unwrap_or(MediaPreviewsView::On) {
        MediaPreviewsView::On => true,
        MediaPreviewsView::Off => false,
        MediaPreviewsView::Private => matches!(
            room.join_rule(),
            Some(
                JoinRule::Invite
                    | JoinRule::Knock
                    | JoinRule::Restricted(_)
                    | JoinRule::KnockRestricted(_)
            )
        ),
    }
}

/// Keeps every other field of the stored event and overwrites only what is set.
fn room_media_previews_content(
    stored: Option<Value>,
    previews: Option<MediaPreviewsView>,
) -> Value {
    let update = MediaPreviewConfigView {
        media_previews: previews,
        invite_avatars: None,
    };
    let mut content = media_preview_content(stored, update);
    if previews.is_none()
        && let Value::Object(map) = &mut content
    {
        map.remove("media_previews");
    }
    content
}

fn stored_object(stored: Option<Value>) -> Map<String, Value> {
    match stored {
        Some(Value::Object(map)) => map,
        _ => Map::new(),
    }
}

pub(crate) fn media_preview_content(
    stored: Option<Value>,
    update: MediaPreviewConfigView,
) -> Value {
    let mut content = stored_object(stored);
    if let Some(previews) = update.media_previews {
        let value = match previews {
            MediaPreviewsView::On => "on",
            MediaPreviewsView::Private => "private",
            MediaPreviewsView::Off => "off",
        };
        content.insert("media_previews".to_owned(), Value::from(value));
    }
    if let Some(avatars) = update.invite_avatars {
        let value = match avatars {
            InviteAvatarsView::On => "on",
            InviteAvatarsView::Off => "off",
        };
        content.insert("invite_avatars".to_owned(), Value::from(value));
    }
    Value::Object(content)
}

#[serde_as]
#[derive(Default, Deserialize)]
struct DismissedInvitesIn {
    #[serde_as(deserialize_as = "DefaultOnError<VecSkipError<_>>")]
    #[serde(default, rename = "roomIds")]
    room_ids: Vec<OwnedRoomId>,
}

pub(crate) fn dismissed_invites(content: Option<&Value>) -> Vec<OwnedRoomId> {
    content
        .and_then(|content| DismissedInvitesIn::deserialize(content).ok())
        .unwrap_or_default()
        .room_ids
}

/// From the synced copy, for reads too frequent to fetch the server each time.
pub(crate) async fn synced_dm_spaces(
    client: &matrix_sdk::Client,
) -> BTreeMap<OwnedRoomId, Vec<OwnedRoomId>> {
    let content = client
        .account()
        .account_data_raw(DM_SPACES_EVENT.into())
        .await
        .ok()
        .flatten()
        .and_then(|raw| raw.deserialize_as::<Value>().ok());
    dm_spaces(content.as_ref())
}

/// Direct chats placed in spaces only for this account, keyed by chat.
pub(crate) fn dm_spaces(content: Option<&Value>) -> BTreeMap<OwnedRoomId, Vec<OwnedRoomId>> {
    let Some(Value::Object(rooms)) = content.and_then(|content| content.get("rooms")) else {
        return BTreeMap::new();
    };
    rooms
        .iter()
        .filter_map(|(room_id, spaces)| {
            let room_id = OwnedRoomId::try_from(room_id.as_str()).ok()?;
            let spaces: Vec<_> = spaces
                .as_array()?
                .iter()
                .filter_map(|space| OwnedRoomId::try_from(space.as_str()?).ok())
                .collect();
            (!spaces.is_empty()).then_some((room_id, spaces))
        })
        .collect()
}

fn dm_spaces_content(
    stored: Option<Value>,
    room_id: OwnedRoomId,
    space_ids: Vec<OwnedRoomId>,
) -> Value {
    let mut links = dm_spaces(stored.as_ref());
    if space_ids.is_empty() {
        links.remove(&room_id);
    } else {
        links.insert(room_id, space_ids);
    }
    let mut content = stored_object(stored);
    content.insert(
        "rooms".to_owned(),
        serde_json::to_value(links).unwrap_or_default(),
    );
    Value::Object(content)
}

/// `exempt` rooms keep the account default instead of their space's mode.
#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct SpaceNotifications {
    pub(crate) modes: BTreeMap<OwnedRoomId, NotificationModeView>,
    pub(crate) exempt: BTreeSet<OwnedRoomId>,
}

pub(crate) fn space_notifications(content: Option<&Value>) -> SpaceNotifications {
    let modes = match content.and_then(|content| content.get("spaces")) {
        Some(Value::Object(spaces)) => spaces
            .iter()
            .filter_map(|(space_id, mode)| {
                Some((
                    OwnedRoomId::try_from(space_id.as_str()).ok()?,
                    NotificationModeView::deserialize(mode).ok()?,
                ))
            })
            .collect(),
        _ => BTreeMap::new(),
    };
    let exempt = match content.and_then(|content| content.get("exempt")) {
        Some(Value::Array(rooms)) => rooms
            .iter()
            .filter_map(|room| OwnedRoomId::try_from(room.as_str()?).ok())
            .collect(),
        _ => BTreeSet::new(),
    };
    SpaceNotifications { modes, exempt }
}

fn space_notifications_content(
    stored: Option<Value>,
    update: impl FnOnce(&mut SpaceNotifications),
) -> Value {
    let mut notifications = space_notifications(stored.as_ref());
    update(&mut notifications);
    let mut content = stored_object(stored);
    content.insert(
        "spaces".to_owned(),
        serde_json::to_value(notifications.modes).unwrap_or_default(),
    );
    content.insert(
        "exempt".to_owned(),
        serde_json::to_value(notifications.exempt).unwrap_or_default(),
    );
    Value::Object(content)
}

#[derive(Serialize)]
struct DismissedInvitesOut {
    #[serde(rename = "roomIds")]
    room_ids: Vec<OwnedRoomId>,
}

#[serde_as]
#[derive(Default, Deserialize)]
struct ThreadSidebarIn {
    #[serde_as(deserialize_as = "DefaultOnError<VecSkipError<_>>")]
    #[serde(default)]
    pins: Vec<ThreadRefView>,
    #[serde_as(deserialize_as = "DefaultOnError<VecSkipError<_>>")]
    #[serde(default)]
    dismissed: Vec<ThreadRefView>,
}

fn dedupe_thread_refs(
    items: Vec<ThreadRefView>,
    seen: &mut BTreeSet<(OwnedRoomId, OwnedEventId)>,
) -> Vec<ThreadRefView> {
    items
        .into_iter()
        .filter(|entry| seen.insert((entry.room_id.clone(), entry.event_id.clone())))
        .collect()
}

fn remove_thread_ref(
    items: &mut Vec<ThreadRefView>,
    room_id: &OwnedRoomId,
    event_id: &OwnedEventId,
) {
    items.retain(|entry| entry.room_id != *room_id || entry.event_id != *event_id);
}

fn apply_thread_sidebar_flag(
    sidebar: &mut ThreadSidebarView,
    room_id: OwnedRoomId,
    event_id: OwnedEventId,
    pin: bool,
    enabled: bool,
) {
    let (primary, other) = if pin {
        (&mut sidebar.pins, &mut sidebar.dismissed)
    } else {
        (&mut sidebar.dismissed, &mut sidebar.pins)
    };
    remove_thread_ref(primary, &room_id, &event_id);
    if enabled {
        remove_thread_ref(other, &room_id, &event_id);
        primary.push(ThreadRefView { room_id, event_id });
    }
}

pub(crate) fn thread_sidebar(content: Option<&Value>) -> ThreadSidebarView {
    let parsed = content
        .and_then(|content| ThreadSidebarIn::deserialize(content).ok())
        .unwrap_or_default();
    let mut seen = BTreeSet::new();
    let pins = dedupe_thread_refs(parsed.pins, &mut seen);
    let dismissed = dedupe_thread_refs(parsed.dismissed, &mut seen);
    ThreadSidebarView { pins, dismissed }
}

fn thread_sidebar_content(
    stored: Option<Value>,
    update: impl FnOnce(&mut ThreadSidebarView),
) -> Value {
    let mut sidebar = thread_sidebar(stored.as_ref());
    update(&mut sidebar);
    let mut content = stored_object(stored);
    content.insert(
        "pins".to_owned(),
        serde_json::to_value(sidebar.pins).unwrap_or_default(),
    );
    content.insert(
        "dismissed".to_owned(),
        serde_json::to_value(sidebar.dismissed).unwrap_or_default(),
    );
    Value::Object(content)
}

impl SignedIn {
    async fn account_document(&self, event_type: &str) -> Result<Option<Value>, RpcError> {
        Ok(self
            .global_account_data(event_type.into(), "account_document")
            .await?
            .and_then(|raw| raw.deserialize_as::<Value>().ok()))
    }

    async fn stored_media_preview_config(&self) -> Result<Option<Value>, RpcError> {
        match self.account_document(MEDIA_PREVIEW_EVENT).await? {
            Some(stable) => Ok(Some(stable)),
            None => self.account_document(UNSTABLE_MEDIA_PREVIEW_EVENT).await,
        }
    }

    pub(crate) async fn room_document(
        &self,
        room_id: &OwnedRoomId,
        event_type: &str,
    ) -> Result<Option<Value>, RpcError> {
        let room = self.room(room_id)?;
        Ok(self
            .core()
            .with_open_stores(async || room.account_data(event_type.into()).await)
            .await
            .or_failed(self.core(), "room_account_data")?
            .and_then(|raw| raw.get_field::<Value>("content").ok().flatten()))
    }

    /// The room's own config when `room_id` is given, the account's otherwise.
    pub(crate) async fn media_preview_settings(
        &self,
        room_id: Option<&OwnedRoomId>,
    ) -> Result<MediaPreviewConfigView, RpcError> {
        let content = match room_id {
            None => self.stored_media_preview_config().await?,
            Some(room_id) => match self.room_document(room_id, MEDIA_PREVIEW_EVENT).await? {
                Some(stable) => Some(stable),
                None => {
                    self.room_document(room_id, UNSTABLE_MEDIA_PREVIEW_EVENT)
                        .await?
                }
            },
        };
        Ok(media_preview_config(content.as_ref()))
    }

    /// Written under both types until clients stop reading the unstable one.
    pub(crate) async fn set_media_preview_settings(
        &self,
        SetMediaPreviewConfigParams { config: update }: SetMediaPreviewConfigParams,
    ) -> Result<MediaPreviewConfigView, RpcError> {
        let _guard = self.state().account_data_writes.lock().await;
        let mut content = Value::Null;
        self.update_account_data_locked(
            &[MEDIA_PREVIEW_EVENT, UNSTABLE_MEDIA_PREVIEW_EVENT],
            "set_media_preview_settings",
            async |stored| {
                content = media_preview_content(stored, update);
                Ok(Some(content.clone()))
            },
        )
        .await?;
        self.set_account_data(UNSTABLE_MEDIA_PREVIEW_EVENT, &content)
            .await?;
        Ok(media_preview_config(Some(&content)))
    }

    pub(crate) async fn set_room_media_previews(
        &self,
        room_id: &OwnedRoomId,
        previews: Option<MediaPreviewsView>,
    ) -> Result<MediaPreviewConfigView, RpcError> {
        let _guard = self.state().account_data_writes.lock().await;
        let stored = match self.room_document(room_id, MEDIA_PREVIEW_EVENT).await? {
            Some(stable) => Some(stable),
            None => {
                self.room_document(room_id, UNSTABLE_MEDIA_PREVIEW_EVENT)
                    .await?
            }
        };
        let content = room_media_previews_content(stored, previews);
        let room = self.room(room_id)?;
        for event in [MEDIA_PREVIEW_EVENT, UNSTABLE_MEDIA_PREVIEW_EVENT] {
            let raw = ruma::serde::Raw::new(&content)
                .or_failed(self.core(), "set_room_media_previews")?
                .cast_unchecked();
            room.set_account_data_raw(event.into(), raw)
                .await
                .or_failed(self.core(), "set_room_media_previews")?;
        }
        Ok(media_preview_config(Some(&content)))
    }

    pub(crate) async fn dm_spaces(
        &self,
    ) -> Result<BTreeMap<OwnedRoomId, Vec<OwnedRoomId>>, RpcError> {
        Ok(dm_spaces(
            self.account_document(DM_SPACES_EVENT).await?.as_ref(),
        ))
    }

    pub(crate) async fn set_dm_spaces(
        &self,
        room_id: OwnedRoomId,
        space_ids: Vec<OwnedRoomId>,
    ) -> Result<BTreeMap<OwnedRoomId, Vec<OwnedRoomId>>, RpcError> {
        let content = self
            .update_account_data(&[DM_SPACES_EVENT], "set_dm_spaces", async |stored| {
                Ok(Some(dm_spaces_content(stored, room_id, space_ids)))
            })
            .await?;
        Ok(dm_spaces(content.as_ref()))
    }

    pub(crate) async fn space_notifications(&self) -> Result<SpaceNotifications, RpcError> {
        Ok(space_notifications(
            self.account_document(SPACE_NOTIFICATIONS_EVENT)
                .await?
                .as_ref(),
        ))
    }

    pub(crate) async fn update_space_notifications(
        &self,
        update: impl FnOnce(&mut SpaceNotifications),
    ) -> Result<SpaceNotifications, RpcError> {
        let content = self
            .update_account_data(
                &[SPACE_NOTIFICATIONS_EVENT],
                "update_space_notifications",
                async |stored| Ok(Some(space_notifications_content(stored, update))),
            )
            .await?;
        Ok(space_notifications(content.as_ref()))
    }

    pub(crate) async fn dismissed_invites(&self) -> Result<Vec<OwnedRoomId>, RpcError> {
        Ok(dismissed_invites(
            self.account_document(DISMISSED_INVITES_EVENT)
                .await?
                .as_ref(),
        ))
    }

    pub(crate) async fn set_invite_dismissed(
        &self,
        room_id: OwnedRoomId,
        dismissed: bool,
    ) -> Result<Vec<OwnedRoomId>, RpcError> {
        let content = self
            .update_account_data(
                &[DISMISSED_INVITES_EVENT],
                "set_invite_dismissed",
                async |stored| {
                    let mut room_ids = dismissed_invites(stored.as_ref());
                    room_ids.retain(|known| *known != room_id);
                    if dismissed {
                        room_ids.push(room_id);
                    }
                    serde_json::to_value(DismissedInvitesOut { room_ids })
                        .map(Some)
                        .or_failed(self.core(), "set_invite_dismissed")
                },
            )
            .await?;
        Ok(dismissed_invites(content.as_ref()))
    }

    pub(crate) async fn thread_sidebar(&self) -> Result<ThreadSidebarView, RpcError> {
        Ok(thread_sidebar(
            self.account_document(THREAD_SIDEBAR_EVENT).await?.as_ref(),
        ))
    }

    async fn update_thread_sidebar(
        &self,
        operation: &'static str,
        update: impl FnOnce(&mut ThreadSidebarView),
    ) -> Result<ThreadSidebarView, RpcError> {
        let content = self
            .update_account_data(&[THREAD_SIDEBAR_EVENT], operation, async |stored| {
                Ok(Some(thread_sidebar_content(stored, update)))
            })
            .await?;
        Ok(thread_sidebar(content.as_ref()))
    }

    pub(crate) async fn set_thread_pin(
        &self,
        room_id: OwnedRoomId,
        event_id: OwnedEventId,
        pinned: bool,
    ) -> Result<ThreadSidebarView, RpcError> {
        self.update_thread_sidebar("set_thread_pin", |sidebar| {
            apply_thread_sidebar_flag(sidebar, room_id, event_id, true, pinned);
        })
        .await
    }

    pub(crate) async fn set_thread_dismissed(
        &self,
        room_id: OwnedRoomId,
        event_id: OwnedEventId,
        dismissed: bool,
    ) -> Result<ThreadSidebarView, RpcError> {
        self.update_thread_sidebar("set_thread_dismissed", |sidebar| {
            apply_thread_sidebar_flag(sidebar, room_id, event_id, false, dismissed);
        })
        .await
    }
}

impl Core {
    pub(crate) async fn synced_dm_spaces_of(
        client: &matrix_sdk::Client,
        room_id: &ruma::RoomId,
    ) -> Vec<OwnedRoomId> {
        synced_dm_spaces(client)
            .await
            .remove(room_id)
            .unwrap_or_default()
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{
        apply_thread_sidebar_flag, dismissed_invites, dm_spaces, dm_spaces_content,
        media_preview_config, media_preview_content, room_media_previews_content,
        space_notifications, space_notifications_content, thread_sidebar, thread_sidebar_content,
    };
    use crate::protocol::{
        InviteAvatarsView, MediaPreviewConfigView, MediaPreviewsView, NotificationModeView,
        ThreadRefView, ThreadSidebarView,
    };

    #[test]
    fn a_space_mode_and_an_exempt_room_are_stored_and_cleared() {
        let stored = json!({ "spaces": { "!old:a.org": "all", "!bad:a.org": "loud" }, "kept": 1 });
        let space = matrix_sdk::ruma::owned_room_id!("!space:a.org");
        let room = matrix_sdk::ruma::owned_room_id!("!room:a.org");

        let set = space_notifications_content(Some(stored), |notifications| {
            notifications
                .modes
                .insert(space.clone(), NotificationModeView::Mute);
            notifications.exempt.insert(room.clone());
        });
        assert_eq!(
            set,
            json!({
                "spaces": { "!old:a.org": "all", "!space:a.org": "mute" },
                "exempt": ["!room:a.org"],
                "kept": 1
            })
        );
        let read = space_notifications(Some(&set));
        assert_eq!(read.modes.get(&space), Some(&NotificationModeView::Mute));
        assert!(read.exempt.contains(&room));

        let cleared = space_notifications_content(Some(set), |notifications| {
            notifications.modes.remove(&space);
            notifications.exempt.remove(&room);
        });
        assert_eq!(
            cleared,
            json!({ "spaces": { "!old:a.org": "all" }, "exempt": [], "kept": 1 })
        );
    }

    #[test]
    fn a_dm_is_linked_to_spaces_and_unlinked_when_none_are_left() {
        let stored = json!({ "rooms": { "!dm:a.org": ["!old:a.org"], "!bad": "x" }, "kept": 1 });
        let dm = matrix_sdk::ruma::owned_room_id!("!dm:a.org");
        let space = matrix_sdk::ruma::owned_room_id!("!space:a.org");

        let linked = dm_spaces_content(Some(stored), dm.clone(), vec![space.clone()]);
        assert_eq!(
            linked,
            json!({ "rooms": { "!dm:a.org": ["!space:a.org"] }, "kept": 1 })
        );
        assert_eq!(dm_spaces(Some(&linked)).get(&dm), Some(&vec![space]));

        let unlinked = dm_spaces_content(Some(linked), dm, Vec::new());
        assert_eq!(unlinked, json!({ "rooms": {}, "kept": 1 }));
    }

    #[test]
    fn a_room_override_is_set_and_cleared_without_touching_other_fields() {
        let stored = json!({ "invite_avatars": "off", "media_previews": "on" });

        let off = room_media_previews_content(Some(stored.clone()), Some(MediaPreviewsView::Off));
        assert_eq!(
            off,
            json!({ "invite_avatars": "off", "media_previews": "off" })
        );

        let cleared = room_media_previews_content(Some(stored), None);
        assert_eq!(cleared, json!({ "invite_avatars": "off" }));
        assert_eq!(media_preview_config(Some(&cleared)).media_previews, None);
    }

    #[test]
    fn an_unknown_preview_value_reads_as_off_and_a_missing_one_as_unset() {
        assert_eq!(
            media_preview_config(Some(&json!({ "media_previews": "sometimes" }))),
            MediaPreviewConfigView {
                media_previews: Some(MediaPreviewsView::Off),
                invite_avatars: None,
            }
        );
        assert_eq!(
            media_preview_config(Some(&json!({
                "media_previews": "private",
                "invite_avatars": "on",
            }))),
            MediaPreviewConfigView {
                media_previews: Some(MediaPreviewsView::Private),
                invite_avatars: Some(InviteAvatarsView::On),
            }
        );
        assert_eq!(
            media_preview_config(None),
            MediaPreviewConfigView::default()
        );
    }

    #[test]
    fn an_update_keeps_the_fields_it_does_not_set() {
        let stored = json!({ "invite_avatars": "off", "x.other": 1 });
        let update = MediaPreviewConfigView {
            media_previews: Some(MediaPreviewsView::On),
            invite_avatars: None,
        };

        assert_eq!(
            media_preview_content(Some(stored), update),
            json!({ "invite_avatars": "off", "media_previews": "on", "x.other": 1 })
        );
    }

    #[test]
    fn dismissed_invites_keep_only_valid_room_ids() {
        let content = json!({ "roomIds": ["!a:example.org", 3, "not a room"] });

        assert_eq!(
            dismissed_invites(Some(&content))
                .iter()
                .map(ToString::to_string)
                .collect::<Vec<_>>(),
            vec!["!a:example.org"]
        );
        assert_eq!(
            dismissed_invites(Some(&json!({ "roomIds": "nope" }))),
            Vec::<ruma::OwnedRoomId>::new()
        );
    }

    #[test]
    fn a_non_string_preview_value_reads_as_off() {
        let read = media_preview_config(Some(
            &json!({ "media_previews": 3, "invite_avatars": null }),
        ));
        assert_eq!(read.media_previews, Some(MediaPreviewsView::Off));
        assert_eq!(read.invite_avatars, Some(InviteAvatarsView::Off));
        assert_eq!(
            media_preview_config(Some(&json!("x"))),
            MediaPreviewConfigView::default()
        );
    }

    #[test]
    fn thread_sidebar_skips_invalid_entries_deduplicates_keeps_mutex_and_preserves_unknown_fields()
    {
        let room = matrix_sdk::ruma::owned_room_id!("!room:example.org");
        let first = matrix_sdk::ruma::owned_event_id!("$first:example.org");
        let second = matrix_sdk::ruma::owned_event_id!("$second:example.org");
        let third = matrix_sdk::ruma::owned_event_id!("$third:example.org");

        let parsed = thread_sidebar(Some(&json!({
            "pins": [
                { "room_id": room, "event_id": first },
                { "room_id": room, "event_id": first },
                { "room_id": "invalid", "event_id": "$bad:example.org" },
                { "room_id": room, "event_id": second }
            ],
            "dismissed": [
                { "room_id": room, "event_id": first },
                { "room_id": room, "event_id": third },
                { "room_id": room, "event_id": third },
                { "room_id": room, "event_id": 42 }
            ]
        })));
        assert_eq!(
            parsed,
            ThreadSidebarView {
                pins: vec![
                    ThreadRefView {
                        room_id: room.clone(),
                        event_id: first.clone(),
                    },
                    ThreadRefView {
                        room_id: room.clone(),
                        event_id: second,
                    },
                ],
                dismissed: vec![ThreadRefView {
                    room_id: room.clone(),
                    event_id: third,
                }],
            }
        );

        let dismissed = thread_sidebar_content(
            Some(json!({
                "pins": [{ "room_id": room, "event_id": first }],
                "dismissed": [],
                "extra": 1
            })),
            |sidebar| {
                apply_thread_sidebar_flag(sidebar, room.clone(), first.clone(), false, true);
            },
        );
        assert_eq!(
            dismissed,
            json!({
                "pins": [],
                "dismissed": [{ "room_id": room, "event_id": first }],
                "extra": 1
            })
        );

        let repinned = thread_sidebar_content(Some(dismissed), |sidebar| {
            apply_thread_sidebar_flag(sidebar, room, first, true, true);
        });
        assert_eq!(
            repinned,
            json!({
                "pins": [{ "room_id": "!room:example.org", "event_id": "$first:example.org" }],
                "dismissed": [],
                "extra": 1
            })
        );
    }
}
