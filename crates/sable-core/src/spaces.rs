use matrix_sdk::Client;
use matrix_sdk::ruma::events::GlobalAccountDataEventType;
use matrix_sdk::ruma::events::macros::EventContent;
use matrix_sdk::ruma::serde::Raw;
use matrix_sdk::ruma::{OwnedRoomId, RoomId};
use serde::{Deserialize, Serialize};

use crate::protocol::SidebarItemView;

const SIDEBAR_EVENT_TYPE: &str = "in.cinny.spaces";

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
                items.push(SidebarItemView::Space { room_id });
            }
            StoredItem::Unknown(_) => {}
            StoredItem::Folder { id, name, content } => {
                if id.is_empty() || seen_folders.contains(&id) {
                    continue;
                }

                let content: Vec<OwnedRoomId> = content
                    .iter()
                    .filter_map(|room_id| fresh_room_id(room_id, &mut seen_rooms))
                    .collect();
                if content.is_empty() {
                    continue;
                }

                seen_folders.push(id.clone());
                items.push(SidebarItemView::Folder {
                    id,
                    name: name.filter(|name| !name.trim().is_empty()),
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
            SidebarItemView::Space { room_id } => StoredItem::Space(room_id.to_string()),
            SidebarItemView::Folder { id, name, content } => StoredItem::Folder {
                id: id.clone(),
                name: name.clone(),
                content: content.iter().map(ToString::to_string).collect(),
            },
        })
        .collect()
}

/// # Errors
///
/// Returns the store error when the account data cannot be read.
pub async fn sidebar(client: &Client) -> Result<Vec<SidebarItemView>, matrix_sdk::Error> {
    let raw = client
        .account()
        .account_data_raw(GlobalAccountDataEventType::from(SIDEBAR_EVENT_TYPE))
        .await?;

    Ok(raw
        .and_then(|raw| {
            raw.deserialize_as_unchecked::<SidebarSpacesEventContent>()
                .ok()
        })
        .as_ref()
        .map(items)
        .unwrap_or_default())
}

/// # Errors
///
/// Returns the store or homeserver error when the account data cannot be read
/// back or written.
pub async fn set_sidebar(
    client: &Client,
    items: &[SidebarItemView],
) -> Result<(), matrix_sdk::Error> {
    let event_type = GlobalAccountDataEventType::from(SIDEBAR_EVENT_TYPE);
    let mut content = client
        .account()
        .account_data_raw(event_type.clone())
        .await?
        .and_then(|raw| {
            raw.deserialize_as_unchecked::<serde_json::Map<String, serde_json::Value>>()
                .ok()
        })
        .unwrap_or_default();

    content.insert(
        "sidebar".to_owned(),
        serde_json::to_value(stored_items(items))?,
    );

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
    fn reads_spaces_and_folders_in_order() {
        let parsed = parse(serde_json::json!({
            "sidebar": [
                "!one:example.org",
                { "id": "f1", "name": "Work", "content": ["!two:example.org"] },
                "!three:example.org",
            ]
        }));

        assert_eq!(parsed.len(), 3);
        assert!(
            matches!(&parsed[0], SidebarItemView::Space { room_id } if room_id == "!one:example.org")
        );
        assert!(
            matches!(&parsed[1], SidebarItemView::Folder { id, name, content }
                if id == "f1"
                    && name.as_deref() == Some("Work")
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
                { "id": "f2", "name": "   ", "content": ["!two:example.org"] },
                { "id": "f2", "content": ["!three:example.org"] },
            ]
        }));

        assert_eq!(parsed.len(), 1);
        assert!(
            matches!(&parsed[0], SidebarItemView::Folder { id, name, content }
                if id == "f2"
                    && name.is_none()
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

        assert!(sidebar(&client).await.expect("layout").is_empty());
    }

    #[tokio::test]
    async fn writing_keeps_the_keys_it_does_not_model() {
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

        let _put = Mock::given(method("PUT"))
            .and(path_regex(
                r"^/_matrix/client/v3/user/.*/account_data/in\.cinny\.spaces$",
            ))
            .and(body_partial_json(json!({
                "sidebar": [{ "id": "f1", "name": "Work", "content": ["!two:example.org"] }],
                "shortcut": ["!one:example.org"],
                "org.example.other": { "kept": true }
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
                content: vec!["!two:example.org".parse().expect("room id")],
            }],
        )
        .await
        .expect("write");
    }
}
