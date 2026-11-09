use matrix_sdk::Client;
use matrix_sdk::ruma::events::GlobalAccountDataEventType;
use matrix_sdk::ruma::events::macros::EventContent;
use matrix_sdk::ruma::serde::Raw;
use matrix_sdk::ruma::{OwnedRoomId, RoomId};
use serde::{Deserialize, Serialize};

use crate::Core;
use crate::ResultExt;
use crate::protocol::{RpcError, SidebarItemView};

/// The sidebar written over whatever else the account data already carries.
#[derive(Serialize)]
struct SidebarPatch {
    sidebar: Vec<StoredItem>,
    #[serde(flatten)]
    extra: serde_json::Map<String, serde_json::Value>,
}

impl SidebarPatch {
    fn new(
        items: &[SidebarItemView],
        mut extra: serde_json::Map<String, serde_json::Value>,
    ) -> Self {
        extra.remove("sidebar");
        Self {
            sidebar: stored_items(items),
            extra,
        }
    }
}

const SIDEBAR_EVENT_TYPE: &str = "in.cinny.spaces";

pub(crate) const AVATAR_OVERRIDE_EVENT: &str = "org.matrix.msc3015.m.room.avatar.override";

fn override_url(content: &serde_json::Value) -> Option<String> {
    content
        .get("url")
        .and_then(serde_json::Value::as_str)
        .filter(|url| url.starts_with("mxc://"))
        .map(str::to_owned)
}

/// `Err` when the store could not be read, so the caller can keep what it had.
pub(crate) async fn avatar_override(room: &matrix_sdk::Room) -> Result<Option<String>, ()> {
    let raw = room
        .account_data(AVATAR_OVERRIDE_EVENT.into())
        .await
        .map_err(|_| ())?;
    Ok(raw
        .and_then(|raw| raw.get_field::<serde_json::Value>("content").ok().flatten())
        .as_ref()
        .and_then(override_url))
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, EventContent)]
#[ruma_event(type = "in.cinny.spaces", kind = GlobalAccountData)]
pub struct SidebarSpacesEventContent {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sidebar: Option<Vec<StoredItem>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shortcut: Option<Vec<String>>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(untagged)]
pub enum StoredItem {
    Space(String),
    Folder {
        id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        name: Option<String>,
        #[serde(
            default,
            rename = "moe.sable.icon",
            skip_serializing_if = "Option::is_none"
        )]
        icon: Option<String>,
        content: Vec<String>,
    },
    Unknown(serde_json::Value),
}

#[must_use]
pub fn items(content: &SidebarSpacesEventContent) -> Vec<SidebarItemView> {
    let stored = content.sidebar.clone().unwrap_or_else(|| {
        content
            .shortcut
            .iter()
            .flatten()
            .map(|room_id| StoredItem::Space(room_id.clone()))
            .collect()
    });

    let mut items = Vec::new();
    let mut seen_rooms = Vec::new();
    let mut seen_folders = Vec::new();

    for item in stored {
        match item {
            StoredItem::Space(room_id) => {
                let Some(room_id) = fresh_room_id(&room_id, &mut seen_rooms) else {
                    continue;
                };
                items.push(SidebarItemView::Space {
                    room_id: room_id.into(),
                });
            }
            StoredItem::Unknown(_) => {}
            StoredItem::Folder {
                id,
                name,
                icon,
                content,
            } => {
                if id.is_empty() || seen_folders.contains(&id) {
                    continue;
                }

                let content: Vec<String> = content
                    .iter()
                    .filter_map(|room_id| fresh_room_id(room_id, &mut seen_rooms))
                    .map(Into::into)
                    .collect();
                if content.is_empty() {
                    continue;
                }

                seen_folders.push(id.clone());
                items.push(SidebarItemView::Folder {
                    id,
                    name: name.filter(|name| !name.trim().is_empty()),
                    icon: icon.filter(|icon| icon.starts_with("mxc://")),
                    content,
                });
            }
        }
    }

    items
}

fn fresh_room_id(raw: &str, seen: &mut Vec<OwnedRoomId>) -> Option<OwnedRoomId> {
    let room_id = RoomId::parse(raw).ok()?;
    if seen.contains(&room_id) {
        return None;
    }

    seen.push(room_id.clone());
    Some(room_id)
}

fn stored_items(items: &[SidebarItemView]) -> Vec<StoredItem> {
    items
        .iter()
        .map(|item| match item {
            SidebarItemView::Space { room_id } => StoredItem::Space(room_id.clone()),
            SidebarItemView::Folder {
                id,
                name,
                icon,
                content,
            } => StoredItem::Folder {
                id: id.clone(),
                name: name.clone(),
                icon: icon.clone(),
                content: content.clone(),
            },
        })
        .collect()
}

impl Core {
    pub(crate) async fn space_sidebar(&self) -> Result<Vec<SidebarItemView>, RpcError> {
        let client = self.client().await?;
        self.with_open_stores(async || sidebar(&client).await)
            .await
            .or_failed(self, "space_sidebar")
    }

    pub(crate) async fn set_space_sidebar(
        &self,
        items: &[SidebarItemView],
    ) -> Result<(), RpcError> {
        set_sidebar(&self.client().await?, items)
            .await
            .or_failed(self, "set_space_sidebar")
    }

    /// `None` writes `{}`, which MSC3015 reads as no override.
    pub(crate) async fn set_avatar_override(
        &self,
        room_id: &OwnedRoomId,
        url: Option<&str>,
    ) -> Result<(), RpcError> {
        if url.is_some_and(|url| !url.starts_with("mxc://")) {
            return Err(RpcError::InvalidMedia);
        }
        let room = self.room(room_id).await?;
        let content = url.map_or_else(
            || serde_json::json!({}),
            |url| serde_json::json!({ "url": url }),
        );
        let raw = Raw::new(&content)
            .or_failed(self, "set_avatar_override")?
            .cast_unchecked();
        room.set_account_data_raw(AVATAR_OVERRIDE_EVENT.into(), raw)
            .await
            .or_failed(self, "set_avatar_override")?;
        Ok(())
    }
}

/// # Errors
///
/// Returns the store or deserialization error when the account data cannot be read.
pub async fn sidebar(client: &Client) -> Result<Vec<SidebarItemView>, matrix_sdk::Error> {
    let raw = client
        .account()
        .account_data_raw(GlobalAccountDataEventType::from(SIDEBAR_EVENT_TYPE))
        .await?;

    Ok(raw
        .map(|raw| raw.deserialize_as_unchecked::<SidebarSpacesEventContent>())
        .transpose()?
        .as_ref()
        .map(items)
        .unwrap_or_default())
}

/// # Errors
///
/// Returns the homeserver or serialization error when the account data cannot be
/// read back or written.
pub async fn set_sidebar(
    client: &Client,
    items: &[SidebarItemView],
) -> Result<(), matrix_sdk::Error> {
    let event_type = GlobalAccountDataEventType::from(SIDEBAR_EVENT_TYPE);
    let extra = client
        .account()
        .fetch_account_data(event_type.clone())
        .await?
        .map(|raw| raw.deserialize_as_unchecked::<serde_json::Map<String, serde_json::Value>>())
        .transpose()?
        .unwrap_or_default();

    let content = SidebarPatch::new(items, extra);

    client
        .account()
        .set_account_data_raw(event_type, Raw::new(&content)?.cast_unchecked())
        .await?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{SidebarItemView, SidebarSpacesEventContent, items, stored_items};

    fn parse(json: serde_json::Value) -> Vec<SidebarItemView> {
        items(&serde_json::from_value::<SidebarSpacesEventContent>(json).expect("content"))
    }

    #[test]
    fn an_avatar_override_must_be_an_mxc_url() {
        use super::override_url;
        use serde_json::json;

        assert_eq!(
            override_url(&json!({ "url": "mxc://example.org/a" })).as_deref(),
            Some("mxc://example.org/a")
        );
        assert_eq!(override_url(&json!({})), None);
        assert_eq!(
            override_url(&json!({ "url": "https://example.org/a" })),
            None
        );
    }

    #[test]
    fn reads_spaces_and_folders_in_order() {
        let parsed = parse(serde_json::json!({
            "sidebar": [
                "!one:example.org",
                {
                    "id": "f1",
                    "name": "Work",
                    "moe.sable.icon": "mxc://example.org/icon",
                    "content": ["!two:example.org"],
                },
                "!three:example.org",
            ]
        }));

        assert_eq!(parsed.len(), 3);
        assert!(
            matches!(&parsed[0], SidebarItemView::Space { room_id } if room_id == "!one:example.org")
        );
        assert!(
            matches!(&parsed[1], SidebarItemView::Folder { id, name, icon, content }
                if id == "f1"
                    && name.as_deref() == Some("Work")
                    && icon.as_deref() == Some("mxc://example.org/icon")
                    && content.first().is_some_and(|room_id| room_id == "!two:example.org"))
        );
        assert!(
            matches!(&parsed[2], SidebarItemView::Space { room_id } if room_id == "!three:example.org")
        );
    }

    #[test]
    fn falls_back_to_the_pre_folder_list() {
        let parsed = parse(serde_json::json!({ "shortcut": ["!one:example.org"] }));

        assert!(
            matches!(&parsed[0], SidebarItemView::Space { room_id } if room_id == "!one:example.org")
        );
    }

    #[test]
    fn a_room_is_placed_once() {
        let parsed = parse(serde_json::json!({
            "sidebar": [
                "!one:example.org",
                { "id": "f1", "content": ["!one:example.org", "!two:example.org"] },
                "!two:example.org",
            ]
        }));

        assert_eq!(parsed.len(), 2);
        assert!(matches!(&parsed[1], SidebarItemView::Folder { content, .. }
                if content.len() == 1
                    && content.first().is_some_and(|room_id| room_id == "!two:example.org")));
    }

    #[test]
    fn one_malformed_entry_leaves_the_rest_standing() {
        let parsed = parse(serde_json::json!({
            "sidebar": [
                { "id": "f1", "name": "Work" },
                42,
                "!one:example.org",
            ]
        }));

        assert_eq!(parsed.len(), 1);
        assert!(
            matches!(&parsed[0], SidebarItemView::Space { room_id } if room_id == "!one:example.org")
        );
    }

    #[test]
    fn writing_creates_the_key_on_an_untouched_account() {
        let stored = serde_json::to_value(stored_items(&[SidebarItemView::Space {
            room_id: "!one:example.org".parse().expect("room id"),
        }]))
        .expect("stored");

        assert_eq!(stored, serde_json::json!(["!one:example.org"]));
    }

    #[test]
    fn drops_unrenderable_entries() {
        let parsed = parse(serde_json::json!({
            "sidebar": [
                "not-a-room-id",
                { "id": "f1", "content": ["also-not-one"] },
                { "id": "", "content": ["!one:example.org"] },
                { "id": "f2", "name": "   ", "moe.sable.icon": "https://example.org/x.png", "content": ["!two:example.org"] },
                { "id": "f2", "content": ["!three:example.org"] },
            ]
        }));

        assert_eq!(parsed.len(), 1);
        assert!(
            matches!(&parsed[0], SidebarItemView::Folder { id, name, icon, content }
                if id == "f2"
                    && name.is_none()
                    && icon.is_none()
                    && content.first().is_some_and(|room_id| room_id == "!two:example.org"))
        );
    }

    #[test]
    fn round_trips_through_the_wire_shape() {
        let json = serde_json::json!({
            "sidebar": [
                "!one:example.org",
                { "id": "f1", "name": "Work", "content": ["!two:example.org"] },
            ]
        });
        let stored = serde_json::to_value(stored_items(&parse(json.clone()))).expect("stored");

        assert_eq!(stored, json["sidebar"]);
    }
}

#[cfg(test)]
mod server_tests {
    use matrix_sdk::ruma::events::StaticEventContent;
    use matrix_sdk::test_utils::mocks::MatrixMockServer;
    use serde_json::json;
    use wiremock::matchers::{body_partial_json, method, path_regex};
    use wiremock::{Mock, ResponseTemplate};

    use super::{
        SIDEBAR_EVENT_TYPE, SidebarItemView, SidebarSpacesEventContent, set_sidebar, sidebar,
    };

    #[test]
    fn the_event_type_is_the_one_the_handler_listens_for() {
        assert_eq!(SidebarSpacesEventContent::TYPE, SIDEBAR_EVENT_TYPE);
    }

    #[tokio::test]
    async fn reads_a_layout_sync_delivered() {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;

        server
            .mock_sync()
            .ok_and_run(&client, |builder| {
                builder.add_custom_global_account_data(json!({
                    "type": "in.cinny.spaces",
                    "content": {
                        "sidebar": [
                            "!one:example.org",
                            { "id": "f1", "name": "Work", "content": ["!two:example.org"] },
                        ]
                    }
                }));
            })
            .await;

        let items = sidebar(&client).await.expect("layout");

        assert_eq!(items.len(), 2);
        assert!(
            matches!(&items[0], SidebarItemView::Space { room_id } if room_id == "!one:example.org")
        );
        assert!(matches!(&items[1], SidebarItemView::Folder { id, .. } if id == "f1"));
    }

    #[tokio::test]
    async fn an_account_that_never_arranged_the_rail_has_no_layout() {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;

        assert_eq!(
            sidebar(&client).await.expect("layout"),
            [] as [sable_model::sidebar::SidebarItemView; 0]
        );
    }

    #[tokio::test]
    async fn an_unreadable_layout_is_not_an_empty_layout() {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;
        server
            .mock_sync()
            .ok_and_run(&client, |builder| {
                builder.add_custom_global_account_data(json!({
                    "type": "in.cinny.spaces",
                    "content": { "sidebar": "invalid" }
                }));
            })
            .await;

        sidebar(&client).await.unwrap_err();
    }

    #[tokio::test]
    async fn a_failed_server_read_prevents_a_layout_write() {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;
        Mock::given(method("GET"))
            .and(path_regex(
                r"^/_matrix/client/v3/user/.*/account_data/in\.cinny\.spaces$",
            ))
            .respond_with(ResponseTemplate::new(403).set_body_json(json!({
                "errcode": "M_FORBIDDEN", "error": "denied"
            })))
            .expect(1)
            .mount(server.server())
            .await;
        Mock::given(method("PUT"))
            .and(path_regex(
                r"^/_matrix/client/v3/user/.*/account_data/in\.cinny\.spaces$",
            ))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({})))
            .expect(0)
            .mount(server.server())
            .await;

        assert!(set_sidebar(&client, &[]).await.is_err());
    }

    #[tokio::test]
    async fn an_unreadable_server_document_prevents_a_layout_write() {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;
        Mock::given(method("GET"))
            .and(path_regex(
                r"^/_matrix/client/v3/user/.*/account_data/in\.cinny\.spaces$",
            ))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!([])))
            .expect(1)
            .mount(server.server())
            .await;
        Mock::given(method("PUT"))
            .and(path_regex(
                r"^/_matrix/client/v3/user/.*/account_data/in\.cinny\.spaces$",
            ))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({})))
            .expect(0)
            .mount(server.server())
            .await;

        assert!(set_sidebar(&client, &[]).await.is_err());
    }

    #[tokio::test]
    async fn writing_keeps_the_server_keys_when_the_store_is_stale() {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;
        server
            .mock_sync()
            .ok_and_run(&client, |builder| {
                builder.add_custom_global_account_data(json!({
                    "type": "in.cinny.spaces",
                    "content": {
                        "sidebar": ["!one:example.org"],
                        "shortcut": ["!one:example.org"],
                        "org.example.other": { "kept": true }
                    }
                }));
            })
            .await;

        let _get = Mock::given(method("GET"))
            .and(path_regex(
                r"^/_matrix/client/v3/user/.*/account_data/in\.cinny\.spaces$",
            ))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "sidebar": ["!remote:example.org"],
                "shortcut": ["!remote:example.org"],
                "org.example.other": { "newer": true }
            })))
            .mount_as_scoped(server.server())
            .await;

        let _put = Mock::given(method("PUT"))
            .and(path_regex(
                r"^/_matrix/client/v3/user/.*/account_data/in\.cinny\.spaces$",
            ))
            .and(body_partial_json(json!({
                "sidebar": [{ "id": "f1", "name": "Work", "content": ["!two:example.org"] }],
                "shortcut": ["!remote:example.org"],
                "org.example.other": { "newer": true }
            })))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({})))
            .expect(1)
            .mount_as_scoped(server.server())
            .await;

        set_sidebar(
            &client,
            &[SidebarItemView::Folder {
                id: "f1".to_owned(),
                name: Some("Work".to_owned()),
                icon: None,
                content: vec!["!two:example.org".parse().expect("room id")],
            }],
        )
        .await
        .expect("write");
    }

    #[test]
    fn a_sidebar_patch_replaces_the_sidebar_and_keeps_the_rest() {
        let existing = serde_json::json!({"sidebar": ["!old:x"], "shortcut": ["!kept:x"]});
        let patch = super::SidebarPatch::new(
            &[SidebarItemView::Space {
                room_id: "!new:x".to_owned(),
            }],
            existing.as_object().unwrap().clone(),
        );
        assert_eq!(
            serde_json::to_value(&patch).unwrap(),
            serde_json::json!({"sidebar": ["!new:x"], "shortcut": ["!kept:x"]})
        );
    }
}
