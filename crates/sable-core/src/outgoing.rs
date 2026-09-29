use matrix_sdk::room::reply::{EnforceThread, Reply as SdkReply, ReplyError};
use matrix_sdk::ruma::events::location::LocationContent;
use matrix_sdk::ruma::events::relation::{Reply, Thread};
use matrix_sdk::ruma::events::room::ImageInfo;
use matrix_sdk::ruma::events::room::message::{
    AddMentions, ImageMessageEventContent, LocationMessageEventContent, MessageType, Relation,
    ReplyWithinThread, RoomMessageEventContent,
};
use matrix_sdk::ruma::{OwnedEventId, OwnedMxcUri, OwnedRoomId, OwnedUserId};

use crate::Core;
use crate::messages::outgoing_mentions;
use crate::protocol::{CommandErr, MessageKind};

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
    ) -> Result<RoomMessageEventContent, CommandErr> {
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
            Err(error) => Err(self.failed(label, error)),
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
