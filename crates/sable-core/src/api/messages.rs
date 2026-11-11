use std::sync::Arc;

use matrix_sdk::ruma::api::client::authenticated_media::get_media_preview;
use matrix_sdk::ruma::events::relation::{InReplyTo, Reply, Thread};
use matrix_sdk::ruma::events::room::ImageInfo;
use matrix_sdk::ruma::events::room::message::Relation;
use matrix_sdk::ruma::events::sticker::StickerEventContent;
use matrix_sdk::ruma::{OwnedEventId, OwnedMxcUri, OwnedRoomId, OwnedUserId};
use matrix_sdk_ui::timeline::{Error as TimelineError, RedactError, TimelineEventItemId};
use serde::{Deserialize, Serialize};

use super::Handler;
use crate::link_previews::BUNDLED_LINK_PREVIEWS;
use crate::link_previews::LEGACY_BUNDLED_LINK_PREVIEWS;
use crate::link_previews::bundled_link_previews;
use crate::link_previews::preview_refused;
use crate::link_previews::url_preview;
use crate::outgoing::IMAGE_SOURCE_PACKS;
use crate::outgoing::REACTION_SHORTCODE;
use crate::outgoing::empty_mentions;
use crate::outgoing::ensure_empty_mentions;
use crate::outgoing::extra_content;
use crate::outgoing::forum_title_value;
use crate::outgoing::image_source_pack_extra;
use crate::outgoing::image_source_pack_references;
use crate::outgoing::message_extra_content;
use crate::outgoing::reaction_shortcode;
use crate::outgoing::sticker_info;
use crate::outgoing::{gif_content, location_content, message_content, reply_to, thread_reply};
use crate::protocol::{
    AttachmentInfoView, ComposerContent, ComposerPill, GestureView, ImageSourcePackReferenceView,
    ImageSourcePackView, MessageKind, PackImageInfoView, PerMessageProfileView,
    ReactionShortcodeView, RpcCode, RpcError, ScheduledMessageView, SubscriptionId, UrlPreviewView,
};
use crate::{Core, ResultExt, view};

domain! {
    markdown_to_content,
    send,
    send_raw_event,
    send_redaction,
    send_sticker,
    send_gif,
    remove_link_previews,
    reprofile,
    edit,
    redact,
    delete_thread,
    bulk_redact,
    react,
    send_location,
    forward,
    report,
    retry_send,
    cancel_send,
    schedule,
    schedule_attachment,
    scheduled,
    cancel_scheduled,
    send_scheduled,
    create_poll,
    vote_poll,
    end_poll,
    send_gesture,
    url_preview,
    reaction_shortcodes,
    frequent_reactions,
    remember_emoji,
    set_typing,
    media_config,
}

/// A typed message as the web composer's plain mode sends it, each
/// `\u{FFFC}` in `markdown` standing for the next of `pills`.
#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct MarkdownToContentParams {
    pub markdown: String,
    #[serde(default)]
    pub pills: Vec<ComposerPill>,
}

impl Handler for MarkdownToContentParams {
    type Ok = ComposerContent;

    fn run(self, _core: &Arc<Core>) -> impl Future<Output = Result<ComposerContent, RpcError>> {
        std::future::ready(Ok(sable_model::markdown::markdown_to_content(
            &self.markdown,
            &self.pills,
        )))
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct SendParams {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub room_id: OwnedRoomId,
    pub body: String,
    #[serde(default)]
    pub formatted: Option<String>,
    #[serde(default)]
    pub kind: MessageKind,
    #[serde(default)]
    #[cfg_attr(feature = "typegen", specta(type = Option<String>))]
    pub thread_root: Option<OwnedEventId>,
    #[serde(default)]
    /// Replying inside a thread needs no extra field: the SDK infers the
    /// thread from the replied-to event.
    #[cfg_attr(feature = "typegen", specta(type = Option<String>))]
    pub in_reply_to: Option<OwnedEventId>,
    #[serde(default)]
    #[cfg_attr(feature = "typegen", specta(type = Vec<String>))]
    pub mentions: Vec<OwnedUserId>,
    #[serde(default)]
    pub mentions_room: bool,
    #[serde(default)]
    pub silent_reply: bool,
    #[serde(default)]
    pub persona: Option<PerMessageProfileView>,
    #[serde(default)]
    pub link_previews: Vec<UrlPreviewView>,
    #[serde(default)]
    pub no_link_previews: bool,
    #[serde(default)]
    pub image_source_packs: Vec<ImageSourcePackReferenceView>,
    #[serde(default)]
    #[cfg_attr(feature = "typegen", specta(type = Option<specta_typescript::Unknown>))]
    pub bot_command: Option<serde_json::Value>,
    #[serde(default)]
    pub forum_title: Option<String>,
}

impl Handler for SendParams {
    /// The local echo arrives on the timeline diff stream.
    type Ok = ();

    async fn run(self, core: &Arc<Core>) -> Result<(), RpcError> {
        let room_id = self.room_id;
        let thread_root = self.thread_root;
        let timeline = core.timeline_for(&room_id, thread_root.as_ref()).await?;
        let (body, formatted, persona) = match self.persona {
            Some(persona) => {
                let (body, formatted, persona) =
                    crate::personas::outgoing_with_fallback(self.body, self.formatted, &persona);
                (body, formatted, Some(persona))
            }
            None => (self.body, self.formatted, None),
        };
        let content = message_content(
            body,
            formatted,
            self.kind,
            self.mentions,
            self.mentions_room,
        );

        let reply = thread_reply(self.in_reply_to, thread_root.clone(), self.silent_reply);
        let content = core
            .with_reply(&room_id, content, reply, thread_root.clone(), "send_reply")
            .await?;

        let mut seen = std::collections::HashSet::new();
        let had_previews = !self.link_previews.is_empty();
        let link_previews: Vec<_> = self
            .link_previews
            .into_iter()
            .filter(|preview| {
                !self.no_link_previews
                    && crate::link_previews::is_preview_url(&preview.url)
                    && content.body().contains(&preview.url)
                    && seen.insert(preview.url.clone())
            })
            .collect();
        let opt_out = (self.no_link_previews || (had_previews && link_previews.is_empty()))
            .then(|| serde_json::Value::Array(Vec::new()));
        let images = core.prepare_preview_images(&room_id, &link_previews).await;
        let extra = extra_content(
            persona.as_ref().map(crate::personas::profile_extra_content),
            [
                (
                    BUNDLED_LINK_PREVIEWS,
                    bundled_link_previews(&link_previews, &images, true)
                        .or_else(|| opt_out.clone()),
                ),
                (
                    LEGACY_BUNDLED_LINK_PREVIEWS,
                    bundled_link_previews(&link_previews, &images, false)
                        .or_else(|| opt_out.clone()),
                ),
                (
                    IMAGE_SOURCE_PACKS,
                    image_source_pack_references(&self.image_source_packs),
                ),
                (crate::bot_commands::COMMAND_FIELD, self.bot_command),
                (view::FORUM_TITLE, forum_title_value(self.forum_title)),
            ],
        );
        timeline
            .send_with_extra_content(content.into(), extra)
            .await
            .or_failed(core, "send_message")?;

        Ok(())
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct SendRawEventParams {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub room_id: OwnedRoomId,
    pub event_type: String,
    #[cfg_attr(feature = "typegen", specta(type = specta_typescript::Unknown))]
    pub content: serde_json::Value,
    #[serde(default)]
    pub persona: Option<PerMessageProfileView>,
}

impl Handler for SendRawEventParams {
    type Ok = String;

    async fn run(self, core: &Arc<Core>) -> Result<String, RpcError> {
        let mut content = self.content;
        ensure_empty_mentions(&mut content);
        if let Some(profile) = self.persona.as_ref() {
            crate::personas::stamp_profile(
                &mut content,
                &crate::personas::without_fallback(profile),
            );
        }
        let response = core
            .room(&self.room_id)
            .await?
            .send_raw(&self.event_type, content)
            .await
            .or_failed(core, "send_raw_event")?;

        Ok(response.response.event_id.to_string())
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct SendRedactionParams {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub room_id: OwnedRoomId,
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub event_id: OwnedEventId,
    #[serde(default)]
    pub reason: Option<String>,
}

impl Handler for SendRedactionParams {
    type Ok = String;

    async fn run(self, core: &Arc<Core>) -> Result<String, RpcError> {
        let response = core
            .room(&self.room_id)
            .await?
            .redact(&self.event_id, self.reason.as_deref(), None)
            .await
            .or_failed(core, "send_redaction")?;
        Ok(response.event_id.to_string())
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct SendStickerParams {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub room_id: OwnedRoomId,
    pub url: String,
    pub body: String,
    #[serde(default)]
    pub info: Option<PackImageInfoView>,
    #[serde(default)]
    pub source_pack: Option<ImageSourcePackView>,
    #[serde(default)]
    #[cfg_attr(feature = "typegen", specta(type = Option<String>))]
    pub in_reply_to: Option<OwnedEventId>,
    #[serde(default)]
    #[cfg_attr(feature = "typegen", specta(type = Option<String>))]
    pub thread_root: Option<OwnedEventId>,
    #[serde(default)]
    pub persona: Option<PerMessageProfileView>,
}

impl Handler for SendStickerParams {
    type Ok = ();

    async fn run(self, core: &Arc<Core>) -> Result<(), RpcError> {
        let url = OwnedMxcUri::from(self.url);
        if url.parts().is_err() {
            return Err(RpcCode::InvalidMedia.into());
        }
        let source = image_source_pack_extra(url.as_str(), self.source_pack);

        let timeline = core
            .timeline_for(&self.room_id, self.thread_root.as_ref())
            .await?;
        let mut content = StickerEventContent::new(self.body, sticker_info(self.info), url);

        content.relates_to = match (self.thread_root, self.in_reply_to) {
            (Some(root), reply) => {
                let fallback = reply.unwrap_or_else(|| root.clone());
                Some(Relation::Thread(Thread::plain(root, fallback)))
            }
            (None, Some(event_id)) => Some(Relation::Reply(Reply::new(InReplyTo::new(event_id)))),
            (None, None) => None,
        };

        let extra = extra_content(
            self.persona.as_ref().map(|persona| {
                crate::personas::profile_extra_content(&crate::personas::without_fallback(persona))
            }),
            [
                (IMAGE_SOURCE_PACKS, source),
                ("m.mentions", Some(empty_mentions())),
            ],
        );
        timeline
            .send_with_extra_content(content.into(), extra)
            .await
            .or_failed(core, "send_sticker")?;

        Ok(())
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct SendGifParams {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub room_id: OwnedRoomId,
    /// `mxc://` only; the core rejects anything else.
    pub url: String,
    pub body: String,
    #[cfg_attr(feature = "typegen", specta(type = Option<specta_typescript::Number>))]
    #[serde(default)]
    pub width: Option<u32>,
    #[cfg_attr(feature = "typegen", specta(type = Option<specta_typescript::Number>))]
    pub height: Option<u32>,
    pub mimetype: String,
    #[cfg_attr(feature = "typegen", specta(type = Option<specta_typescript::Number>))]
    #[serde(default)]
    pub size: Option<u32>,
    #[serde(default)]
    #[cfg_attr(feature = "typegen", specta(type = Option<String>))]
    pub in_reply_to: Option<OwnedEventId>,
    #[serde(default)]
    pub silent_reply: bool,
    #[serde(default)]
    #[cfg_attr(feature = "typegen", specta(type = Option<String>))]
    pub thread_root: Option<OwnedEventId>,
    #[serde(default)]
    pub persona: Option<PerMessageProfileView>,
}

impl Handler for SendGifParams {
    type Ok = ();

    async fn run(self, core: &Arc<Core>) -> Result<(), RpcError> {
        let url = OwnedMxcUri::from(self.url);
        if url.parts().is_err() {
            return Err(RpcCode::InvalidMedia.into());
        }

        let mut info = ImageInfo::new();
        info.width = self.width.map(Into::into);
        info.height = self.height.map(Into::into);
        info.mimetype = Some(self.mimetype);
        info.size = self.size.map(Into::into);

        let room_id = self.room_id;
        let thread_root = self.thread_root;
        let timeline = core.timeline_for(&room_id, thread_root.as_ref()).await?;
        let content = gif_content(self.body, url, info);

        let reply = thread_reply(self.in_reply_to, thread_root.clone(), self.silent_reply);
        let content = core
            .with_reply(&room_id, content, reply, thread_root, "send_gif_reply")
            .await?;
        timeline
            .send_with_extra_content(
                content.into(),
                self.persona.as_ref().map(|persona| {
                    crate::personas::profile_extra_content(&crate::personas::without_fallback(
                        persona,
                    ))
                }),
            )
            .await
            .or_failed(core, "send_gif")?;

        Ok(())
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct RemoveLinkPreviewsParams {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub room_id: OwnedRoomId,
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub event_id: OwnedEventId,
    #[serde(default)]
    #[cfg_attr(feature = "typegen", specta(type = Option<String>))]
    pub thread_root: Option<OwnedEventId>,
}

impl Handler for RemoveLinkPreviewsParams {
    type Ok = ();

    async fn run(self, core: &Arc<Core>) -> Result<(), RpcError> {
        Box::pin(core.remove_link_previews(
            &self.room_id,
            &self.event_id,
            self.thread_root.as_ref(),
        ))
        .await
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct ReprofileParams {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub room_id: OwnedRoomId,
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub event_id: OwnedEventId,
    #[serde(default)]
    #[cfg_attr(feature = "typegen", specta(type = Option<String>))]
    pub thread_root: Option<OwnedEventId>,
    #[serde(default)]
    pub persona: Option<PerMessageProfileView>,
}

impl Handler for ReprofileParams {
    type Ok = ();

    async fn run(self, core: &Arc<Core>) -> Result<(), RpcError> {
        Box::pin(core.reprofile_message(
            &self.room_id,
            &self.event_id,
            self.thread_root.as_ref(),
            self.persona.as_ref(),
        ))
        .await
    }
}

/// `edited` on the view flips once the server has the replacement.
#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct EditParams {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub room_id: OwnedRoomId,
    #[cfg_attr(feature = "typegen", specta(type = Option<String>))]
    #[serde(default)]
    pub event_id: Option<OwnedEventId>,
    #[serde(default)]
    pub transaction_id: Option<String>,
    pub body: String,
    pub formatted: Option<String>,
    #[serde(default)]
    pub kind: MessageKind,
    #[serde(default)]
    pub media_caption: bool,
    #[serde(default)]
    #[cfg_attr(feature = "typegen", specta(type = Option<String>))]
    pub thread_root: Option<OwnedEventId>,
    #[serde(default)]
    #[cfg_attr(feature = "typegen", specta(type = Vec<String>))]
    pub mentions: Vec<OwnedUserId>,
    #[serde(default)]
    pub mentions_room: bool,
    #[serde(default)]
    pub persona: Option<PerMessageProfileView>,
    #[serde(default)]
    pub forum_title: Option<String>,
}

impl Handler for EditParams {
    type Ok = ();

    async fn run(self, core: &Arc<Core>) -> Result<(), RpcError> {
        core.edit_message(self).await
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct RedactParams {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub room_id: OwnedRoomId,
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub event_id: OwnedEventId,
    #[serde(default)]
    pub reason: Option<String>,
    #[serde(default)]
    #[cfg_attr(feature = "typegen", specta(type = Option<String>))]
    pub thread_root: Option<OwnedEventId>,
}

impl Handler for RedactParams {
    type Ok = ();

    async fn run(self, core: &Arc<Core>) -> Result<(), RpcError> {
        core.redact_edits(&self.room_id, &self.event_id, self.reason.as_deref())
            .await?;
        let redacted = core
            .timeline_for(&self.room_id, self.thread_root.as_ref())
            .await?
            .redact(
                &TimelineEventItemId::EventId(self.event_id.clone()),
                self.reason.as_deref(),
            )
            .await;
        match redacted {
            Err(TimelineError::RedactError(RedactError::ItemNotFound(_))) => {
                core.room(&self.room_id)
                    .await?
                    .redact(&self.event_id, self.reason.as_deref(), None)
                    .await
                    .or_failed(core, "redact")?;
            }
            other => other.or_failed(core, "redact")?,
        }

        Ok(())
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct DeleteThreadParams {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub room_id: OwnedRoomId,
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub root_event_id: OwnedEventId,
    #[serde(default)]
    pub reason: Option<String>,
}

impl Handler for DeleteThreadParams {
    type Ok = ();

    async fn run(self, core: &Arc<Core>) -> Result<(), RpcError> {
        core.delete_thread(&self.room_id, &self.root_event_id, self.reason.as_deref())
            .await
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct BulkRedactParams {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub room_id: OwnedRoomId,
    pub senders: Vec<String>,
    #[cfg_attr(feature = "typegen", specta(type = specta_typescript::Number))]
    pub after_ts: u64,
    pub event_types: Vec<String>,
    #[serde(default)]
    pub reason: Option<String>,
}

impl Handler for BulkRedactParams {
    /// How many events were redacted.
    type Ok = u32;

    async fn run(self, core: &Arc<Core>) -> Result<u32, RpcError> {
        core.bulk_redact(
            &self.room_id,
            &self.senders,
            self.after_ts,
            &self.event_types,
            self.reason.as_deref(),
        )
        .await
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct ReactParams {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub room_id: OwnedRoomId,
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub event_id: OwnedEventId,
    pub key: String,
    #[serde(default)]
    pub source_pack: Option<ImageSourcePackView>,
    #[serde(default)]
    pub shortcode: Option<String>,
    #[serde(default)]
    #[cfg_attr(feature = "typegen", specta(type = Option<String>))]
    pub thread_root: Option<OwnedEventId>,
    #[serde(default)]
    pub subscription: Option<SubscriptionId>,
    #[serde(default)]
    pub persona: Option<PerMessageProfileView>,
}

impl Handler for ReactParams {
    type Ok = ();

    async fn run(self, core: &Arc<Core>) -> Result<(), RpcError> {
        let Self {
            room_id,
            event_id,
            key,
            source_pack,
            shortcode,
            thread_root,
            subscription,
            persona,
        } = self;
        core.ensure_reaction_target(&room_id, &event_id).await?;
        let timeline = core
            .subscribed_timeline(&room_id, thread_root.as_ref(), subscription)
            .await?;
        let shortcode = match shortcode
            .or_else(|| source_pack.as_ref().map(|source| source.shortcode.clone()))
        {
            Some(shortcode) => Some(shortcode),
            None => {
                core.known_reaction_shortcode(&room_id, &event_id, &key)
                    .await
            }
        };
        let shortcode = reaction_shortcode(&key, shortcode.as_deref());
        let added = if let Some(source) = image_source_pack_extra(&key, source_pack) {
            timeline
                .toggle_reaction_with_extra_content(
                    &TimelineEventItemId::EventId(event_id),
                    &key,
                    extra_content(
                        message_extra_content(persona.as_ref()),
                        [
                            (IMAGE_SOURCE_PACKS, Some(source)),
                            (REACTION_SHORTCODE, shortcode),
                            ("m.mentions", Some(empty_mentions())),
                        ],
                    ),
                )
                .await
                .or_failed(core, "react")?
        } else {
            timeline
                .toggle_reaction_with_extra_content(
                    &TimelineEventItemId::EventId(event_id),
                    &key,
                    extra_content(
                        message_extra_content(persona.as_ref()),
                        [(REACTION_SHORTCODE, shortcode)],
                    ),
                )
                .await
                .or_failed(core, "react")?
        };
        if added && let Err(error) = core.remember_reaction(&key).await {
            tracing::warn!("reaction history could not be saved: {error:?}");
        }

        Ok(())
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct SendLocationParams {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub room_id: OwnedRoomId,
    pub body: String,
    pub geo_uri: String,
    #[serde(default)]
    #[cfg_attr(feature = "typegen", specta(type = Option<String>))]
    pub in_reply_to: Option<OwnedEventId>,
    #[serde(default)]
    pub silent_reply: bool,
    #[serde(default)]
    #[cfg_attr(feature = "typegen", specta(type = Option<String>))]
    pub thread_root: Option<OwnedEventId>,
    #[serde(default)]
    pub persona: Option<PerMessageProfileView>,
}

impl Handler for SendLocationParams {
    type Ok = ();

    async fn run(self, core: &Arc<Core>) -> Result<(), RpcError> {
        if view::geo_coordinates(&self.geo_uri).is_none() {
            return Err(RpcCode::InvalidLocation.into());
        }

        let room_id = self.room_id;
        let thread_root = self.thread_root;
        let silent_reply = self.silent_reply;
        let timeline = core.timeline_for(&room_id, thread_root.as_ref()).await?;
        let content = location_content(self.body, self.geo_uri);
        let reply = self
            .in_reply_to
            .map(|event_id| reply_to(event_id, thread_root.is_some(), silent_reply));
        let content = core
            .with_reply(&room_id, content, reply, thread_root, "send_location")
            .await?;
        timeline
            .send_with_extra_content(
                content.into(),
                self.persona.as_ref().map(|profile| {
                    crate::personas::profile_extra_content(&crate::personas::without_fallback(
                        profile,
                    ))
                }),
            )
            .await
            .or_failed(core, "send_location")?;

        Ok(())
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct ForwardParams {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub room_id: OwnedRoomId,
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub event_id: OwnedEventId,
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub to_room_id: OwnedRoomId,
    #[serde(default)]
    pub include_metadata: Option<bool>,
    #[serde(default)]
    pub persona: Option<PerMessageProfileView>,
}

impl Handler for ForwardParams {
    type Ok = ();

    async fn run(self, core: &Arc<Core>) -> Result<(), RpcError> {
        core.forward_message(
            &self.room_id,
            &self.event_id,
            &self.to_room_id,
            self.persona.as_ref(),
            self.include_metadata.unwrap_or(true),
        )
        .await
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct ReportParams {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub room_id: OwnedRoomId,
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub event_id: OwnedEventId,
    #[serde(default)]
    pub reason: Option<String>,
}

impl Handler for ReportParams {
    type Ok = ();

    async fn run(self, core: &Arc<Core>) -> Result<(), RpcError> {
        core.report_message(&self.room_id, self.event_id, self.reason)
            .await
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct RetrySendParams {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub room_id: OwnedRoomId,
    pub transaction_id: String,
    #[serde(default)]
    #[cfg_attr(feature = "typegen", specta(type = Option<String>))]
    pub thread_root: Option<OwnedEventId>,
}

impl Handler for RetrySendParams {
    type Ok = ();

    async fn run(self, core: &Arc<Core>) -> Result<(), RpcError> {
        core.client().await?.send_queue().set_enabled(true).await;

        core.local_echo(
            &self.room_id,
            &self.transaction_id,
            self.thread_root.as_ref(),
        )
        .await?
        .unwedge()
        .await
        .or_failed(core, "retry_send")
    }
}

/// A local echo is not on the server, so it cannot be redacted.
#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct CancelSendParams {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub room_id: OwnedRoomId,
    pub transaction_id: String,
    #[serde(default)]
    #[cfg_attr(feature = "typegen", specta(type = Option<String>))]
    pub thread_root: Option<OwnedEventId>,
}

impl Handler for CancelSendParams {
    /// False when there was no such echo left to discard.
    type Ok = bool;

    async fn run(self, core: &Arc<Core>) -> Result<bool, RpcError> {
        let cancelled = core
            .local_echo(
                &self.room_id,
                &self.transaction_id,
                self.thread_root.as_ref(),
            )
            .await?
            .abort()
            .await
            .or_failed(core, "cancel_send")?;

        core.client().await?.send_queue().set_enabled(true).await;

        Ok(cancelled)
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct ScheduleParams {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub room_id: OwnedRoomId,
    pub body: String,
    #[serde(default)]
    pub formatted: Option<String>,
    #[cfg_attr(feature = "typegen", specta(type = specta_typescript::Number))]
    pub delay_ms: u64,
    #[serde(default)]
    pub persona: Option<PerMessageProfileView>,
}

impl Handler for ScheduleParams {
    /// The delay id.
    type Ok = String;

    async fn run(self, core: &Arc<Core>) -> Result<String, RpcError> {
        let content = message_content(
            self.body,
            self.formatted,
            MessageKind::Text,
            Vec::new(),
            false,
        );
        core.schedule_message(&self.room_id, content, self.delay_ms, self.persona.as_ref())
            .await
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct ScheduleAttachmentParams {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub room_id: OwnedRoomId,
    pub filename: String,
    pub mime: String,
    pub url: String,
    #[cfg_attr(feature = "typegen", specta(type = specta_typescript::Number))]
    pub size: u64,
    #[serde(default)]
    pub info: Option<AttachmentInfoView>,
    #[serde(default)]
    pub spoiler: bool,
    #[cfg_attr(feature = "typegen", specta(type = specta_typescript::Number))]
    pub delay_ms: u64,
    #[serde(default)]
    pub persona: Option<PerMessageProfileView>,
}

impl Handler for ScheduleAttachmentParams {
    /// The delay id.
    type Ok = String;

    async fn run(self, core: &Arc<Core>) -> Result<String, RpcError> {
        core.schedule_attachment(self).await
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct ScheduledParams {
    #[serde(default)]
    #[cfg_attr(feature = "typegen", specta(type = Option<String>))]
    pub room_id: Option<OwnedRoomId>,
}

impl Handler for ScheduledParams {
    type Ok = Vec<ScheduledMessageView>;

    async fn run(self, core: &Arc<Core>) -> Result<Vec<ScheduledMessageView>, RpcError> {
        core.scheduled_messages(self.room_id.as_ref()).await
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct CancelScheduledParams {
    pub delay_id: String,
}

impl Handler for CancelScheduledParams {
    type Ok = ();

    async fn run(self, core: &Arc<Core>) -> Result<(), RpcError> {
        core.cancel_scheduled_message(self).await
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct SendScheduledParams {
    pub delay_id: String,
}

impl Handler for SendScheduledParams {
    type Ok = ();

    async fn run(self, core: &Arc<Core>) -> Result<(), RpcError> {
        core.send_scheduled_message_now(self).await
    }
}

/// MSC3381.
#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct CreatePollParams {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub room_id: OwnedRoomId,
    pub question: String,
    pub answers: Vec<String>,
    /// Withholds the tally until the poll closes.
    pub undisclosed: bool,
    #[cfg_attr(feature = "typegen", specta(type = specta_typescript::Number))]
    pub max_selections: u32,
    #[serde(default)]
    #[cfg_attr(feature = "typegen", specta(type = Option<String>))]
    pub thread_root: Option<OwnedEventId>,
    #[serde(default)]
    pub persona: Option<PerMessageProfileView>,
}

impl Handler for CreatePollParams {
    type Ok = ();

    async fn run(self, core: &Arc<Core>) -> Result<(), RpcError> {
        let content = crate::polls::start(
            &self.question,
            &self.answers,
            self.undisclosed,
            self.max_selections,
        )
        .ok_or(RpcCode::InvalidPoll)?;
        let content =
            matrix_sdk::ruma::events::poll::unstable_start::UnstablePollStartEventContent::from(
                content,
            );

        core.timeline_for(&self.room_id, self.thread_root.as_ref())
            .await?
            .send_with_extra_content(content.into(), message_extra_content(self.persona.as_ref()))
            .await
            .or_failed(core, "create_poll")?;

        Ok(())
    }
}

/// Replaces any earlier vote by this account. An empty selection abstains.
#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct VotePollParams {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub room_id: OwnedRoomId,
    /// The poll's start event.
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub event_id: OwnedEventId,
    /// The ids of the chosen answers.
    pub answers: Vec<String>,
    #[serde(default)]
    #[cfg_attr(feature = "typegen", specta(type = Option<String>))]
    pub thread_root: Option<OwnedEventId>,
    #[serde(default)]
    pub persona: Option<PerMessageProfileView>,
}

impl Handler for VotePollParams {
    type Ok = ();

    async fn run(self, core: &Arc<Core>) -> Result<(), RpcError> {
        let content =
            matrix_sdk::ruma::events::poll::unstable_response::UnstablePollResponseEventContent::new(
                self.answers,
                self.event_id,
            );

        core.timeline_for(&self.room_id, self.thread_root.as_ref())
            .await?
            .send_with_extra_content(content.into(), message_extra_content(self.persona.as_ref()))
            .await
            .or_failed(core, "vote_poll")?;

        Ok(())
    }
}

/// Irreversible.
#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct EndPollParams {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub room_id: OwnedRoomId,
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub event_id: OwnedEventId,
    #[serde(default)]
    #[cfg_attr(feature = "typegen", specta(type = Option<String>))]
    pub thread_root: Option<OwnedEventId>,
    #[serde(default)]
    pub persona: Option<PerMessageProfileView>,
}

impl Handler for EndPollParams {
    type Ok = ();

    async fn run(self, core: &Arc<Core>) -> Result<(), RpcError> {
        let content =
            matrix_sdk::ruma::events::poll::unstable_end::UnstablePollEndEventContent::new(
                "The poll has closed.",
                self.event_id,
            );

        core.timeline_for(&self.room_id, self.thread_root.as_ref())
            .await?
            .send_with_extra_content(content.into(), message_extra_content(self.persona.as_ref()))
            .await
            .or_failed(core, "end_poll")?;

        Ok(())
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct SendGestureParams {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub room_id: OwnedRoomId,
    pub gesture: GestureView,
    #[cfg_attr(feature = "typegen", specta(type = Option<String>))]
    #[serde(default)]
    pub target: Option<OwnedUserId>,
    #[serde(default)]
    pub persona: Option<PerMessageProfileView>,
}

impl Handler for SendGestureParams {
    type Ok = ();

    async fn run(self, core: &Arc<Core>) -> Result<(), RpcError> {
        core.send_gesture(
            &self.room_id,
            self.gesture,
            self.target.as_ref(),
            self.persona.as_ref(),
        )
        .await
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct UrlPreviewParams {
    pub url: String,
    #[serde(default)]
    pub client: bool,
    #[serde(default)]
    pub service: Option<String>,
    #[serde(default)]
    pub klipy_api_key: Option<String>,
}

impl Handler for UrlPreviewParams {
    type Ok = Option<UrlPreviewView>;

    async fn run(self, core: &Arc<Core>) -> Result<Option<UrlPreviewView>, RpcError> {
        let url = self.url;
        if self.client {
            #[cfg(not(target_family = "wasm"))]
            return crate::link_previews::scrape_locally(
                &url,
                &sable_link_preview::ScrapeOptions {
                    klipy_api_key: self.klipy_api_key,
                },
            )
            .await;
            #[cfg(target_family = "wasm")]
            {
                let Some(base) = self.service else {
                    return Ok(None);
                };
                let data = crate::link_previews::soliditas_preview(&base, &url).await?;
                return Ok(data.and_then(|data| url_preview(url, &data)));
            }
        }

        let sent = core
            .client()
            .await?
            .send(get_media_preview::v1::Request::new(url.clone()))
            .await;

        let response = match sent {
            Ok(response) => response,
            Err(error) if preview_refused(&error) => {
                tracing::info!(context = "url_preview", "the homeserver refused the url");
                return Ok(None);
            }
            Err(error) => return Err(core.rpc_error("url_preview", &error)),
        };

        Ok(response
            .data
            .and_then(|raw| serde_json::from_str::<serde_json::Value>(raw.get()).ok())
            .and_then(|data| url_preview(url, &data)))
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct FrequentReactionsParams {
    #[serde(default)]
    #[cfg_attr(feature = "typegen", specta(type = Option<specta_typescript::Unknown>))]
    pub legacy: Option<serde_json::Value>,
    #[serde(default)]
    pub recent: Vec<String>,
}

impl Handler for FrequentReactionsParams {
    type Ok = Vec<String>;

    async fn run(self, core: &Arc<Core>) -> Result<Self::Ok, RpcError> {
        core.frequent_reactions(self.legacy, &self.recent).await
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct RememberEmojiParams {
    pub key: String,
}

impl Handler for RememberEmojiParams {
    type Ok = ();

    async fn run(self, core: &Arc<Core>) -> Result<Self::Ok, RpcError> {
        core.remember_reaction(&self.key).await
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct ReactionShortcodesParams {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub room_id: OwnedRoomId,
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub event_id: OwnedEventId,
}

impl Handler for ReactionShortcodesParams {
    type Ok = Vec<ReactionShortcodeView>;

    async fn run(self, core: &Arc<Core>) -> Result<Vec<ReactionShortcodeView>, RpcError> {
        core.reaction_shortcodes(&self.room_id, &self.event_id)
            .await
    }
}

/// The server expires it by itself, so a missed `false` is not fatal.
#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct SetTypingParams {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub room_id: OwnedRoomId,
    pub typing: bool,
}

impl Handler for SetTypingParams {
    type Ok = ();

    async fn run(self, core: &Arc<Core>) -> Result<(), RpcError> {
        let room = core.room(&self.room_id).await?;
        if room.state() != matrix_sdk::RoomState::Joined {
            return Ok(());
        }
        room.typing_notice(self.typing)
            .await
            .or_failed(core, "set_typing")
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct MediaConfigParams {}

/// A struct rather than a bare `u64`, which the TypeScript export refuses.
#[derive(Debug, Serialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct MediaConfigOk {
    #[cfg_attr(feature = "typegen", specta(type = specta_typescript::Number))]
    pub upload_size: u64,
}

impl Handler for MediaConfigParams {
    type Ok = MediaConfigOk;

    async fn run(self, core: &Arc<Core>) -> Result<MediaConfigOk, RpcError> {
        Ok(MediaConfigOk {
            upload_size: core.max_upload_size().await?,
        })
    }
}
