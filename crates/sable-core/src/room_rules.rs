use matrix_sdk::RoomState;
use matrix_sdk::ruma::events::message::TextContentBlock;
use matrix_sdk::ruma::events::{AnyInitialStateEvent, AnyRoomAccountDataEvent, AnySyncStateEvent};
use matrix_sdk::ruma::serde::Raw;
use matrix_sdk::ruma::{OwnedRoomId, RoomId};
use serde::Deserialize;
use serde_json::{Map, Value, json};
use serde_with::{DefaultOnError, serde_as};

use crate::ResultExt;
use crate::SignedIn;
use crate::protocol::{CoreEvent, RoomRulesSettingsView, RoomRulesView, RpcError};

/// MSC4534 is unmerged, so the unstable type is the one written. Both are read.
pub(crate) const RULES_EVENTS: [&str; 2] = ["computer.gingershaped.msc4534.rules", "m.room.rules"];
const ACCEPTED_EVENTS: [&str; 2] = [
    "computer.gingershaped.msc4534.rules.accepted",
    "m.room.rules.accepted",
];

#[serde_as]
#[derive(Default, Deserialize)]
struct RulesIn {
    #[serde_as(deserialize_as = "DefaultOnError")]
    #[serde(default)]
    rules: Option<RulesText>,
    #[serde_as(deserialize_as = "DefaultOnError")]
    #[serde(default)]
    require_acceptance: bool,
    #[serde_as(deserialize_as = "DefaultOnError")]
    #[serde(default)]
    version: i64,
    #[serde_as(deserialize_as = "DefaultOnError")]
    #[serde(default)]
    delegate_to: Option<DelegateIn>,
}

#[derive(Deserialize)]
struct RulesText {
    #[serde(rename = "m.text")]
    text: TextContentBlock,
}

#[derive(Deserialize)]
struct DelegateIn {
    room: OwnedRoomId,
}

fn read(content: Option<&Value>) -> RulesIn {
    content
        .and_then(|content| RulesIn::deserialize(content).ok())
        .unwrap_or_default()
}

fn delegate(content: Option<&Value>) -> Option<OwnedRoomId> {
    read(content).delegate_to.map(|delegate| delegate.room)
}

/// `None` when the event carries no rules, which the MSC treats as no event.
fn view(
    source: &OwnedRoomId,
    content: Option<&Value>,
    accepted: Option<i64>,
    updated_at: Option<u64>,
) -> Option<RoomRulesView> {
    let stored = read(content);
    let text = stored.rules?.text;
    let body = text.find_plain().unwrap_or_default();
    let html = text.find_html();
    if body.trim().is_empty() && html.is_none() {
        return None;
    }
    Some(RoomRulesView {
        source_room_id: source.clone(),
        html: crate::matrix_html::display_html(body, html),
        version: stored.version,
        require_acceptance: stored.require_acceptance,
        accepted: accepted.is_some_and(|accepted| accepted >= stored.version),
        updated_at,
    })
}

fn settings(content: Option<&Value>) -> RoomRulesSettingsView {
    let stored = read(content);
    RoomRulesSettingsView {
        html: stored.rules.map_or_else(String::new, |rules| {
            crate::matrix_html::display_html(
                rules.text.find_plain().unwrap_or_default(),
                rules.text.find_html(),
            )
        }),
        require_acceptance: stored.require_acceptance,
        delegate_to: stored.delegate_to.map(|delegate| delegate.room),
    }
}

pub(crate) struct RulesEdit {
    pub(crate) body: String,
    pub(crate) formatted: Option<String>,
    pub(crate) require_acceptance: bool,
    pub(crate) delegate_to: Option<OwnedRoomId>,
    pub(crate) notify: bool,
}

/// Removing the rules keeps `version`, so reinstating them asks everyone again.
fn edited(stored: Option<Value>, edit: &RulesEdit) -> Value {
    let previous = read(stored.as_ref());
    let mut content = match stored {
        Some(Value::Object(content)) => content,
        _ => Map::new(),
    };
    let body = edit.body.trim();
    let mut version = previous.version;
    if body.is_empty() {
        content.shift_remove("rules");
    } else {
        if previous.rules.is_none() || edit.notify {
            version = version.saturating_add(1);
        }
        let text = edit.formatted.as_ref().map_or_else(
            || TextContentBlock::plain(body),
            |html| TextContentBlock::html(body, html),
        );
        content.insert("rules".to_owned(), json!({ "m.text": text }));
    }
    content.insert("version".to_owned(), version.into());
    content.insert(
        "require_acceptance".to_owned(),
        edit.require_acceptance.into(),
    );
    match &edit.delegate_to {
        Some(room) => {
            content.insert("delegate_to".to_owned(), json!({ "room": room }));
        }
        None => {
            content.shift_remove("delegate_to");
        }
    }
    Value::Object(content)
}

fn copied(stored: Value, source: &Value, source_version: i64) -> Value {
    let previous = read(Some(&stored));
    let mut content = match stored {
        Value::Object(content) => content,
        _ => Map::new(),
    };
    let text = source.get("rules").cloned();
    let changed = content.get("rules") != text.as_ref();
    match text {
        Some(text) => {
            content.insert("rules".to_owned(), text);
        }
        None => {
            content.shift_remove("rules");
        }
    }
    let version = if changed {
        previous.version.saturating_add(1).max(source_version)
    } else {
        previous.version
    };
    content.insert("version".to_owned(), version.into());
    content.insert(
        "require_acceptance".to_owned(),
        read(Some(source)).require_acceptance.into(),
    );
    Value::Object(content)
}

fn event_type<T>(raw: &Raw<T>) -> Option<String> {
    raw.get_field::<String>("type").ok().flatten()
}

impl SignedIn {
    async fn rules_event(
        &self,
        room_id: &OwnedRoomId,
    ) -> Result<Option<(Value, Option<u64>)>, RpcError> {
        // Neither type is synced, so a room without rules costs a request for each on its first
        // open. Together they take one round trip instead of two.
        let read = |event_type: &str| {
            self.room_state_event(room_id.clone(), event_type.to_owned(), String::new())
        };
        let (unstable, stable) = tokio::join!(read(RULES_EVENTS[0]), read(RULES_EVENTS[1]));
        unstable?.map_or(stable, |event| Ok(Some(event)))
    }

    async fn rules_content(&self, room_id: &OwnedRoomId) -> Result<Option<Value>, RpcError> {
        Ok(self.rules_event(room_id).await?.map(|(content, _)| content))
    }

    async fn accepted_rules_version(&self, room_id: &OwnedRoomId) -> Result<Option<i64>, RpcError> {
        let mut accepted = self.state().accepted_rules.lock().get(room_id).copied();
        for event_type in ACCEPTED_EVENTS {
            let version = self
                .room_document(room_id, event_type)
                .await?
                .and_then(|content| content.get("last_accepted_version")?.as_i64());
            accepted = accepted.max(version);
        }
        Ok(accepted)
    }

    pub(crate) async fn room_rules(
        &self,
        room_id: &OwnedRoomId,
    ) -> Result<Option<RoomRulesView>, RpcError> {
        let own = self.rules_event(room_id).await?;
        let client = self.client();
        let delegated = delegate(own.as_ref().map(|(content, _)| content)).filter(|room| {
            room != room_id
                && client
                    .get_room(room)
                    .is_some_and(|room| room.state() == RoomState::Joined)
        });
        let (source, event) = match delegated {
            Some(source) => {
                let event = self.rules_event(&source).await?;
                (source, event)
            }
            None => (room_id.clone(), own),
        };
        let Some((content, updated_at)) = event else {
            return Ok(None);
        };
        let accepted = self.accepted_rules_version(&source).await?;
        Ok(view(&source, Some(&content), accepted, updated_at))
    }

    pub(crate) async fn accept_room_rules(
        &self,
        room_id: OwnedRoomId,
        version: i64,
    ) -> Result<(), RpcError> {
        const LABEL: &str = "accept_room_rules";
        let _guard = self.state().account_data_writes.lock().await;
        if self
            .accepted_rules_version(&room_id)
            .await?
            .is_some_and(|accepted| accepted >= version)
        {
            return Ok(());
        }
        let raw = Raw::new(&json!({ "last_accepted_version": version }))
            .or_failed(self.core(), LABEL)?
            .cast_unchecked();
        self.room(&room_id)?
            .set_account_data_raw(ACCEPTED_EVENTS[0].into(), raw)
            .await
            .or_failed(self.core(), LABEL)?;
        self.state().accepted_rules.lock().insert(room_id, version);
        Ok(())
    }

    pub(crate) async fn delegated_rules_state(
        &self,
        space_id: Option<&OwnedRoomId>,
    ) -> Option<Raw<AnyInitialStateEvent>> {
        let space_id = space_id?;
        let space_rules = self.rules_content(space_id).await.ok()??;
        let source = read(Some(&space_rules));
        source.rules.as_ref()?;
        let mut content = copied(Value::Object(Map::new()), &space_rules, source.version);
        content
            .as_object_mut()?
            .insert("delegate_to".to_owned(), json!({ "room": space_id }));
        let event = json!({ "type": RULES_EVENTS[0], "state_key": "", "content": content });
        Raw::new(&event).ok().map(Raw::cast_unchecked)
    }

    pub(crate) async fn room_rules_settings(
        &self,
        room_id: &OwnedRoomId,
    ) -> Result<RoomRulesSettingsView, RpcError> {
        Ok(settings(self.rules_content(room_id).await?.as_ref()))
    }

    pub(crate) async fn set_room_rules(
        &self,
        room_id: OwnedRoomId,
        edit: &RulesEdit,
    ) -> Result<(), RpcError> {
        let stored = self.rules_content(&room_id).await?;
        let content = edited(stored, edit);
        self.send_state(room_id.clone(), RULES_EVENTS[0], "", &content)
            .await?;
        // Otherwise the editor's own acceptance prompt covers Room Settings.
        if read(Some(&content)).rules.is_some() {
            let version = read(Some(&content)).version;
            if let Err(error) = self.accept_room_rules(room_id.clone(), version).await {
                tracing::warn!(?error, "own rules acceptance not saved");
            }
        }
        self.copy_rules_to_delegates(&room_id, &content).await;
        self.core().emit(CoreEvent::RoomRulesChanged { room_id });
        Ok(())
    }

    async fn copy_rules_to_delegates(&self, source: &OwnedRoomId, content: &Value) {
        let client = self.client();
        let Some(own_user) = client.user_id().map(ToOwned::to_owned) else {
            return;
        };
        let Some(space) = client.get_room(source).filter(|room| room.is_space()) else {
            return;
        };
        let children = self
            .core()
            .with_open_stores(async || crate::view::space_children(&space).await)
            .await
            .unwrap_or_default();
        let source_rules = read(Some(content));
        for child in children {
            let Some(room) = RoomId::parse(&child.room_id)
                .ok()
                .and_then(|room_id| client.get_room(&room_id))
                .filter(|room| room.state() == RoomState::Joined)
            else {
                continue;
            };
            let room_id = room.room_id().to_owned();
            if &room_id == source {
                continue;
            }
            let Ok(Some(stored)) = self.rules_content(&room_id).await else {
                continue;
            };
            if delegate(Some(&stored)).as_ref() != Some(source) {
                continue;
            }
            if !room
                .power_levels_or_default()
                .await
                .user_can_send_state(&own_user, RULES_EVENTS[0].into())
            {
                continue;
            }
            let copy = copied(stored, content, source_rules.version);
            if let Err(error) = self
                .send_state(room_id.clone(), RULES_EVENTS[0], "", &copy)
                .await
            {
                tracing::warn!(?error, "delegated rules copy not saved");
            }
        }
    }

    pub(crate) fn watch_room_rules(&self, generation: u64) {
        let client = self.client();
        let rules = client.add_event_handler({
            let core = self.clone();
            move |raw: Raw<AnySyncStateEvent>, room: matrix_sdk::Room| {
                let core = core.clone();
                async move {
                    if event_type(&raw).is_some_and(|kind| RULES_EVENTS.contains(&kind.as_str())) {
                        core.core().emit_if_current(
                            generation,
                            CoreEvent::RoomRulesChanged {
                                room_id: room.room_id().to_owned(),
                            },
                        );
                    }
                }
            }
        });
        self.track_session_handler(client, rules);

        let accepted = client.add_event_handler({
            let core = self.clone();
            move |raw: Raw<AnyRoomAccountDataEvent>, room: matrix_sdk::Room| {
                let core = core.clone();
                async move {
                    if event_type(&raw).is_some_and(|kind| ACCEPTED_EVENTS.contains(&kind.as_str()))
                    {
                        core.core().emit_if_current(
                            generation,
                            CoreEvent::RoomRulesChanged {
                                room_id: room.room_id().to_owned(),
                            },
                        );
                    }
                }
            }
        });
        self.track_session_handler(client, accepted);
    }
}

#[cfg(test)]
mod tests {
    use matrix_sdk::ruma::serde::Raw;
    use matrix_sdk::ruma::{OwnedRoomId, RoomId, owned_room_id, room_id};
    use matrix_sdk::test_utils::mocks::MatrixMockServer;
    use matrix_sdk_test::JoinedRoomBuilder;
    use serde_json::{Value, json};

    use super::{
        ACCEPTED_EVENTS, RULES_EVENTS, RulesEdit, copied, delegate, edited, settings, view,
    };
    use crate::protocol::CoreEvent;
    use crate::test_support::signed_in_core;

    fn rules_event(room_id: &RoomId, content: &Value) -> Value {
        json!({
            "type": RULES_EVENTS[0],
            "state_key": "",
            "sender": "@admin:example.org",
            "event_id": format!("$rules-{}", room_id.as_str().trim_start_matches('!')),
            "origin_server_ts": 1,
            "content": content,
        })
    }

    fn accepted_event(version: i64) -> Value {
        json!({
            "type": ACCEPTED_EVENTS[0],
            "content": { "last_accepted_version": version },
        })
    }

    fn raw<T>(event: &Value) -> Raw<T> {
        Raw::new(event).unwrap().cast_unchecked()
    }

    #[tokio::test]
    async fn a_joined_delegate_supplies_the_rules_and_their_acceptance() {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;
        let room_id = room_id!("!room:example.org");
        let space_id = room_id!("!space:example.org");
        let mut own = rules(1);
        own["delegate_to"] = json!({ "room": space_id });
        server
            .sync_room(
                &client,
                JoinedRoomBuilder::new(room_id).add_state_event(raw(&rules_event(room_id, &own))),
            )
            .await;
        let (core, _events) = signed_in_core(&server, client.clone()).await;
        let session = core.signed_in().unwrap();

        let alone = session
            .room_rules(&room_id.to_owned())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(alone.source_room_id, room_id);
        assert_eq!(alone.version, 1);
        assert!(!alone.accepted);
        assert_eq!(alone.updated_at, Some(1));

        server
            .sync_room(
                &client,
                JoinedRoomBuilder::new(space_id)
                    .add_state_event(raw(&rules_event(space_id, &rules(7))))
                    .add_account_data(raw(&accepted_event(7))),
            )
            .await;

        let delegated = session
            .room_rules(&room_id.to_owned())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(delegated.source_room_id, space_id);
        assert_eq!(delegated.version, 7);
        assert!(delegated.accepted);
    }

    #[tokio::test]
    async fn synced_rules_and_acceptances_are_announced() {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;
        let room_id = room_id!("!room:example.org");
        server.sync_joined_room(&client, room_id).await;
        let (core, mut events) = signed_in_core(&server, client.clone()).await;
        let session = core.signed_in().unwrap();
        session.watch_room_rules(1);

        server
            .sync_room(
                &client,
                JoinedRoomBuilder::new(room_id)
                    .add_timeline_event(raw(&rules_event(room_id, &rules(1))))
                    .add_account_data(raw(&accepted_event(1))),
            )
            .await;

        let announced: Vec<OwnedRoomId> = std::iter::from_fn(|| events.try_recv().ok())
            .filter_map(|event| match event {
                CoreEvent::RoomRulesChanged { room_id } => Some(room_id),
                _ => None,
            })
            .collect();
        assert_eq!(announced, [room_id.to_owned(), room_id.to_owned()]);
    }

    fn room() -> OwnedRoomId {
        owned_room_id!("!room:example.org")
    }

    fn edit(body: &str, notify: bool) -> RulesEdit {
        RulesEdit {
            body: body.to_owned(),
            formatted: None,
            require_acceptance: true,
            delegate_to: None,
            notify,
        }
    }

    fn rules(version: i64) -> Value {
        json!({
            "rules": { "m.text": [{ "body": "Be kind" }] },
            "require_acceptance": true,
            "version": version,
        })
    }

    #[test]
    fn rules_are_accepted_only_at_or_past_their_version() {
        let content = rules(3);
        let accepted = |version| {
            view(&room(), Some(&content), version, None)
                .unwrap()
                .accepted
        };

        assert!(!accepted(None));
        assert!(!accepted(Some(2)));
        assert!(accepted(Some(3)));
        assert!(accepted(Some(4)));
    }

    #[test]
    fn an_event_without_rules_is_no_rules() {
        assert!(view(&room(), None, None, None).is_none());
        assert!(view(&room(), Some(&json!({ "version": 2 })), None, None).is_none());
        assert!(
            view(
                &room(),
                Some(&json!({ "rules": { "m.text": [{ "body": "  " }] }, "version": 2 })),
                None,
                None
            )
            .is_none()
        );
    }

    #[test]
    fn rules_html_is_sanitised() {
        let content = json!({
            "rules": { "m.text": [
                { "mimetype": "text/html", "body": "<b>Be kind</b><img src=x onerror=alert(1)>" },
                { "body": "Be kind" },
            ] },
            "version": 1,
        });
        let html = view(&room(), Some(&content), None, None).unwrap().html;

        assert!(html.contains("<b>Be kind</b>"));
        assert!(!html.contains("onerror"));
    }

    #[test]
    fn malformed_fields_fall_back_to_their_defaults() {
        let content = json!({
            "rules": { "m.text": [{ "body": "Be kind" }] },
            "require_acceptance": "yes",
            "version": "three",
            "delegate_to": { "room": 7 },
        });
        let view = view(&room(), Some(&content), None, None).unwrap();

        assert!(!view.require_acceptance);
        assert_eq!(view.version, 0);
        assert_eq!(delegate(Some(&content)), None);
    }

    #[test]
    fn the_first_rules_start_at_version_one() {
        let mut change = edit("Be kind", false);
        change.formatted = Some("<strong>Be</strong> kind".to_owned());

        assert_eq!(
            edited(None, &change),
            json!({
                "rules": { "m.text": [
                    { "mimetype": "text/html", "body": "<strong>Be</strong> kind" },
                    { "body": "Be kind" },
                ] },
                "version": 1,
                "require_acceptance": true,
            })
        );
        assert_eq!(
            edited(None, &edit("Be kind", false))["rules"],
            json!({ "m.text": [{ "body": "Be kind" }] })
        );
    }

    #[test]
    fn formatted_rules_reach_the_reader_and_the_editor() {
        let mut change = edit("Rules\nBe kind\nthe guide", false);
        change.formatted = Some(
            "<h1>Rules</h1><ol><li>Be <strong>kind</strong></li></ol>\
             <blockquote><a href=\"https://example.org\">the guide</a></blockquote>"
                .to_owned(),
        );
        let stored = edited(None, &change);

        for html in [
            view(&room(), Some(&stored), None, None).unwrap().html,
            settings(Some(&stored)).html,
        ] {
            for part in ["<h1>", "<ol>", "<strong>kind</strong>", "<blockquote>"] {
                assert!(html.contains(part), "{part} missing from {html}");
            }
            assert!(html.contains("href=\"https://example.org\""), "{html}");
        }
    }

    #[test]
    fn an_edit_bumps_the_version_only_when_members_are_asked_again() {
        assert_eq!(
            edited(Some(rules(4)), &edit("Be kinder", false))["version"],
            4
        );
        assert_eq!(
            edited(Some(rules(4)), &edit("Be kinder", true))["version"],
            5
        );
    }

    #[test]
    fn removed_rules_keep_their_version_and_ask_again_once_reinstated() {
        let removed = edited(Some(rules(4)), &edit("", true));
        assert_eq!(removed.get("rules"), None);
        assert_eq!(removed["version"], 4);

        assert_eq!(edited(Some(removed), &edit("Be kind", false))["version"], 5);
    }

    #[test]
    fn an_edit_keeps_unknown_keys_and_replaces_the_delegation() {
        let mut stored = rules(1);
        stored["org.example.extra"] = json!(true);
        stored["delegate_to"] = json!({ "room": "!old:example.org" });

        let mut change = edit("Be kind", false);
        change.delegate_to = Some(owned_room_id!("!space:example.org"));
        let delegated = edited(Some(stored), &change);
        assert_eq!(delegated["org.example.extra"], true);
        assert_eq!(
            delegate(Some(&delegated)),
            Some(owned_room_id!("!space:example.org"))
        );

        let cleared = edited(Some(delegated), &edit("Be kind", false));
        assert_eq!(cleared.get("delegate_to"), None);
    }

    #[test]
    fn the_editor_starts_empty_without_rules() {
        let removed = edited(Some(rules(1)), &edit("", false));
        let view = settings(Some(&removed));

        assert_eq!(view.html, "");
        assert!(view.require_acceptance);
        assert_eq!(view.delegate_to, None);
    }

    #[test]
    fn a_delegating_room_takes_the_text_and_keeps_its_own_version_line() {
        let mut stored = rules(2);
        stored["rules"] = json!({ "m.text": [{ "body": "Old" }] });
        stored["delegate_to"] = json!({ "room": "!space:example.org" });
        let source = rules(7);

        let copy = copied(stored, &source, 7);
        assert_eq!(copy["rules"], source["rules"]);
        assert_eq!(copy["version"], 7);
        assert_eq!(
            delegate(Some(&copy)),
            Some(owned_room_id!("!space:example.org"))
        );

        assert_eq!(copied(copy.clone(), &source, 7), copy);

        let mut later = copy;
        later["version"] = json!(9);
        let mut edited_source = rules(7);
        edited_source["rules"] = json!({ "m.text": [{ "body": "New" }] });
        assert_eq!(copied(later, &edited_source, 7)["version"], 10);
    }

    #[tokio::test]
    async fn saving_rules_accepts_them_for_the_editor() {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;
        let room_id = room_id!("!room:example.org");
        server.sync_joined_room(&client, room_id).await;
        server.mock_room_state_encryption().plain().mount().await;
        wiremock::Mock::given(wiremock::matchers::method("GET"))
            .and(wiremock::matchers::path_regex(r"/state/"))
            .respond_with(
                wiremock::ResponseTemplate::new(404)
                    .set_body_json(json!({ "errcode": "M_NOT_FOUND", "error": "not set" })),
            )
            .mount(server.server())
            .await;
        server
            .mock_room_send_state()
            .ok(matrix_sdk::ruma::event_id!("$rules"))
            .mount()
            .await;
        server
            .mock_set_room_account_data(ACCEPTED_EVENTS[0].into())
            .ok()
            .expect(1)
            .mount()
            .await;
        let (core, _events) = signed_in_core(&server, client.clone()).await;
        let session = core.signed_in().unwrap();

        session
            .set_room_rules(room_id.to_owned(), &edit("Be kind", false))
            .await
            .unwrap();

        let view = session
            .room_rules(&room_id.to_owned())
            .await
            .unwrap()
            .unwrap();
        assert!(view.require_acceptance);
        assert!(view.accepted);
    }
}
