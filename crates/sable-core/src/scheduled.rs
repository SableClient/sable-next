use crate::api::messages::CancelScheduledParams;
use crate::api::messages::ScheduleAttachmentParams;
use crate::api::messages::SendScheduledParams;
use std::time::Duration;

use matrix_sdk::ruma::api::client::delayed_events::get_all_delayed_events;
use matrix_sdk::ruma::api::client::delayed_events::update_delayed_event::UpdateAction;
use matrix_sdk::ruma::events::room::message::RoomMessageEventContent;
use matrix_sdk::ruma::{OwnedMxcUri, OwnedRoomId};
use mime::Mime;
use serde::Serialize;

use crate::ResultExt;
use crate::SignedIn;
use crate::delayed_events::{self, DelayedEvent, DelayedEventsSupport};
use crate::protocol::{AttachmentInfoView, RpcCode, RpcError, ScheduledMessageView};
use crate::view::SPOILER_PROPERTY;
use sable_model::animation::gif_flags;

#[derive(Serialize)]
struct MediaInfoOut {
    mimetype: String,
    size: u64,
    #[serde(rename = "w", skip_serializing_if = "Option::is_none")]
    width: Option<u32>,
    #[serde(rename = "h", skip_serializing_if = "Option::is_none")]
    height: Option<u32>,
    #[serde(rename = "duration", skip_serializing_if = "Option::is_none")]
    duration_ms: Option<u32>,
    #[serde(
        rename = "xyz.amorgan.blurhash",
        skip_serializing_if = "Option::is_none"
    )]
    blurhash: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    is_animated: Option<bool>,
    #[serde(flatten)]
    playback: serde_json::Map<String, serde_json::Value>,
}

#[derive(Serialize)]
#[serde(tag = "msgtype")]
enum AttachmentKind {
    #[serde(rename = "m.image")]
    Image,
    #[serde(rename = "m.video")]
    Video,
    #[serde(rename = "m.audio")]
    Audio,
    #[serde(rename = "m.file")]
    File,
}

#[derive(Serialize)]
struct AttachmentOut {
    #[serde(flatten)]
    kind: AttachmentKind,
    body: String,
    url: String,
    info: MediaInfoOut,
    #[serde(flatten)]
    extra: serde_json::Map<String, serde_json::Value>,
}

fn attachment_content(
    filename: String,
    mime: &Mime,
    url: OwnedMxcUri,
    size: u64,
    info: AttachmentInfoView,
    spoiler: bool,
) -> AttachmentOut {
    let kind = match mime.type_() {
        mime::IMAGE => AttachmentKind::Image,
        mime::VIDEO => AttachmentKind::Video,
        mime::AUDIO => AttachmentKind::Audio,
        _ => AttachmentKind::File,
    };
    AttachmentOut {
        kind,
        body: filename,
        url: url.into(),
        info: MediaInfoOut {
            mimetype: mime.essence_str().to_owned(),
            size,
            width: info.width,
            height: info.height,
            duration_ms: info.duration_ms,
            blurhash: info.blurhash,
            is_animated: info.animated.filter(|_| mime.type_() == mime::IMAGE),
            playback: if mime.type_() == mime::VIDEO && info.gif == Some(true) {
                gif_flags()
            } else {
                serde_json::Map::new()
            },
        },
        extra: spoiler
            .then(|| (SPOILER_PROPERTY.to_owned(), serde_json::Value::Bool(true)))
            .into_iter()
            .collect(),
    }
}

impl SignedIn {
    pub(crate) async fn delayed_events_support(&self) -> Result<DelayedEventsSupport, RpcError> {
        delayed_events::support(self.client())
            .await
            .or_failed(self.core(), "delayed_events_supported")
    }

    /// Scheduling is offered only where the queue can also be listed and cancelled.
    pub(crate) async fn scheduling_supported(&self) -> Result<bool, RpcError> {
        Ok(self.delayed_events_support().await?.can_list())
    }

    pub(crate) async fn schedule_message(
        &self,
        room_id: &OwnedRoomId,
        content: RoomMessageEventContent,
        delay_ms: u64,
        persona: Option<&crate::protocol::PerMessageProfileView>,
    ) -> Result<String, RpcError> {
        let mut content =
            serde_json::to_value(content).or_failed(self.core(), "schedule_message")?;
        if let Some(profile) = &persona {
            crate::personas::stamp_profile(&mut content, profile);
        }
        let content =
            serde_json::value::to_raw_value(&content).or_failed(self.core(), "schedule_message")?;
        self.schedule_room_message(room_id, content, delay_ms).await
    }

    async fn schedule_room_message(
        &self,
        room_id: &OwnedRoomId,
        content: Box<serde_json::value::RawValue>,
        delay_ms: u64,
    ) -> Result<String, RpcError> {
        let support = self.delayed_events_support().await?;
        if !support.can_list() {
            return Err(RpcCode::DelayedEventsUnsupported.into());
        }
        let room = self.room(room_id)?;
        if self.core().room_is_encrypted(&room).await? {
            return Err(RpcCode::EncryptedScheduleUnsupported.into());
        }

        let event = DelayedEvent {
            room_id: room_id.clone(),
            event_type: "m.room.message".to_owned(),
            state_key: None,
            content,
            delay: Duration::from_millis(delay_ms),
            sticky_duration_ms: None,
        };
        delayed_events::send(self.client(), support, event)
            .await
            .or_failed(self.core(), "schedule_message")
    }

    pub(crate) async fn schedule_attachment(
        &self,
        ScheduleAttachmentParams {
            room_id,
            filename,
            mime,
            url,
            size,
            info,
            spoiler,
            delay_ms,
            persona,
        }: ScheduleAttachmentParams,
    ) -> Result<String, RpcError> {
        let mime: Mime = mime.parse().map_err(|_| RpcCode::InvalidMedia)?;
        let url = OwnedMxcUri::from(url);
        if url.parts().is_err() {
            return Err(RpcCode::InvalidMedia.into());
        }

        let info = info.unwrap_or_default();
        let mut content = serde_json::to_value(attachment_content(
            filename, &mime, url, size, info, spoiler,
        ))
        .or_failed(self.core(), "schedule_attachment")?;
        if let Some(profile) = &persona {
            crate::personas::stamp_profile(
                &mut content,
                &crate::personas::without_fallback(profile),
            );
        }
        let content = serde_json::value::to_raw_value(&content)
            .or_failed(self.core(), "schedule_attachment")?;
        self.schedule_room_message(&room_id, content, delay_ms)
            .await
    }

    pub(crate) async fn cancel_scheduled_message(
        &self,
        CancelScheduledParams { delay_id }: CancelScheduledParams,
    ) -> Result<(), RpcError> {
        delayed_events::update(self.client(), delay_id, UpdateAction::Cancel)
            .await
            .or_failed(self.core(), "cancel_scheduled_message")
    }

    pub(crate) async fn send_scheduled_message_now(
        &self,
        SendScheduledParams { delay_id }: SendScheduledParams,
    ) -> Result<(), RpcError> {
        delayed_events::update(self.client(), delay_id, UpdateAction::Send)
            .await
            .or_failed(self.core(), "send_scheduled_message")
    }

    pub(crate) async fn scheduled_messages(
        &self,
        room_id: Option<&OwnedRoomId>,
    ) -> Result<Vec<ScheduledMessageView>, RpcError> {
        if !self.scheduling_supported().await? {
            return Ok(Vec::new());
        }
        let client = self.client();
        let response = client
            .send(get_all_delayed_events::msc4140::Request::new())
            .await
            .or_failed(self.core(), "scheduled_messages")?;

        Ok(response
            .delayed_events
            .into_iter()
            .filter(|item| item.event_type == ruma::events::TimelineEventType::RoomMessage)
            .filter(|item| item.finalized_ts.is_none())
            .filter(|item| room_id.is_none_or(|wanted| &item.room_id == wanted))
            .filter_map(|item| {
                let content = item
                    .content
                    .deserialize_as_unchecked::<RoomMessageEventContent>()
                    .ok()?;
                let delay_ms = u64::try_from(item.delay.as_millis()).unwrap_or(u64::MAX);
                let formatted = match &content.msgtype {
                    ruma::events::room::message::MessageType::Text(text) => text
                        .formatted
                        .as_ref()
                        .map(|formatted| formatted.body.clone()),
                    ruma::events::room::message::MessageType::Notice(notice) => notice
                        .formatted
                        .as_ref()
                        .map(|formatted| formatted.body.clone()),
                    ruma::events::room::message::MessageType::Emote(emote) => emote
                        .formatted
                        .as_ref()
                        .map(|formatted| formatted.body.clone()),
                    _ => None,
                };
                Some(ScheduledMessageView {
                    delivery_ts: Some(u64::from(item.running_since.get()).saturating_add(delay_ms)),
                    body: content.body().to_owned(),
                    formatted,
                    delay_id: item.delay_id,
                    room_id: item.room_id,
                    delay_ms,
                })
            })
            .collect())
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn attachment_content_keeps_the_wire_shape() {
        let mime: Mime = "image/png; charset=binary".parse().expect("mime");
        let url = OwnedMxcUri::from("mxc://example.org/abc");
        let info = AttachmentInfoView {
            width: Some(10),
            height: Some(20),
            duration_ms: Some(30),
            blurhash: Some("LEHV6n".to_owned()),
            ..AttachmentInfoView::default()
        };
        assert_eq!(
            serde_json::to_value(attachment_content(
                "a.png".to_owned(),
                &mime,
                url,
                7,
                info,
                true
            ))
            .unwrap(),
            json!({
                "msgtype": "m.image",
                "body": "a.png",
                "url": "mxc://example.org/abc",
                "info": {
                    "mimetype": "image/png",
                    "size": 7,
                    "w": 10,
                    "h": 20,
                    "duration": 30,
                    "xyz.amorgan.blurhash": "LEHV6n"
                },
                "page.codeberg.everypizza.msc4193.spoiler": true
            })
        );
    }

    #[test]
    fn only_a_video_chosen_as_a_gif_is_scheduled_as_one() {
        let url = OwnedMxcUri::from("mxc://example.org/abc");
        let content = |mime: &str, gif| {
            let mime: Mime = mime.parse().expect("mime");
            let info = AttachmentInfoView {
                gif,
                ..AttachmentInfoView::default()
            };
            serde_json::to_value(attachment_content(
                "clip".to_owned(),
                &mime,
                url.clone(),
                7,
                info,
                false,
            ))
            .unwrap()
        };

        assert_eq!(content("video/mp4", Some(true))["info"]["fi.mau.gif"], true);
        assert!(
            content("video/mp4", None)["info"]
                .get("fi.mau.gif")
                .is_none()
        );
        assert!(
            content("image/png", Some(true))["info"]
                .get("fi.mau.gif")
                .is_none()
        );
    }

    #[test]
    fn only_an_image_carries_is_animated() {
        let content = |mime: &str| {
            let mime: Mime = mime.parse().expect("mime");
            let info = AttachmentInfoView {
                animated: Some(true),
                ..AttachmentInfoView::default()
            };
            serde_json::to_value(attachment_content(
                "a".to_owned(),
                &mime,
                OwnedMxcUri::from("mxc://example.org/abc"),
                7,
                info,
                false,
            ))
            .unwrap()
        };

        assert_eq!(content("image/webp")["info"]["is_animated"], true);
        assert!(content("video/mp4")["info"].get("is_animated").is_none());
    }

    #[test]
    fn attachment_content_omits_absent_fields() {
        let mime: Mime = "application/pdf".parse().expect("mime");
        let url = OwnedMxcUri::from("mxc://example.org/abc");
        assert_eq!(
            serde_json::to_value(attachment_content(
                "a.pdf".to_owned(),
                &mime,
                url,
                7,
                AttachmentInfoView::default(),
                false
            ))
            .unwrap(),
            json!({
                "msgtype": "m.file",
                "body": "a.pdf",
                "url": "mxc://example.org/abc",
                "info": { "mimetype": "application/pdf", "size": 7 }
            })
        );
    }
}
