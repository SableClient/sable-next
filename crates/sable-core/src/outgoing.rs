use crate::Core;
use crate::protocol::{
    ImageSourcePackReferenceView, ImageSourcePackView, PackImageInfoView, RpcError,
};
use matrix_sdk::room::reply::{EnforceThread, Reply as SdkReply, ReplyError};
use matrix_sdk::ruma::OwnedUserId;
use matrix_sdk::ruma::events::location::LocationContent;
use matrix_sdk::ruma::events::relation::{Reply, Thread};
use matrix_sdk::ruma::events::room::ImageInfo;
use matrix_sdk::ruma::events::room::message::{
    AddMentions, ImageMessageEventContent, LocationMessageEventContent, MessageType, Relation,
    ReplyWithinThread, RoomMessageEventContent,
};
use matrix_sdk::ruma::{OwnedEventId, OwnedMxcUri, OwnedRoomId};

use crate::messages::outgoing_mentions;
use crate::protocol::MessageKind;
use sable_model::truncate::truncate_graphemes;

pub(crate) fn thread_reply(
    in_reply_to: Option<OwnedEventId>,
    thread_root: Option<OwnedEventId>,
    silent: bool,
) -> Option<SdkReply> {
    match (in_reply_to, thread_root) {
        (Some(event_id), thread_root) => Some(reply_to(event_id, thread_root.is_some(), silent)),
        (None, Some(root)) => Some(SdkReply {
            enforce_thread: EnforceThread::Threaded(ReplyWithinThread::No),
            ..reply_to(root, false, silent)
        }),
        (None, None) => None,
    }
}

pub(crate) const fn reply_to(event_id: OwnedEventId, in_thread: bool, silent: bool) -> SdkReply {
    SdkReply {
        event_id,
        enforce_thread: if in_thread {
            EnforceThread::Threaded(ReplyWithinThread::Yes)
        } else {
            EnforceThread::MaybeThreaded
        },
        add_mentions: if silent {
            AddMentions::No
        } else {
            AddMentions::Yes
        },
    }
}

impl Core {
    pub(crate) async fn with_reply(
        &self,
        room_id: &OwnedRoomId,
        content: RoomMessageEventContent,
        reply: Option<SdkReply>,
        thread_root: Option<OwnedEventId>,
        label: &str,
    ) -> Result<RoomMessageEventContent, RpcError> {
        let Some(reply) = reply else {
            return Ok(content);
        };
        let event_id = reply.event_id.clone();
        match self
            .room(room_id)
            .await?
            .make_reply_event(content.clone().into(), reply)
            .await
        {
            Ok(replied) => Ok(replied),
            Err(ReplyError::StateEvent) => {
                Ok(reply_relation_fallback(content, event_id, thread_root))
            }
            Err(error) => Err(self.failed_with(label, &error)),
        }
    }
}

pub(crate) fn reply_relation_fallback(
    mut content: RoomMessageEventContent,
    event_id: OwnedEventId,
    thread_root: Option<OwnedEventId>,
) -> RoomMessageEventContent {
    content.relates_to = Some(match thread_root {
        Some(root) => Relation::Thread(Thread::plain(root, event_id)),
        None => Relation::Reply(Reply::with_event_id(event_id)),
    });
    content
}

pub(crate) fn message_content(
    body: String,
    formatted: Option<String>,
    kind: MessageKind,
    mentions: Vec<OwnedUserId>,
    room: bool,
) -> RoomMessageEventContent {
    let content = match (kind, formatted) {
        (MessageKind::Text, Some(html)) => RoomMessageEventContent::text_html(body, html),
        (MessageKind::Text, None) => RoomMessageEventContent::text_plain(body),
        (MessageKind::Emote, Some(html)) => RoomMessageEventContent::emote_html(body, html),
        (MessageKind::Emote, None) => RoomMessageEventContent::emote_plain(body),
        (MessageKind::Notice, Some(html)) => RoomMessageEventContent::notice_html(body, html),
        (MessageKind::Notice, None) => RoomMessageEventContent::notice_plain(body),
    };

    content.add_mentions(outgoing_mentions(mentions, room))
}

pub(crate) fn gif_content(
    body: String,
    url: OwnedMxcUri,
    info: ImageInfo,
) -> RoomMessageEventContent {
    RoomMessageEventContent::new(MessageType::Image(
        ImageMessageEventContent::plain(body, url).info(Box::new(info)),
    ))
    .add_mentions(outgoing_mentions(Vec::new(), false))
}

pub(crate) fn location_content(body: String, geo_uri: String) -> RoomMessageEventContent {
    let mut location = LocationMessageEventContent::new(body, geo_uri.clone());
    location.location = Some(LocationContent::new(geo_uri));
    RoomMessageEventContent::new(MessageType::Location(location))
        .add_mentions(outgoing_mentions(Vec::new(), false))
}

pub(crate) const IMAGE_SOURCE_PACKS: &str = "com.beeper.msc4459.image_source_packs";

pub(crate) fn extra_content<const N: usize>(
    base: Option<serde_json::Map<String, serde_json::Value>>,
    fields: [(&str, Option<serde_json::Value>); N],
) -> Option<serde_json::Map<String, serde_json::Value>> {
    let mut extra = base;
    for (key, value) in fields {
        if let Some(value) = value {
            extra.get_or_insert_default().insert(key.to_owned(), value);
        }
    }
    extra
}

pub(crate) fn forum_title_value(title: Option<String>) -> Option<serde_json::Value> {
    title
        .map(|title| title.trim().to_owned())
        .filter(|title| !title.is_empty())
        .map(serde_json::Value::String)
}

pub(crate) fn message_extra_content(
    persona: Option<&crate::protocol::PerMessageProfileView>,
) -> Option<serde_json::Map<String, serde_json::Value>> {
    extra_content(
        persona.map(|profile| {
            crate::personas::profile_extra_content(&crate::personas::without_fallback(profile))
        }),
        [("m.mentions", Some(empty_mentions()))],
    )
}

pub(crate) fn empty_mentions() -> serde_json::Value {
    serde_json::Value::Object(serde_json::Map::new())
}

pub(crate) fn ensure_empty_mentions(content: &mut serde_json::Value) {
    if let Some(object) = content.as_object_mut() {
        object.entry("m.mentions").or_insert_with(empty_mentions);
    }
}

pub(crate) const REACTION_SHORTCODE: &str = "shortcode";

const MAX_REACTION_SHORTCODE_BYTES: usize = 100;

pub(crate) fn reaction_shortcode(key: &str, shortcode: Option<&str>) -> Option<serde_json::Value> {
    if !key.starts_with("mxc://") {
        return None;
    }
    let name = shortcode?.trim().trim_matches(':');
    if name.is_empty() {
        return None;
    }
    let name = truncate_graphemes(name, MAX_REACTION_SHORTCODE_BYTES - 2);
    (!name.is_empty()).then(|| serde_json::Value::from(format!(":{name}:")))
}

pub(crate) fn image_source_pack_extra(
    url: &str,
    source: Option<ImageSourcePackView>,
) -> Option<serde_json::Value> {
    source.map(|source| serde_json::json!({ url: source }))
}

pub(crate) fn image_source_pack_references(
    references: &[ImageSourcePackReferenceView],
) -> Option<serde_json::Value> {
    (!references.is_empty()).then(|| {
        serde_json::Value::Object(
            references
                .iter()
                .map(|reference| (reference.url.clone(), serde_json::json!(reference.source)))
                .collect(),
        )
    })
}

pub(crate) fn sticker_info(declared: Option<PackImageInfoView>) -> ImageInfo {
    let mut info = ImageInfo::new();
    let Some(declared) = declared else {
        return info;
    };

    info.width = declared.width.map(Into::into);
    info.height = declared.height.map(Into::into);
    info.mimetype = declared.mimetype;
    info.size = declared.size.map(Into::into);
    info
}

#[cfg(test)]
mod tests {
    use super::{ensure_empty_mentions, message_extra_content};
    use matrix_sdk::room::edit::EditedContent;

    use crate::messages::edit_content;
    use crate::outgoing::{
        gif_content, location_content, message_content, reply_relation_fallback, thread_reply,
    };
    use crate::protocol::MessageKind;
    use crate::view;
    use matrix_sdk::ruma::events::relation::Reply;
    use matrix_sdk::ruma::events::room::message::{AddMentions, Relation};
    use matrix_sdk::ruma::owned_user_id;

    #[test]
    fn test_a_custom_reaction_carries_its_shortcode_wrapped_in_colons() {
        assert_eq!(
            super::reaction_shortcode("mxc://example.org/parrot", Some("partyparrot")),
            Some(serde_json::json!(":partyparrot:"))
        );
        assert_eq!(
            super::reaction_shortcode("mxc://example.org/parrot", Some(":partyparrot:")),
            Some(serde_json::json!(":partyparrot:"))
        );
    }

    #[test]
    fn test_an_emoji_reaction_or_a_blank_name_carries_no_shortcode() {
        assert_eq!(super::reaction_shortcode("👍", Some("thumbsup")), None);
        assert_eq!(
            super::reaction_shortcode("mxc://example.org/a", Some("  ")),
            None
        );
        assert_eq!(super::reaction_shortcode("mxc://example.org/a", None), None);
    }

    #[test]
    fn test_a_long_shortcode_is_cut_to_100_bytes_on_a_character_boundary() {
        let long = "é".repeat(80);
        let Some(serde_json::Value::String(shortcode)) =
            super::reaction_shortcode("mxc://example.org/a", Some(&long))
        else {
            panic!("a shortcode was expected");
        };

        assert!(shortcode.len() <= 100);
        assert!(shortcode.starts_with(':') && shortcode.ends_with(':'));
        assert_eq!(shortcode.len(), 2 + 49 * 2);
    }

    #[test]
    fn a_silent_reply_carries_no_mention() {
        let event_id = <&matrix_sdk::ruma::EventId>::try_from("$one:example.org")
            .expect("an event id")
            .to_owned();

        let loud = thread_reply(Some(event_id.clone()), None, false).expect("a reply");
        assert_eq!(loud.add_mentions, AddMentions::Yes);

        let silent = thread_reply(Some(event_id), None, true).expect("a reply");
        assert_eq!(silent.add_mentions, AddMentions::No);
    }

    #[test]
    fn a_state_event_reply_keeps_the_relation_without_a_fallback() {
        let event_id = <&matrix_sdk::ruma::EventId>::try_from("$state:example.org")
            .expect("an event id")
            .to_owned();
        let content = message_content(
            "reply".to_owned(),
            None,
            MessageKind::Text,
            Vec::new(),
            false,
        );

        let content = reply_relation_fallback(content, event_id.clone(), None);
        assert!(matches!(
            content.relates_to,
            Some(Relation::Reply(Reply { in_reply_to, .. }))
                if in_reply_to.event_id == event_id
        ));
    }

    #[test]
    fn a_message_without_pills_sends_an_empty_m_mentions() {
        let content = message_content(
            "hello".to_owned(),
            None,
            MessageKind::Text,
            Vec::new(),
            false,
        );

        assert_eq!(
            serde_json::to_value(&content).unwrap()["m.mentions"],
            serde_json::json!({})
        );
    }

    #[test]
    fn gifs_and_locations_without_mentions_send_an_empty_m_mentions() {
        let gif = gif_content(
            "dancing".to_owned(),
            matrix_sdk::ruma::OwnedMxcUri::from("mxc://example.org/gif"),
            super::ImageInfo::new(),
        );
        let location = location_content("here".to_owned(), "geo:48.8584,2.2945".to_owned());

        for content in [gif, location] {
            assert_eq!(
                serde_json::to_value(content).unwrap()["m.mentions"],
                serde_json::json!({})
            );
        }
    }

    #[test]
    fn polls_receive_an_empty_m_mentions_extra_field() {
        assert_eq!(
            message_extra_content(None).unwrap()["m.mentions"],
            serde_json::json!({})
        );
    }

    #[test]
    fn raw_events_without_mentions_receive_an_empty_m_mentions() {
        let mut content = serde_json::json!({"body": "hello"});
        ensure_empty_mentions(&mut content);

        assert_eq!(content["m.mentions"], serde_json::json!({}));
    }

    #[test]
    fn pills_become_m_mentions() {
        let content = message_content(
            "hi One".to_owned(),
            None,
            MessageKind::Text,
            vec![owned_user_id!("@one:example.org")],
            false,
        );

        let mentions = content.mentions.expect("mentions");
        assert!(
            mentions
                .user_ids
                .contains(&owned_user_id!("@one:example.org"))
        );
        assert!(!mentions.room);
    }

    #[test]
    fn a_geo_uri_is_checked_before_it_is_sent() {
        assert!(view::geo_coordinates("geo:48.8584,2.2945").is_some());
        assert!(view::geo_coordinates("48.8584,2.2945").is_none());
        assert!(view::geo_coordinates("geo:91,0").is_none());
    }

    #[test]
    fn each_kind_picks_its_msgtype() {
        let kinds = [
            (MessageKind::Text, "m.text"),
            (MessageKind::Emote, "m.emote"),
            (MessageKind::Notice, "m.notice"),
        ];

        for (kind, msgtype) in kinds {
            let plain = message_content("waves".to_owned(), None, kind, Vec::new(), false);
            let formatted = message_content(
                "waves".to_owned(),
                Some("<em>waves</em>".to_owned()),
                kind,
                Vec::new(),
                false,
            );

            assert_eq!(plain.msgtype(), msgtype, "{kind:?} plain");
            assert_eq!(formatted.msgtype(), msgtype, "{kind:?} formatted");
        }
    }

    #[test]
    fn editing_an_image_caption_uses_sdk_media_edit_with_formatting_and_mentions() {
        let content = edit_content(
            "updated caption".to_owned(),
            Some("<b>updated caption</b>".to_owned()),
            MessageKind::Text,
            true,
            vec![matrix_sdk::ruma::user_id!("@alice:example.org").to_owned()],
            true,
        );
        let EditedContent::MediaCaption {
            caption,
            formatted_caption,
            mentions,
        } = content
        else {
            panic!("expected SDK caption edit");
        };
        assert_eq!(caption.as_deref(), Some("updated caption"));
        assert_eq!(formatted_caption.unwrap().body, "<b>updated caption</b>");
        let mentions = mentions.unwrap();
        assert!(mentions.room);
        assert!(
            mentions
                .user_ids
                .contains(matrix_sdk::ruma::user_id!("@alice:example.org"))
        );
    }

    #[tokio::test]
    async fn caption_edit_retains_original_media_metadata() {
        use matrix_sdk::{
            ruma::{event_id, room_id, user_id},
            test_utils::mocks::MatrixMockServer,
        };
        use serde_json::json;
        use wiremock::{
            Mock, ResponseTemplate,
            matchers::{method, path},
        };
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;
        let room_id = room_id!("!caption:example.org");
        let room = server.sync_joined_room(&client, room_id).await;
        let info = json!({"mimetype": "image/png", "w": 800, "h": 600, "size": 12345,
            "thumbnail_url": "mxc://example.org/thumbnail",
            "thumbnail_info": {"mimetype": "image/png", "w": 80, "h": 60, "size": 123},
            "xyz.amorgan.blurhash": "LEHV6nWB2yk8pyo0adR*.7kCMdnj"});
        Mock::given(method("GET"))
            .and(path(format!(
                "/_matrix/client/v3/rooms/{room_id}/event/$image"
            )))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "type": "m.room.message", "event_id": "$image", "room_id": room_id,
                "sender": client.user_id().unwrap(), "origin_server_ts": 1,
                "content": {"msgtype": "m.image", "body": "old caption", "filename": "photo.png",
                    "url": "mxc://example.org/photo", "info": info}
            })))
            .mount(server.server())
            .await;
        let edit = edit_content(
            "new caption".to_owned(),
            Some("<b>new caption</b>".to_owned()),
            MessageKind::Text,
            true,
            vec![user_id!("@bob:example.org").to_owned()],
            false,
        );
        let content = room
            .make_edit_event(event_id!("$image"), edit)
            .await
            .unwrap();
        let content = serde_json::to_value(content).unwrap();
        let updated = &content["m.new_content"];
        assert_eq!(updated["info"], info);
        assert_eq!(updated["url"], "mxc://example.org/photo");
        assert_eq!(updated["filename"], "photo.png");
        assert_eq!(updated["formatted_body"], "<b>new caption</b>");
        assert_eq!(
            updated["m.mentions"]["user_ids"],
            json!(["@bob:example.org"])
        );
    }

    #[test]
    fn a_room_mention_needs_no_user_ids() {
        let content = message_content(
            "@room heads up".to_owned(),
            None,
            MessageKind::Text,
            Vec::new(),
            true,
        );

        let mentions = content.mentions.expect("mentions");
        assert!(mentions.user_ids.is_empty());
        assert!(mentions.room);
    }
}
