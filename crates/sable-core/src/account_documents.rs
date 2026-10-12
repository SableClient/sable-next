use matrix_sdk::ruma::OwnedRoomId;
use serde_json::{Map, Value, json};

use crate::Core;
use crate::protocol::{CommandErr, InviteAvatarsView, MediaPreviewConfigView, MediaPreviewsView};

const MEDIA_PREVIEW_EVENT: &str = "m.media_preview_config";
const UNSTABLE_MEDIA_PREVIEW_EVENT: &str = "io.element.msc4278.media_preview_config";
const DISMISSED_INVITES_EVENT: &str = "moe.sable.dismissed_invites";

/// MSC4278: a present but unknown value means the safest choice, `off`.
pub(crate) fn media_preview_config(content: Option<&Value>) -> MediaPreviewConfigView {
    let field = |name: &str| content.and_then(|content| content.get(name));
    MediaPreviewConfigView {
        media_previews: field("media_previews").map(|value| match value.as_str() {
            Some("on") => MediaPreviewsView::On,
            Some("private") => MediaPreviewsView::Private,
            _ => MediaPreviewsView::Off,
        }),
        invite_avatars: field("invite_avatars").map(|value| match value.as_str() {
            Some("on") => InviteAvatarsView::On,
            _ => InviteAvatarsView::Off,
        }),
    }
}

/// Keeps every other field of the stored event and overwrites only what is set.
pub(crate) fn media_preview_content(
    stored: Option<Value>,
    update: MediaPreviewConfigView,
) -> Value {
    let mut content = match stored {
        Some(Value::Object(map)) => map,
        _ => Map::new(),
    };
    if let Some(previews) = update.media_previews {
        let value = match previews {
            MediaPreviewsView::On => "on",
            MediaPreviewsView::Private => "private",
            MediaPreviewsView::Off => "off",
        };
        content.insert("media_previews".to_owned(), json!(value));
    }
    if let Some(avatars) = update.invite_avatars {
        let value = match avatars {
            InviteAvatarsView::On => "on",
            InviteAvatarsView::Off => "off",
        };
        content.insert("invite_avatars".to_owned(), json!(value));
    }
    Value::Object(content)
}

pub(crate) fn dismissed_invites(content: Option<&Value>) -> Vec<OwnedRoomId> {
    content
        .and_then(|content| content.get("roomIds"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .filter_map(|room_id| OwnedRoomId::try_from(room_id).ok())
        .collect()
}

impl Core {
    async fn account_document(&self, event_type: &str) -> Result<Option<Value>, CommandErr> {
        Ok(self
            .global_account_data(event_type.into(), "account_document")
            .await?
            .and_then(|raw| raw.deserialize_as::<Value>().ok()))
    }

    async fn stored_media_preview_config(&self) -> Result<Option<Value>, CommandErr> {
        match self.account_document(MEDIA_PREVIEW_EVENT).await? {
            Some(stable) => Ok(Some(stable)),
            None => self.account_document(UNSTABLE_MEDIA_PREVIEW_EVENT).await,
        }
    }

    async fn room_document(
        &self,
        room_id: &OwnedRoomId,
        event_type: &str,
    ) -> Result<Option<Value>, CommandErr> {
        Ok(self
            .room(room_id)
            .await?
            .account_data(event_type.into())
            .await
            .map_err(|error| self.room_error("room_account_data", error))?
            .and_then(|raw| raw.get_field::<Value>("content").ok().flatten()))
    }

    /// The room's own config when `room_id` is given, the account's otherwise.
    pub(crate) async fn media_preview_settings(
        &self,
        room_id: Option<&OwnedRoomId>,
    ) -> Result<MediaPreviewConfigView, CommandErr> {
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
        update: MediaPreviewConfigView,
    ) -> Result<MediaPreviewConfigView, CommandErr> {
        let _guard = self.account_data_lock.lock().await;
        let content = media_preview_content(self.stored_media_preview_config().await?, update);
        self.set_account_data(MEDIA_PREVIEW_EVENT, &content).await?;
        self.set_account_data(UNSTABLE_MEDIA_PREVIEW_EVENT, &content)
            .await?;
        Ok(media_preview_config(Some(&content)))
    }

    pub(crate) async fn dismissed_invites(&self) -> Result<Vec<OwnedRoomId>, CommandErr> {
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
    ) -> Result<Vec<OwnedRoomId>, CommandErr> {
        let _guard = self.account_data_lock.lock().await;
        let mut room_ids = self.dismissed_invites().await?;
        room_ids.retain(|known| *known != room_id);
        if dismissed {
            room_ids.push(room_id);
        }
        self.set_account_data(DISMISSED_INVITES_EVENT, &json!({ "roomIds": room_ids }))
            .await?;
        Ok(room_ids)
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{dismissed_invites, media_preview_config, media_preview_content};
    use crate::protocol::{InviteAvatarsView, MediaPreviewConfigView, MediaPreviewsView};

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
        assert!(dismissed_invites(Some(&json!({ "roomIds": "nope" }))).is_empty());
    }
}
