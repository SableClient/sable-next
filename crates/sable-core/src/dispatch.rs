use std::sync::{Arc, atomic::Ordering};

use matrix_sdk::RoomMemberships;
use matrix_sdk::deserialized_responses::RawAnySyncOrStrippedState;
use matrix_sdk::room::ListThreadsOptions;
use matrix_sdk::room::Receipts;
use matrix_sdk::ruma::RoomAliasId;
use matrix_sdk::ruma::api::Direction;
use matrix_sdk::ruma::api::client::alias::{create_alias, delete_alias};
use matrix_sdk::ruma::api::client::authenticated_media::get_media_preview;
use matrix_sdk::ruma::api::client::directory::{get_room_visibility, set_room_visibility};
use matrix_sdk::ruma::api::client::discovery::get_capabilities;
use matrix_sdk::ruma::api::client::profile::{PropagateTo, set_profile_field};
use matrix_sdk::ruma::api::client::room::Visibility;
use matrix_sdk::ruma::api::client::room::aliases;
use matrix_sdk::ruma::api::client::room::create_room::{self, v3::RoomPreset};
use matrix_sdk::ruma::api::client::room::get_event_by_timestamp;
use matrix_sdk::ruma::api::client::room::upgrade_room;
use matrix_sdk::ruma::api::client::state::{get_state_event_for_key, get_state_events};
use matrix_sdk::ruma::api::error::ErrorKind;
use matrix_sdk::ruma::api::federation::discovery::get_server_version;
use matrix_sdk::ruma::events::InitialStateEvent;
use matrix_sdk::ruma::events::relation::{InReplyTo, Reply, Thread};
use matrix_sdk::ruma::events::room::ImageInfo;
use matrix_sdk::ruma::events::room::avatar::RoomAvatarEventContent;
use matrix_sdk::ruma::events::room::create::{PreviousRoom, RoomCreateEventContent};
use matrix_sdk::ruma::events::room::encryption::RoomEncryptionEventContent;
use matrix_sdk::ruma::events::room::message::Relation;
use matrix_sdk::ruma::events::room::power_levels::{RoomPowerLevels, RoomPowerLevelsEventContent};
use matrix_sdk::ruma::events::sticker::StickerEventContent;
use matrix_sdk::ruma::events::tag::{TagInfo, TagName};
use matrix_sdk::ruma::profile::{ProfileFieldName, ProfileFieldValue};
use matrix_sdk::ruma::room::RoomType;
use matrix_sdk::ruma::serde::Raw;
use matrix_sdk::ruma::{
    MilliSecondsSinceUnixEpoch, OwnedMxcUri, OwnedRoomId, OwnedUserId, RoomId, RoomOrAliasId,
    ServerName, UInt, events::room::member::MembershipState,
};
use matrix_sdk::ruma::{
    RoomVersionId, api::client::discovery::get_capabilities::v3::RoomVersionStability,
};
use matrix_sdk_ui::timeline::{
    Error as TimelineError, RedactError, RoomExt, TimelineEventItemId, TimelineFocus,
};

use crate::ResultExt;
use crate::protocol::{
    Command, CommandErr, CommandOk, CoreEvent, CreateJoinRuleView, CreateRoomKind,
    HomeserverSoftwareView, ImageSourcePackReferenceView, ImageSourcePackView, MembershipView,
    MessageKind, MutualRoomView, PackImageInfoView, PaginationDirection, ProfilePropagationView,
    RoomOpenView, RoomStateEventView, RoomTag, RoomVersionView, RoomVersionsView,
    UrlPreviewVideoView, UrlPreviewView,
};
use matrix_sdk_ui::notification_client::NotificationProcessSetup;

const POWER_LEVEL_TAGS_EVENT_TYPE: &str = "in.cinny.room.power_level_tags";
const WIDGETS_EVENT_TYPE: &str = "im.vector.modular.widgets";

use crate::media::mxc_uri;
use crate::outgoing::{gif_content, location_content, message_content, reply_to, thread_reply};
use crate::presence;
use crate::profiles::profile_view;
use crate::verification::{encryption_status, sign_out_safety};
use crate::widgets::RelationsFilter;
use crate::{Core, SubscriptionKind};
use crate::{notifications, push_check, push_rules, session, view, webpush};

const MAX_SEARCH_RESULTS: usize = 200;
const MAX_SEARCH_CONTEXT: usize = 3;

fn preview_refused(error: &matrix_sdk::HttpError) -> bool {
    error
        .as_client_api_error()
        .is_some_and(|api_error| api_error.status_code.as_u16() == 403)
}

pub(crate) const PREVIEW_THEME_COLOR: &str = "com.sable.theme_color";
pub(crate) const PREVIEW_CARD: &str = "com.sable.card";
pub(crate) const PREVIEW_AUTHOR: &str = "com.sable.author_name";

pub(crate) fn preview_video(data: &serde_json::Value) -> Option<UrlPreviewVideoView> {
    let source = data
        .get("og:video")?
        .as_str()
        .filter(|source| source.starts_with("mxc://"))?
        .to_owned();
    let mime = data
        .get("og:video:type")
        .and_then(serde_json::Value::as_str)
        .map(ToOwned::to_owned);
    let number = |key: &str| data.get(key).and_then(serde_json::Value::as_u64);
    Some(UrlPreviewVideoView {
        source,
        mime,
        width: number("og:video:width"),
        height: number("og:video:height"),
    })
}

pub(crate) fn preview_theme_color(data: &serde_json::Value) -> Option<String> {
    let color = data.get(PREVIEW_THEME_COLOR)?.as_str()?;
    let digits = color.strip_prefix('#')?;
    (matches!(digits.len(), 3 | 4 | 6 | 8) && digits.chars().all(|c| c.is_ascii_hexdigit()))
        .then(|| color.to_owned())
}

pub(crate) fn preview_card(data: &serde_json::Value) -> Option<String> {
    let card = data.get(PREVIEW_CARD)?.as_str()?;
    matches!(card, "summary" | "summary_large_image").then(|| card.to_owned())
}

fn url_preview(url: String, data: &serde_json::Value) -> Option<UrlPreviewView> {
    let text = |key: &str| {
        data.get(key)
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned)
    };
    let number = |key: &str| data.get(key).and_then(serde_json::Value::as_u64);

    let preview = UrlPreviewView {
        url,
        title: text("og:title"),
        description: text("og:description"),
        site_name: text("og:site_name"),
        image: text("og:image").filter(|image| image.starts_with("mxc://")),
        image_mime: text("og:image:type"),
        image_width: number("og:image:width"),
        image_height: number("og:image:height"),
        video: preview_video(data),
        theme_color: preview_theme_color(data),
        card: preview_card(data),
        author_name: text(PREVIEW_AUTHOR),
    };

    if preview.title.is_none()
        && preview.description.is_none()
        && preview.image.is_none()
        && preview.video.is_none()
    {
        return None;
    }
    Some(preview)
}

fn join_rule_content(
    rule: Option<CreateJoinRuleView>,
    parent_space: Option<&RoomId>,
) -> Option<serde_json::Value> {
    let allow = |kind: &str| {
        parent_space.map(|space| {
            serde_json::json!({
                "type": "m.room.join_rules",
                "state_key": "",
                "content": {
                    "join_rule": kind,
                    "allow": [{ "type": "m.room_membership", "room_id": space }],
                },
            })
        })
    };
    let plain = |kind: &str| {
        serde_json::json!({
            "type": "m.room.join_rules",
            "state_key": "",
            "content": { "join_rule": kind },
        })
    };

    match rule? {
        CreateJoinRuleView::Public => Some(plain("public")),
        CreateJoinRuleView::Invite => Some(plain("invite")),
        CreateJoinRuleView::Knock => Some(plain("knock")),
        CreateJoinRuleView::Restricted => {
            Some(allow("restricted").unwrap_or_else(|| plain("invite")))
        }
        CreateJoinRuleView::KnockRestricted => {
            Some(allow("knock_restricted").unwrap_or_else(|| plain("invite")))
        }
    }
}

fn state_event_content(raw: &str) -> Option<serde_json::Value> {
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

impl Core {
    /// Splitting this by command family needs a second match with an
    /// unreachable arm, which `clippy::panic = "deny"` rules out.
    ///
    /// # Errors
    ///
    /// Returns a protocol error when the command is invalid, the user is not
    /// authenticated, or the Matrix operation fails.
    #[allow(clippy::too_many_lines)]
    pub async fn dispatch(self: &Arc<Self>, command: Command) -> Result<CommandOk, CommandErr> {
        match command {
            Command::DiscoverHomeserver { server_name } => {
                let client = session::discovery_client(&server_name)
                    .await
                    .map_err(|_| CommandErr::UnknownHomeserver)?;

                Ok(CommandOk::DiscoverHomeserver {
                    homeserver: client.homeserver().to_string(),
                })
            }

            Command::Login {
                reauth_account_id,
                homeserver,
                identifier,
                password,
            } => {
                self.login(homeserver, identifier, password, reauth_account_id)
                    .await
            }

            Command::LoginFlows { homeserver } => self.login_flows(homeserver).await,

            Command::RegistrationFlows { homeserver } => {
                self.discover_registration_flows(homeserver).await
            }

            Command::Register {
                homeserver,
                username,
                password,
                registration_email,
                registration_token,
            } => {
                self.register(
                    homeserver,
                    username,
                    password,
                    registration_email,
                    registration_token,
                )
                .await
            }

            Command::RequestRegistrationEmail { email } => {
                self.request_registration_email(email).await
            }

            Command::SubmitRegistrationEmail { token } => {
                self.submit_registration_email(token).await
            }

            Command::ContinueRegistration => self.continue_registration(true).await,

            Command::CancelRegistration => {
                self.next_registration_attempt
                    .fetch_add(1, Ordering::AcqRel);
                self.pending_registration.lock().await.take();
                self.pending_login.lock().await.take();
                Ok(CommandOk::CancelRegistration)
            }

            Command::RequestPasswordResetEmail {
                homeserver,
                email,
                client_secret,
                send_attempt,
            } => {
                self.request_password_reset_email(homeserver, email, client_secret, send_attempt)
                    .await
            }

            Command::ResetPassword {
                homeserver,
                client_secret,
                sid,
                new_password,
                logout_devices,
            } => {
                self.reset_password(homeserver, client_secret, sid, new_password, logout_devices)
                    .await
            }

            Command::StartOidcLogin {
                reauth_account_id,
                homeserver,
                redirect_uri,
                intent,
            } => {
                self.start_oidc_login(homeserver, redirect_uri, intent, reauth_account_id)
                    .await
            }

            Command::CompleteOidcLogin { callback_url } => {
                self.complete_oidc_login(callback_url).await
            }

            Command::StartSsoLogin {
                reauth_account_id,
                homeserver,
                redirect_uri,
                idp_id,
                intent,
            } => {
                self.start_sso_login(homeserver, redirect_uri, idp_id, intent, reauth_account_id)
                    .await
            }

            Command::CompleteSsoLogin { callback_url } => {
                self.complete_sso_login(callback_url).await
            }

            Command::Restore => self.restore().await,

            Command::ListAccounts => self.list_accounts().await,

            Command::SwitchAccount { account_id } => self.switch_account(account_id).await,

            Command::RemoveAccount { account_id } => self.remove_inactive_account(account_id).await,

            Command::Logout => self.logout().await,

            #[cfg(not(target_family = "wasm"))]
            Command::ResetLocalCache => self.reset_local_cache().await,
            #[cfg(target_family = "wasm")]
            Command::ResetLocalCache => Err(CommandErr::Unsupported),

            Command::HomeserverInfo => {
                let client = self.client().await?;
                let server = match client.send(get_server_version::v1::Request::new()).await {
                    Ok(response) => response.server.map(|server| HomeserverSoftwareView {
                        name: server.name,
                        version: server.version,
                    }),
                    Err(error) => {
                        tracing::debug!(%error, "the homeserver did not report its version");
                        None
                    }
                };

                Ok(CommandOk::HomeserverInfo {
                    homeserver: client.homeserver().to_string(),
                    server,
                })
            }

            Command::SubscribeRoomList => self.subscribe_room_list().await,

            Command::SubscribeTimeline {
                room_id,
                focus,
                hidden_events,
            } => self.subscribe_timeline(room_id, focus, hidden_events).await,

            Command::Unsubscribe { subscription } => {
                let mut subscribed = self.room_subscriptions.lock().await;
                let Some(removed) = self.subscriptions.lock().await.remove(&subscription) else {
                    return Err(CommandErr::UnknownSubscription);
                };
                let has_room = !matches!(removed.kind, SubscriptionKind::Other);
                drop(removed);
                if has_room {
                    self.sync_timeline_rooms_locked(&mut subscribed).await?;
                }

                Ok(CommandOk::Unsubscribe)
            }

            Command::Paginate {
                subscription,
                direction,
                count,
            } => {
                let (timeline, focused) = self
                    .subscriptions
                    .lock()
                    .await
                    .get(&subscription)
                    .and_then(|subscription| {
                        subscription.timeline.clone().map(|timeline| {
                            (
                                timeline,
                                matches!(subscription.kind, SubscriptionKind::FocusedTimeline(_)),
                            )
                        })
                    })
                    .ok_or(CommandErr::UnknownSubscription)?;
                if matches!(direction, PaginationDirection::Forward) && !focused {
                    return Err(CommandErr::InvalidPaginationDirection);
                }
                let _foreground = self.begin_foreground_pagination();
                let reached_end = match direction {
                    PaginationDirection::Backward => timeline.paginate_backwards(count).await,
                    PaginationDirection::Forward => timeline.paginate_forwards(count).await,
                }
                .or_failed(self, "paginate")?;

                Ok(CommandOk::Paginate {
                    direction,
                    reached_end,
                })
            }

            Command::SendMessage {
                room_id,
                body,
                formatted,
                kind,
                thread_root,
                in_reply_to,
                mentions,
                mentions_room,
                silent_reply,
                persona,
                link_previews,
                image_source_packs,
                bot_command,
            } => {
                let timeline = self.timeline_for(&room_id, thread_root.as_ref()).await?;
                let (body, formatted, persona) = match persona {
                    Some(persona) => {
                        let (body, formatted, persona) =
                            crate::personas::outgoing_with_fallback(body, formatted, &persona);
                        (body, formatted, Some(persona))
                    }
                    None => (body, formatted, None),
                };
                let content = message_content(body, formatted, kind, mentions, mentions_room);

                let reply = thread_reply(in_reply_to, thread_root.clone(), silent_reply);
                let content = self
                    .with_reply(&room_id, content, reply, thread_root.clone(), "send_reply")
                    .await?;

                let extra = extra_content(
                    persona.as_ref().map(crate::personas::profile_extra_content),
                    [
                        (BUNDLED_LINK_PREVIEWS, bundled_link_previews(&link_previews)),
                        (
                            IMAGE_SOURCE_PACKS,
                            image_source_pack_references(&image_source_packs),
                        ),
                        (crate::bot_commands::COMMAND_FIELD, bot_command),
                    ],
                );
                timeline
                    .send_with_extra_content(content.into(), extra)
                    .await
                    .or_failed(self, "send_message")?;

                Ok(CommandOk::SendMessage)
            }

            Command::SendRawEvent {
                room_id,
                event_type,
                mut content,
            } => {
                ensure_empty_mentions(&mut content);
                let response = self
                    .room(&room_id)
                    .await?
                    .send_raw(&event_type, content)
                    .await
                    .or_failed(self, "send_raw_event")?;

                Ok(CommandOk::SendRawEvent {
                    event_id: response.response.event_id,
                })
            }

            Command::SendRedaction {
                room_id,
                event_id,
                reason,
            } => {
                let response = self
                    .room(&room_id)
                    .await?
                    .redact(&event_id, reason.as_deref(), None)
                    .await
                    .map_err(|error| self.homeserver_http_error("send_redaction", error))?;
                Ok(CommandOk::SendRedaction {
                    event_id: response.event_id,
                })
            }

            Command::CalendarEntries { room_id } => Ok(CommandOk::CalendarEntries(
                self.calendar_entries(&room_id).await?,
            )),

            Command::SaveCalendarEvent {
                room_id,
                event,
                replaces,
            } => {
                self.save_calendar_event(&room_id, event, replaces).await?;
                Ok(CommandOk::SaveCalendarEvent)
            }

            Command::Personas => Ok(CommandOk::Personas {
                catalog: self.personas().await?,
            }),

            Command::SavePersona {
                persona,
                previous_id,
            } => Ok(CommandOk::SavePersona {
                personas: self.save_persona(persona, previous_id).await?,
            }),

            Command::RemovePersona { id } => Ok(CommandOk::RemovePersona {
                personas: self.remove_persona(&id).await?,
            }),

            Command::ReorderPersonas { ids } => Ok(CommandOk::ReorderPersonas {
                personas: self.reorder_personas(ids).await?,
            }),

            Command::SetPersonaSelection {
                room_id,
                persona_id,
                valid_until,
            } => {
                self.set_persona_selection(room_id, persona_id, valid_until)
                    .await?;
                Ok(CommandOk::SetPersonaSelection)
            }

            Command::DisableRoomPersonas { room_id } => {
                self.disable_room_personas(room_id).await?;
                Ok(CommandOk::DisableRoomPersonas)
            }

            Command::SendSticker {
                room_id,
                url,
                body,
                info,
                source_pack,
                in_reply_to,
                thread_root,
                persona,
            } => {
                let url = OwnedMxcUri::from(url);
                if url.parts().is_err() {
                    return Err(CommandErr::InvalidMedia);
                }
                let source = image_source_pack_extra(url.as_str(), source_pack);

                let timeline = self.timeline_for(&room_id, thread_root.as_ref()).await?;
                let mut content = StickerEventContent::new(body, sticker_info(info), url);

                content.relates_to = match (thread_root, in_reply_to) {
                    (Some(root), reply) => {
                        let fallback = reply.unwrap_or_else(|| root.clone());
                        Some(Relation::Thread(Thread::plain(root, fallback)))
                    }
                    (None, Some(event_id)) => {
                        Some(Relation::Reply(Reply::new(InReplyTo::new(event_id))))
                    }
                    (None, None) => None,
                };

                let extra = extra_content(
                    persona.as_ref().map(|persona| {
                        crate::personas::profile_extra_content(&crate::personas::without_fallback(
                            persona,
                        ))
                    }),
                    [
                        (IMAGE_SOURCE_PACKS, source),
                        ("m.mentions", Some(serde_json::json!({}))),
                    ],
                );
                timeline
                    .send_with_extra_content(content.into(), extra)
                    .await
                    .or_failed(self, "send_sticker")?;

                Ok(CommandOk::SendSticker)
            }

            Command::SendGif {
                room_id,
                url,
                body,
                width,
                height,
                mimetype,
                size,
                in_reply_to,
                silent_reply,
                thread_root,
                persona,
            } => {
                let url = OwnedMxcUri::from(url);
                if url.parts().is_err() {
                    return Err(CommandErr::InvalidMedia);
                }

                let mut info = ImageInfo::new();
                info.width = width.map(Into::into);
                info.height = height.map(Into::into);
                info.mimetype = Some(mimetype);
                info.size = size.map(Into::into);

                let timeline = self.timeline_for(&room_id, thread_root.as_ref()).await?;
                let content = gif_content(body, url, info);

                let reply = thread_reply(in_reply_to, thread_root.clone(), silent_reply);
                let content = self
                    .with_reply(&room_id, content, reply, thread_root, "send_gif_reply")
                    .await?;
                timeline
                    .send_with_extra_content(
                        content.into(),
                        persona.as_ref().map(|persona| {
                            crate::personas::profile_extra_content(
                                &crate::personas::without_fallback(persona),
                            )
                        }),
                    )
                    .await
                    .or_failed(self, "send_gif")?;

                Ok(CommandOk::SendGif)
            }

            Command::RemoveLinkPreviews {
                room_id,
                event_id,
                thread_root,
            } => {
                Box::pin(self.remove_link_previews(&room_id, &event_id, thread_root.as_ref()))
                    .await?;
                Ok(CommandOk::RemoveLinkPreviews)
            }

            Command::EditMessage {
                room_id,
                event_id,
                transaction_id,
                body,
                formatted,
                kind,
                media_caption,
                thread_root,
                mentions,
                mentions_room,
                persona,
            } => {
                self.edit_message(
                    &room_id,
                    event_id,
                    transaction_id,
                    body,
                    formatted,
                    kind,
                    media_caption,
                    thread_root,
                    mentions,
                    mentions_room,
                    persona,
                )
                .await?;
                Ok(CommandOk::EditMessage)
            }

            Command::FetchEventDetails {
                room_id,
                event_id,
                thread_root,
            } => {
                self.timeline_for(&room_id, thread_root.as_ref())
                    .await?
                    .fetch_details_for_event(&event_id)
                    .await
                    .or_failed(self, "fetch_event_details")?;

                Ok(CommandOk::FetchEventDetails)
            }

            Command::SearchMessages {
                query,
                filter,
                order,
                limit,
                offset,
                context,
                older,
            } => {
                let limit = (limit as usize).min(MAX_SEARCH_RESULTS);
                let context = (context as usize).min(MAX_SEARCH_CONTEXT);
                let (hits, older) = if let Some(cursor) = older {
                    self.search_older(&query, &filter, order, limit, &cursor, context)
                        .await
                } else {
                    let hits = self
                        .search_messages(&query, &filter, order, limit, offset as usize, context)
                        .await;
                    let older = if self.searches_locally(&query, &filter, order).await {
                        self.older_start(&filter).await
                    } else {
                        None
                    };
                    (hits, older)
                };

                Ok(CommandOk::SearchMessages {
                    hits: hits.into_iter().map(view::search_hit_view).collect(),
                    older,
                })
            }

            Command::JoinCall {
                room_id,
                livekit_service_url,
                mode,
                intent,
            } => {
                self.join_call(room_id, livekit_service_url, mode, intent)
                    .await
            }

            Command::CallSupport {
                room_id,
                livekit_service_url,
            } => self.call_support(room_id, livekit_service_url).await,

            Command::LeaveCall { session } => self.leave_call(session).await,

            Command::DeclineCall {
                room_id,
                notification_event_id,
            } => self.decline_call(room_id, notification_event_id).await,

            Command::RoomMembers {
                room_id,
                memberships,
            } => {
                let room = self.room(&room_id).await?;
                let members = room
                    .members(membership_filter(&memberships))
                    .await
                    .or_failed(self, "room_members")?;
                let power_levels = if room.power_levels().await.is_err() {
                    let content = self
                        .room_state_event_content(
                            room_id,
                            "m.room.power_levels".to_owned(),
                            String::new(),
                        )
                        .await
                        .ok()
                        .flatten()
                        .and_then(|content| {
                            serde_json::from_value::<RoomPowerLevelsEventContent>(content).ok()
                        });
                    let rules = room.clone_info().room_version_rules_or_default();
                    content.map(|content| {
                        RoomPowerLevels::new(
                            content.into(),
                            &rules.authorization,
                            room.creators().unwrap_or_default(),
                        )
                    })
                } else {
                    None
                };

                Ok(CommandOk::RoomMembers {
                    members: members
                        .iter()
                        .map(|member| {
                            let mut member = view::member_view(member);
                            if let Some(levels) = &power_levels {
                                member.power_level =
                                    view::clamp_power_level(levels.for_user(&member.user_id));
                            }
                            member
                        })
                        .collect(),
                })
            }

            Command::RoomPermissions { room_id } => Ok(CommandOk::RoomPermissions(
                self.room_permissions(&room_id).await?,
            )),

            Command::ImagePacks {
                room_id,
                cached_only,
            } => self.image_packs(room_id, cached_only).await,
            Command::AllImagePacks => self.all_image_packs().await,

            Command::UserProfile { user_id } => {
                let response = self
                    .client()
                    .await?
                    .account()
                    .fetch_user_profile_of(&user_id)
                    .await
                    .map_err(|error| self.profile_error(error))?;

                Ok(CommandOk::UserProfile {
                    profile: Box::new(profile_view(user_id, &response)),
                })
            }

            Command::UserRelations { user_id } => {
                let client = self.client().await?;
                let ignored = client
                    .subscribe_to_ignore_user_list_changes()
                    .get()
                    .iter()
                    .any(|ignored| ignored == user_id.as_str());
                // One store read per joined room, sent together because awaiting
                // them in turn is hundreds of IndexedDB round trips.
                let target = &user_id;
                let lookups = client.joined_rooms().into_iter().map(|room| async move {
                    let joined = room
                        .get_member_no_sync(target)
                        .await
                        .ok()
                        .flatten()
                        .is_some_and(|member| member.membership() == &MembershipState::Join);
                    joined.then(|| MutualRoomView {
                        name: room
                            .cached_display_name()
                            .map(|name| name.to_string())
                            .or_else(|| room.name()),
                        room_id: room.room_id().to_owned(),
                        is_space: room.is_space(),
                    })
                });
                let mutual_rooms = futures_util::future::join_all(lookups)
                    .await
                    .into_iter()
                    .flatten()
                    .collect::<Vec<_>>();

                Ok(CommandOk::UserRelations {
                    mutual_rooms,
                    ignored,
                })
            }

            Command::PinnedEvents { room_id } => Ok(CommandOk::PinnedEvents {
                event_ids: self.pinned_events(&room_id).await?,
            }),

            Command::ReactionShortcodes { room_id, event_id } => {
                Ok(CommandOk::ReactionShortcodes {
                    shortcodes: self.reaction_shortcodes(&room_id, &event_id).await?,
                })
            }

            Command::SetPinned {
                room_id,
                event_id,
                pinned,
            } => Ok(CommandOk::SetPinned {
                event_ids: self.set_pinned(&room_id, event_id, pinned).await?,
            }),

            Command::RoomPowerLevels { room_id } => {
                let power_levels = self.room(&room_id).await?.power_levels_or_default().await;

                Ok(CommandOk::RoomPowerLevels(view::room_power_levels(
                    &power_levels,
                )))
            }

            Command::RoomVersions => {
                let response = self
                    .client()
                    .await?
                    .send(get_capabilities::v3::Request::new())
                    .await
                    .or_failed(self, "room_versions")?;

                let versions = response.capabilities.room_versions;
                Ok(CommandOk::RoomVersions(RoomVersionsView {
                    default: versions.default.to_string(),
                    available: versions
                        .available
                        .into_iter()
                        .map(|(id, stability)| RoomVersionView {
                            id: id.to_string(),
                            stable: stability == RoomVersionStability::Stable,
                        })
                        .collect(),
                }))
            }

            Command::UpgradeRoom {
                room_id,
                new_version,
                additional_creators,
            } => {
                let mut request = upgrade_room::v3::Request::new(
                    room_id,
                    RoomVersionId::try_from(new_version).or_failed(self, "upgrade_room")?,
                );
                request.additional_creators = additional_creators;

                let response = self
                    .client()
                    .await?
                    .send(request)
                    .await
                    .map_err(|error| self.room_error("upgrade_room", error.into()))?;

                Ok(CommandOk::UpgradeRoom {
                    replacement_room: response.replacement_room,
                })
            }

            Command::RoomAliases { room_id } => {
                let response = self
                    .client()
                    .await?
                    .send(aliases::v3::Request::new(room_id))
                    .await
                    .map_err(|error| self.room_error("room_aliases", error.into()))?;

                Ok(CommandOk::RoomAliases {
                    aliases: response
                        .aliases
                        .into_iter()
                        .map(|alias| alias.to_string())
                        .collect(),
                })
            }

            Command::CreateRoomAlias { room_id, alias } => {
                let alias = RoomAliasId::parse(alias).or_failed(self, "create_room_alias")?;

                self.client()
                    .await?
                    .send(create_alias::v3::Request::new(alias, room_id))
                    .await
                    .map_err(|error| self.room_error("create_room_alias", error.into()))?;

                Ok(CommandOk::CreateRoomAlias)
            }

            Command::DeleteRoomAlias { alias } => {
                let alias = RoomAliasId::parse(alias).or_failed(self, "delete_room_alias")?;

                self.client()
                    .await?
                    .send(delete_alias::v3::Request::new(alias))
                    .await
                    .map_err(|error| self.room_error("delete_room_alias", error.into()))?;

                Ok(CommandOk::DeleteRoomAlias)
            }

            Command::PublicRooms {
                server,
                search,
                since,
                room_type,
            } => self.public_rooms(server, search, since, room_type).await,

            Command::RoomDirectoryVisibility { room_id } => {
                let response = self
                    .client()
                    .await?
                    .send(get_room_visibility::v3::Request::new(room_id))
                    .await
                    .map_err(|error| self.room_error("room_directory_visibility", error.into()))?;

                Ok(CommandOk::RoomDirectoryVisibility {
                    public: response.visibility == Visibility::Public,
                })
            }

            Command::SetRoomDirectoryVisibility { room_id, public } => {
                let visibility = if public {
                    Visibility::Public
                } else {
                    Visibility::Private
                };

                self.client()
                    .await?
                    .send(set_room_visibility::v3::Request::new(room_id, visibility))
                    .await
                    .map_err(|error| {
                        self.room_error("set_room_directory_visibility", error.into())
                    })?;

                Ok(CommandOk::SetRoomDirectoryVisibility)
            }

            Command::NotificationKeywords => Ok(CommandOk::NotificationKeywords {
                keywords: push_rules::keywords(&self.push_rules().await?.snapshot().await),
            }),

            Command::AddNotificationKeyword { keyword } => {
                let rules = self.push_rules().await?;
                let writes = push_rules::plan_add_keyword(&rules.snapshot().await, &keyword)
                    .or_failed(self, "add_notification_keyword")?;
                rules
                    .apply(writes)
                    .await
                    .or_failed(self, "add_notification_keyword")?;

                Ok(CommandOk::AddNotificationKeyword)
            }

            Command::RemoveNotificationKeyword { keyword } => {
                let rules = self.push_rules().await?;
                rules
                    .apply(push_rules::plan_remove_keyword(
                        &rules.snapshot().await,
                        &keyword,
                    ))
                    .await
                    .or_failed(self, "remove_notification_keyword")?;

                Ok(CommandOk::RemoveNotificationKeyword)
            }

            Command::SetNotificationKeywordMode { keyword, mode } => {
                let rules = self.push_rules().await?;
                rules
                    .apply(push_rules::plan_keyword_mode(
                        &rules.snapshot().await,
                        &keyword,
                        mode,
                    ))
                    .await
                    .or_failed(self, "set_notification_keyword_mode")?;

                Ok(CommandOk::SetNotificationKeywordMode)
            }

            Command::ListThreads { room_id, from } => {
                let room = self.room(&room_id).await?;
                let options = ListThreadsOptions {
                    from,
                    ..ListThreadsOptions::default()
                };
                let threads = room
                    .list_threads(options)
                    .await
                    .map_err(|error| self.room_error("list_threads", error))?;

                let push = room.push_context().await.ok().flatten();
                let roots = futures_util::future::join_all(
                    threads
                        .chunk
                        .into_iter()
                        .map(|event| view::standalone_item(&room, event, None, push.as_ref())),
                )
                .await
                .into_iter()
                .flatten()
                .collect();

                Ok(CommandOk::ListThreads {
                    roots,
                    next_batch: threads.prev_batch_token,
                })
            }

            Command::RoomAttachments {
                room_id,
                kind,
                limit,
                from,
            } => {
                let (items, next_batch) = self
                    .room_attachments(
                        &room_id,
                        kind,
                        (limit as usize).min(MAX_SEARCH_RESULTS),
                        from.as_deref(),
                    )
                    .await?;
                Ok(CommandOk::RoomAttachments { items, next_batch })
            }

            Command::UrlPreview { url } => {
                let sent = self
                    .client()
                    .await?
                    .send(get_media_preview::v1::Request::new(url.clone()))
                    .await;

                let response = match sent {
                    Ok(response) => response,
                    Err(error) if preview_refused(&error) => {
                        tracing::info!(context = "url_preview", "the homeserver refused the url");
                        return Ok(CommandOk::UrlPreview { preview: None });
                    }
                    Err(error) => return Err(self.homeserver_http_error("url_preview", error)),
                };

                let preview = response
                    .data
                    .and_then(|raw| serde_json::from_str::<serde_json::Value>(raw.get()).ok())
                    .and_then(|data| url_preview(url, &data));

                Ok(CommandOk::UrlPreview { preview })
            }

            Command::RoomStateEvents {
                room_id,
                event_type,
            } => Ok(CommandOk::RoomStateEvents {
                events: self.room_state_events(&room_id, &event_type).await?,
            }),

            Command::BotCommands { room_id } => {
                let client = self.client().await?;
                let room = self.room(&room_id).await?;
                Ok(CommandOk::BotCommands {
                    commands: self
                        .bot_commands_for(&client, &room)
                        .await
                        .map_err(|error| self.room_error("bot_commands", error))?,
                })
            }

            Command::RoomStateEvent {
                room_id,
                event_type,
                state_key,
            } => Ok(CommandOk::RoomStateEvent {
                content: self
                    .room_state_event_content(room_id, event_type, state_key)
                    .await?,
            }),

            Command::RoomHasSpaceParent { room_id } => {
                let client = self.client().await?;
                let room = self.room(&room_id).await?;
                Ok(CommandOk::RoomHasSpaceParent {
                    has_space_parent: !view::restricted_parents(&client, &room).await.is_empty(),
                })
            }

            Command::UnjoinedSpaceParents { room_id } => {
                let client = self.client().await?;
                let room = self.room(&room_id).await?;
                Ok(CommandOk::UnjoinedSpaceParents {
                    parents: crate::cosmetics::unjoined_space_parents(&client, &room).await,
                })
            }

            Command::RoomCosmetics { room_id, space_id } => Ok(CommandOk::RoomCosmetics(
                self.room_cosmetics(&room_id, space_id).await?,
            )),

            Command::RoomOpen { room_id } => {
                let (permissions, power_level_tags, widgets, pinned_event_ids) = futures_util::join!(
                    self.room_permissions(&room_id),
                    self.room_state_event_content(
                        room_id.clone(),
                        POWER_LEVEL_TAGS_EVENT_TYPE.to_owned(),
                        String::new(),
                    ),
                    self.room_state_events(&room_id, WIDGETS_EVENT_TYPE),
                    self.pinned_events(&room_id),
                );
                let predecessor = self
                    .room(&room_id)
                    .await
                    .ok()
                    .and_then(|room| view::predecessor(&room));
                Ok(CommandOk::RoomOpen(RoomOpenView {
                    permissions: permissions?,
                    power_level_tags: power_level_tags.unwrap_or_else(|error| {
                        tracing::warn!(?error, "power level tags unavailable");
                        None
                    }),
                    widgets: widgets.unwrap_or_else(|error| {
                        tracing::warn!(?error, "widgets unavailable");
                        Vec::new()
                    }),
                    pinned_event_ids: pinned_event_ids.unwrap_or_else(|error| {
                        tracing::warn!(?error, "pinned events unavailable");
                        Vec::new()
                    }),
                    predecessor,
                }))
            }

            Command::RoomSummary { room_id } => {
                let room = self.room(&room_id).await?;
                Ok(CommandOk::RoomSummary {
                    room: view::listless_room_summary(room).await,
                })
            }

            Command::TimestampToEvent {
                room_id,
                ts,
                direction,
            } => {
                let request = get_event_by_timestamp::v1::Request::new(
                    room_id,
                    MilliSecondsSinceUnixEpoch(UInt::new_saturating(ts)),
                    match direction {
                        PaginationDirection::Backward => Direction::Backward,
                        PaginationDirection::Forward => Direction::Forward,
                    },
                );

                let event_id = match self.client().await?.send(request).await {
                    Ok(response) => Some(response.event_id),
                    Err(error) if error.client_api_error_kind() == Some(&ErrorKind::NotFound) => {
                        None
                    }
                    Err(error) => {
                        return Err(self.homeserver_http_error("timestamp_to_event", error));
                    }
                };

                Ok(CommandOk::TimestampToEvent { event_id })
            }

            Command::RoomAccountData {
                room_id,
                event_type,
            } => {
                let event = self
                    .room(&room_id)
                    .await?
                    .account_data(event_type.into())
                    .await
                    .map_err(|error| self.room_error("room_account_data", error))?;

                let content = event
                    .and_then(|raw| raw.get_field::<serde_json::Value>("content").ok().flatten());

                Ok(CommandOk::RoomAccountData { content })
            }

            Command::EventCached { room_id, event_id } => {
                let (cache, _handles) = self
                    .room(&room_id)
                    .await?
                    .event_cache()
                    .await
                    .or_failed(self, "event_cached")?;
                let cached = cache
                    .find_event(&event_id)
                    .await
                    .or_failed(self, "event_cached")?
                    .is_some();
                Ok(CommandOk::EventCached { cached })
            }

            Command::AccountDataTypes => Ok(CommandOk::AccountDataTypes {
                event_types: self.account_data_types().await?,
            }),

            Command::AccessToken => Ok(CommandOk::AccessToken {
                token: self.client().await?.access_token(),
            }),

            Command::AccountData { event_type } => {
                self.remember_account_data_type(event_type.as_str()).await;
                let content = self
                    .global_account_data(event_type.into(), "account_data")
                    .await?
                    .and_then(|raw| raw.deserialize_as::<serde_json::Value>().ok());
                Ok(CommandOk::AccountData { content })
            }

            Command::SetAccountData {
                event_type,
                content,
            } => {
                self.remember_account_data_type(event_type.as_str()).await;
                self.put_global_account_data(
                    event_type.as_str().into(),
                    &content,
                    "set_account_data",
                )
                .await?;
                self.pack_cache
                    .lock()
                    .await
                    .forget_account_data(&event_type);

                Ok(CommandOk::SetAccountData)
            }

            Command::SealedAccountData { event_type } => {
                self.remember_account_data_type(event_type.as_str()).await;
                Ok(CommandOk::SealedAccountData {
                    document: self.sealed_account_data(&event_type).await?,
                })
            }

            Command::SetSealedAccountData {
                event_type,
                content,
            } => {
                self.remember_account_data_type(event_type.as_str()).await;
                self.set_sealed_account_data(&event_type, &content).await?;
                Ok(CommandOk::SetSealedAccountData)
            }

            Command::SetRoomAccountData {
                room_id,
                event_type,
                content,
            } => {
                let raw = Raw::new(&content)
                    .or_failed(self, "set_room_account_data")?
                    .cast_unchecked();
                self.room(&room_id)
                    .await?
                    .set_account_data_raw(event_type.into(), raw)
                    .await
                    .map_err(|error| self.room_error("set_room_account_data", error))?;

                Ok(CommandOk::SetRoomAccountData)
            }

            Command::ReportMessage {
                room_id,
                event_id,
                reason,
            } => {
                self.report_message(&room_id, event_id, reason).await?;
                Ok(CommandOk::ReportMessage)
            }

            Command::ReportRoom { room_id, reason } => {
                self.report_room(room_id, reason).await?;
                Ok(CommandOk::ReportRoom)
            }

            Command::ReportUser { user_id, reason } => {
                self.report_user(user_id, reason).await?;
                Ok(CommandOk::ReportUser)
            }

            Command::EventItems { room_id, event_ids } => Ok(CommandOk::EventItems {
                items: self.event_items(&room_id, &event_ids).await?,
            }),

            Command::EventSource { room_id, event_id } => Ok(CommandOk::EventSource {
                source: self.event_source(&room_id, &event_id).await?,
            }),

            Command::EditHistory { room_id, event_id } => Ok(CommandOk::EditHistory {
                versions: self.edit_history(&room_id, &event_id).await?,
            }),

            Command::ForwardMessage {
                room_id,
                event_id,
                to_room_id,
            } => {
                self.forward_message(&room_id, &event_id, &to_room_id)
                    .await?;
                Ok(CommandOk::ForwardMessage)
            }

            Command::Bookmarks => Ok(CommandOk::Bookmarks {
                bookmarks: self.bookmarks().await?,
            }),

            Command::InboxNotifications {
                filter,
                include_read,
                limit,
                before_ts,
            } => {
                let (items, has_more) = self
                    .inbox_notifications(filter, include_read, limit, before_ts)
                    .await?;
                Ok(CommandOk::InboxNotifications { items, has_more })
            }

            Command::BackfillInbox { include_read } => {
                let (recorded, has_more) = self.backfill_inbox(include_read).await?;
                Ok(CommandOk::BackfillInbox { recorded, has_more })
            }

            Command::SetBookmark {
                room_id,
                event_id,
                bookmarked,
                now_ms,
            } => Ok(CommandOk::SetBookmark {
                bookmarked: self
                    .set_bookmark(&room_id, &event_id, bookmarked, now_ms)
                    .await?,
            }),

            Command::Redact {
                room_id,
                event_id,
                reason,
                thread_root,
            } => {
                let redacted = self
                    .timeline_for(&room_id, thread_root.as_ref())
                    .await?
                    .redact(
                        &TimelineEventItemId::EventId(event_id.clone()),
                        reason.as_deref(),
                    )
                    .await;
                match redacted {
                    Err(TimelineError::RedactError(RedactError::ItemNotFound(_))) => {
                        self.room(&room_id)
                            .await?
                            .redact(&event_id, reason.as_deref(), None)
                            .await
                            .or_failed(self, "redact")?;
                    }
                    other => other.or_failed(self, "redact")?,
                }

                Ok(CommandOk::Redact)
            }

            Command::DeleteThread {
                room_id,
                root_event_id,
                reason,
            } => {
                self.delete_thread(&room_id, &root_event_id, reason.as_deref())
                    .await?;
                Ok(CommandOk::DeleteThread)
            }

            Command::BulkRedact {
                room_id,
                senders,
                after_ts,
                event_types,
                reason,
            } => {
                let redacted = self
                    .bulk_redact(
                        &room_id,
                        &senders,
                        after_ts,
                        &event_types,
                        reason.as_deref(),
                    )
                    .await?;
                Ok(CommandOk::BulkRedact { redacted })
            }

            Command::React {
                room_id,
                event_id,
                key,
                source_pack,
                shortcode,
                thread_root,
            } => {
                self.ensure_reaction_target(&room_id, &event_id).await?;
                let timeline = self.timeline_for(&room_id, thread_root.as_ref()).await?;
                let shortcode = match shortcode
                    .or_else(|| source_pack.as_ref().map(|source| source.shortcode.clone()))
                {
                    Some(shortcode) => Some(shortcode),
                    None => {
                        self.known_reaction_shortcode(&room_id, &event_id, &key)
                            .await
                    }
                };
                let shortcode = reaction_shortcode(&key, shortcode.as_deref());
                if let Some(source) = image_source_pack_extra(&key, source_pack) {
                    timeline
                        .toggle_reaction_with_extra_content(
                            &TimelineEventItemId::EventId(event_id),
                            &key,
                            extra_content(
                                None,
                                [
                                    (IMAGE_SOURCE_PACKS, Some(source)),
                                    (REACTION_SHORTCODE, shortcode),
                                    ("m.mentions", Some(serde_json::json!({}))),
                                ],
                            ),
                        )
                        .await
                        .or_failed(self, "react")?;
                } else {
                    timeline
                        .toggle_reaction_with_extra_content(
                            &TimelineEventItemId::EventId(event_id),
                            &key,
                            extra_content(
                                empty_mentions_extra(),
                                [(REACTION_SHORTCODE, shortcode)],
                            ),
                        )
                        .await
                        .or_failed(self, "react")?;
                }

                Ok(CommandOk::React)
            }

            Command::RoomTimelineEvents {
                room_id,
                event_type,
                msgtype,
                state_key,
                limit,
                since,
            } => Ok(CommandOk::RoomTimelineEvents {
                events: self
                    .room_timeline_events(
                        &room_id,
                        &event_type,
                        msgtype.as_deref(),
                        state_key.as_deref(),
                        limit,
                        since.as_ref(),
                    )
                    .await?,
            }),
            Command::RoomStateEventsRaw {
                room_id,
                event_type,
                state_key,
            } => Ok(CommandOk::RoomStateEventsRaw {
                events: self
                    .room_state_events_raw(&room_id, &event_type, state_key.as_deref())
                    .await?,
            }),
            Command::RoomFullState { room_id } => {
                let client = self.client().await?;
                let response = client
                    .send(get_state_events::v3::Request::new(room_id))
                    .await
                    .or_failed(self, "room_full_state")?;
                Ok(CommandOk::RoomFullState {
                    events: response
                        .room_state
                        .iter()
                        .filter_map(|raw| raw.deserialize_as::<serde_json::Value>().ok())
                        .collect(),
                })
            }
            Command::SearchUserDirectory { term, limit } => {
                let (limited, results) = self.search_user_directory(&term, limit).await?;
                Ok(CommandOk::SearchUserDirectory { limited, results })
            }
            Command::OpenIdToken => Ok(CommandOk::OpenIdToken {
                token: self.openid_token().await?,
            }),
            Command::WidgetSendDelayedEvent {
                room_id,
                event_type,
                state_key,
                content,
                delay_ms,
                sticky_duration_ms,
            } => Ok(CommandOk::WidgetSendDelayedEvent {
                delay_id: self
                    .widget_send_delayed_event(
                        &room_id,
                        &event_type,
                        state_key,
                        content,
                        delay_ms,
                        sticky_duration_ms,
                    )
                    .await?,
            }),
            Command::WidgetSendStickyEvent {
                room_id,
                event_type,
                content,
                sticky_duration_ms,
            } => Ok(CommandOk::WidgetSendStickyEvent {
                event_id: self
                    .widget_send_sticky_event(&room_id, &event_type, content, sticky_duration_ms)
                    .await?,
            }),
            Command::RestartDelayedEvent { delay_id } => {
                self.restart_delayed_event(delay_id).await?;
                Ok(CommandOk::RestartDelayedEvent)
            }
            Command::WidgetSendToDevice {
                event_type,
                encrypted,
                messages,
            } => {
                self.widget_send_to_device(&event_type, encrypted, messages)
                    .await?;
                Ok(CommandOk::WidgetSendToDevice)
            }
            Command::RoomAccountDataRaw {
                room_id,
                event_type,
            } => Ok(CommandOk::RoomAccountDataRaw {
                event: self.room_account_data_raw(&room_id, &event_type).await?,
            }),
            Command::RoomStickyEvents { room_id } => Ok(CommandOk::RoomStickyEvents {
                events: self.room_sticky_events(&room_id).await?,
            }),
            Command::RoomEventRelations {
                room_id,
                event_id,
                rel_type,
                event_type,
                from,
                to,
                limit,
                direction,
            } => Ok(CommandOk::RoomEventRelations {
                relations: self
                    .room_event_relations(
                        &room_id,
                        &event_id,
                        RelationsFilter {
                            rel_type: rel_type.as_deref(),
                            event_type: event_type.as_deref(),
                            from: from.as_deref(),
                            to: to.as_deref(),
                            limit,
                            direction,
                        },
                    )
                    .await?,
            }),
            Command::TurnServer => Ok(CommandOk::TurnServer {
                server: self.turn_server().await?,
            }),
            Command::RtcTransports => Ok(CommandOk::RtcTransports {
                body: self.rtc_transports().await?,
            }),
            Command::RtcLivekit { endpoint, body } => Ok(CommandOk::RtcLivekit {
                body: self.rtc_livekit(endpoint, &body).await?,
            }),
            Command::SetWidgetFeed { enabled } => {
                self.set_widget_feed(enabled);
                Ok(CommandOk::SetWidgetFeed)
            }
            Command::KnownRooms => Ok(CommandOk::KnownRooms {
                room_ids: self.known_room_ids().await?,
            }),
            Command::IntegrationManagerUrl { room_id } => Ok(CommandOk::IntegrationManagerUrl {
                url: self.integration_manager_url(&room_id).await?,
            }),
            Command::ScheduleMessage {
                room_id,
                body,
                formatted,
                delay_ms,
            } => {
                let content =
                    message_content(body, formatted, MessageKind::Text, Vec::new(), false);
                let delay_id = self.schedule_message(&room_id, content, delay_ms).await?;
                Ok(CommandOk::ScheduleMessage { delay_id })
            }
            Command::ScheduleAttachment {
                room_id,
                filename,
                mime,
                url,
                size,
                info,
                spoiler,
                delay_ms,
            } => {
                let delay_id = self
                    .schedule_attachment(
                        &room_id, filename, mime, url, size, info, spoiler, delay_ms,
                    )
                    .await?;
                Ok(CommandOk::ScheduleAttachment { delay_id })
            }
            Command::ScheduledMessages { room_id } => Ok(CommandOk::ScheduledMessages {
                messages: self.scheduled_messages(room_id.as_ref()).await?,
            }),
            Command::CancelScheduledMessage { delay_id } => {
                self.cancel_scheduled_message(delay_id).await?;
                Ok(CommandOk::CancelScheduledMessage)
            }
            Command::SendScheduledMessage { delay_id } => {
                self.send_scheduled_message_now(delay_id).await?;
                Ok(CommandOk::SendScheduledMessage)
            }
            Command::MediaConfig => Ok(CommandOk::MediaConfig {
                upload_size: self.max_upload_size().await?,
            }),
            Command::DelayedEventsSupported => Ok(CommandOk::DelayedEventsSupported {
                supported: self.delayed_events_supported().await?,
            }),
            Command::SendLocation {
                room_id,
                body,
                geo_uri,
                in_reply_to,
                silent_reply,
                thread_root,
            } => {
                if view::geo_coordinates(&geo_uri).is_none() {
                    return Err(CommandErr::InvalidLocation);
                }

                let timeline = self.timeline_for(&room_id, thread_root.as_ref()).await?;
                let content = location_content(body, geo_uri);
                let reply = in_reply_to
                    .map(|event_id| reply_to(event_id, thread_root.is_some(), silent_reply));
                let content = self
                    .with_reply(&room_id, content, reply, thread_root, "send_location")
                    .await?;
                timeline
                    .send(content.into())
                    .await
                    .or_failed(self, "send_location")?;

                Ok(CommandOk::SendLocation)
            }

            Command::CreatePoll {
                room_id,
                question,
                answers,
                undisclosed,
                max_selections,
                thread_root,
            } => {
                let content = crate::polls::start(&question, &answers, undisclosed, max_selections)
                    .ok_or(CommandErr::InvalidPoll)?;
                let content = matrix_sdk::ruma::events::poll::unstable_start::UnstablePollStartEventContent::from(content);

                self.timeline_for(&room_id, thread_root.as_ref())
                    .await?
                    .send_with_extra_content(content.into(), empty_mentions_extra())
                    .await
                    .or_failed(self, "create_poll")?;

                Ok(CommandOk::CreatePoll)
            }

            Command::VotePoll {
                room_id,
                event_id,
                answers,
                thread_root,
            } => {
                let content = matrix_sdk::ruma::events::poll::unstable_response::UnstablePollResponseEventContent::new(
                answers, event_id,
            );

                self.timeline_for(&room_id, thread_root.as_ref())
                    .await?
                    .send_with_extra_content(content.into(), empty_mentions_extra())
                    .await
                    .or_failed(self, "vote_poll")?;

                Ok(CommandOk::VotePoll)
            }

            Command::EndPoll {
                room_id,
                event_id,
                thread_root,
            } => {
                let content =
                    matrix_sdk::ruma::events::poll::unstable_end::UnstablePollEndEventContent::new(
                        "The poll has closed.",
                        event_id,
                    );

                self.timeline_for(&room_id, thread_root.as_ref())
                    .await?
                    .send_with_extra_content(content.into(), empty_mentions_extra())
                    .await
                    .or_failed(self, "end_poll")?;

                Ok(CommandOk::EndPoll)
            }

            Command::EncryptionStatus => Ok(CommandOk::EncryptionStatus {
                status: encryption_status(&self.client().await?).await,
            }),

            Command::KeyBackupStatus => self.key_backup_status().await,
            Command::DownloadKeyBackup { request_id } => self.download_key_backup(request_id).await,

            Command::SignOutSafety => Ok(CommandOk::SignOutSafety {
                safety: sign_out_safety(&self.client().await?).await,
            }),

            Command::SyncStatus => Ok(CommandOk::SyncStatus {
                status: crate::watchers::sync_status(self.sync_service().await?.state().get()),
            }),

            Command::SearchCoverage => Ok(CommandOk::SearchCoverage {
                coverage: self.search_coverage(&self.client().await?).await,
            }),
            Command::SearchMetrics => Ok(CommandOk::SearchMetrics {
                metrics: self.search_metrics(&self.client().await?).await,
            }),

            Command::Devices => {
                let client = self.client().await?;
                let oauth = client.oauth().full_session().is_some();
                let account_management = oauth
                    && client
                        .oauth()
                        .server_metadata()
                        .await
                        .ok()
                        .and_then(|metadata| metadata.account_management_uri)
                        .is_some();

                Ok(CommandOk::Devices {
                    devices: crate::verification::own_devices(&client).await,
                    account_management,
                    oauth,
                })
            }

            Command::UserSecurity { user_id } => Ok(CommandOk::UserSecurity {
                security: crate::verification::user_security(self, &user_id).await?,
            }),

            Command::RecoverIdentity { recovery_key } => {
                let client = self.client().await?;
                client
                    .encryption()
                    .recovery()
                    .recover(&recovery_key)
                    .await
                    .map_err(|error| self.recovery_error(error))?;
                self.adopt_account_data_key(&client, &recovery_key).await;

                Ok(CommandOk::RecoverIdentity)
            }

            Command::EnableRecovery { passphrase } => {
                let client = self.client().await?;
                let recovery = client.encryption().recovery();
                let enable = recovery.enable();

                let recovery_key = match &passphrase {
                    Some(passphrase) => enable.with_passphrase(passphrase).await,
                    None => enable.await,
                }
                .or_failed(self, "enable_recovery")?;
                self.adopt_account_data_key(&client, &recovery_key).await;

                Ok(CommandOk::EnableRecovery { recovery_key })
            }

            Command::ResetRecoveryKey { passphrase } => {
                let client = self.client().await?;
                let recovery = client.encryption().recovery();
                let reset = recovery.reset_key();

                let recovery_key = match &passphrase {
                    Some(passphrase) => reset.with_passphrase(passphrase).await,
                    None => reset.await,
                }
                .or_failed(self, "reset_recovery_key")?;
                self.adopt_account_data_key(&client, &recovery_key).await;

                Ok(CommandOk::ResetRecoveryKey { recovery_key })
            }

            Command::ResetIdentity => Ok(CommandOk::ResetIdentity {
                step: self.reset_identity().await?,
            }),

            Command::ContinueIdentityReset { password } => Ok(CommandOk::ContinueIdentityReset {
                recovery_key: self.continue_identity_reset(password).await?,
            }),

            Command::CancelIdentityReset => {
                self.cancel_identity_reset().await;
                Ok(CommandOk::CancelIdentityReset)
            }

            Command::ExportRoomKeys { passphrase } => self.export_room_keys(&passphrase).await,
            Command::ImportRoomKeys { export, passphrase } => {
                self.import_room_keys(&export, &passphrase).await
            }

            Command::DeleteDevice {
                device_id,
                password,
            } => Ok(CommandOk::DeleteDevice {
                management_url: self.delete_device(device_id, password).await?,
            }),

            Command::RenameDevice {
                device_id,
                display_name,
            } => {
                let client = self.client().await?;
                let generation = self.session_generation.load(Ordering::SeqCst);
                client
                    .rename_device(&device_id, &display_name)
                    .await
                    .or_failed(self, "rename_device")?;
                self.emit_devices(generation, &client).await;

                Ok(CommandOk::RenameDevice)
            }

            Command::DiscardRoomKey { room_id } => {
                self.room(&room_id)
                    .await?
                    .discard_room_key()
                    .await
                    .or_failed(self, "discard_room_key")?;

                Ok(CommandOk::DiscardRoomKey)
            }

            Command::SetDisplayName { name, propagate_to } => {
                let client = self.client().await?;
                if client
                    .unstable_features()
                    .await
                    .or_failed(self, "set_display_name")?
                    .contains(&matrix_sdk::ruma::api::FeatureFlag::from(
                        "computer.gingershaped.msc4466",
                    ))
                {
                    let value = ProfileFieldValue::new(
                        "displayname",
                        serde_json::Value::String(name.unwrap_or_default()),
                    )
                    .or_failed(self, "set_display_name")?;
                    let mut request = set_profile_field::v3::Request::new(
                        client.user_id().ok_or(CommandErr::NotLoggedIn)?.to_owned(),
                        value,
                    );
                    request.propagate_to = profile_propagation(propagate_to);
                    client
                        .send(request)
                        .await
                        .or_failed(self, "set_display_name")?;
                } else {
                    client
                        .account()
                        .set_display_name(name.as_deref())
                        .await
                        .or_failed(self, "set_display_name")?;
                }

                Ok(CommandOk::SetDisplayName)
            }

            Command::SetAvatarUrl { url, propagate_to } => {
                let url = match url {
                    Some(url) => Some(mxc_uri(&url)?),
                    None => None,
                };

                let client = self.client().await?;
                if client
                    .unstable_features()
                    .await
                    .or_failed(self, "set_avatar_url")?
                    .contains(&matrix_sdk::ruma::api::FeatureFlag::from(
                        "computer.gingershaped.msc4466",
                    ))
                {
                    let value = ProfileFieldValue::new(
                        "avatar_url",
                        serde_json::Value::String(
                            url.map(|url| url.to_string()).unwrap_or_default(),
                        ),
                    )
                    .or_failed(self, "set_avatar_url")?;
                    let mut request = set_profile_field::v3::Request::new(
                        client.user_id().ok_or(CommandErr::NotLoggedIn)?.to_owned(),
                        value,
                    );
                    request.propagate_to = profile_propagation(propagate_to);
                    client
                        .send(request)
                        .await
                        .or_failed(self, "set_avatar_url")?;
                } else {
                    client
                        .account()
                        .set_avatar_url(url.as_deref())
                        .await
                        .or_failed(self, "set_avatar_url")?;
                }

                Ok(CommandOk::SetAvatarUrl)
            }

            Command::SetProfileField { field, value } => {
                let account = self.client().await?.account();
                match value {
                    Some(value) => {
                        let value = ProfileFieldValue::new(&field, value).map_err(|error| {
                            self.failed("set_profile_field_invalid_value", error)
                        })?;
                        account
                            .set_profile_field(value)
                            .await
                            .or_failed(self, "set_profile_field")?;
                    }
                    None => {
                        account
                            .delete_profile_field(ProfileFieldName::from(field.as_str()))
                            .await
                            .or_failed(self, "delete_profile_field")?;
                    }
                }

                Ok(CommandOk::SetProfileField)
            }

            Command::AccountContacts => {
                let emails = self
                    .client()
                    .await?
                    .account()
                    .get_3pids()
                    .await
                    .or_failed(self, "account_contacts")?
                    .threepids
                    .into_iter()
                    .filter(|identifier| identifier.medium.as_str() == "email")
                    .map(|identifier| identifier.address)
                    .collect();

                Ok(CommandOk::AccountContacts { emails })
            }

            Command::IgnoredUsers => {
                let mut users = self
                    .client()
                    .await?
                    .subscribe_to_ignore_user_list_changes()
                    .get()
                    .iter()
                    .filter_map(|user_id| user_id.parse().ok())
                    .collect::<Vec<OwnedUserId>>();
                users.sort();

                Ok(CommandOk::IgnoredUsers { users })
            }

            Command::InviteTriage => Ok(CommandOk::InviteTriage {
                invites: crate::invites::triage(&self.client().await?).await,
            }),

            Command::IgnoreUser { user_id } => {
                self.client()
                    .await?
                    .account()
                    .ignore_user(&user_id)
                    .await
                    .or_failed(self, "ignore_user")?;

                Ok(CommandOk::IgnoreUser)
            }

            Command::UnignoreUser { user_id } => {
                self.client()
                    .await?
                    .account()
                    .unignore_user(&user_id)
                    .await
                    .or_failed(self, "unignore_user")?;

                Ok(CommandOk::UnignoreUser)
            }

            Command::SetTyping { room_id, typing } => {
                self.room(&room_id)
                    .await?
                    .typing_notice(typing)
                    .await
                    .or_failed(self, "set_typing")?;

                Ok(CommandOk::SetTyping)
            }

            Command::NotificationSettings { room_id } => {
                let room = self.room(&room_id).await?;
                let rules = self.push_rules().await?.snapshot().await;

                Ok(CommandOk::NotificationSettings(push_rules::room_settings(
                    &rules,
                    &room_id,
                    notifications::uses_direct_push_rules(&room),
                )))
            }

            Command::RoomNotificationModes { room_ids } => {
                let rules = self.push_rules().await?.snapshot().await;
                let mut rooms = Vec::with_capacity(room_ids.len());
                for room_id in room_ids {
                    if let Ok(room) = self.room(&room_id).await {
                        rooms.push((room_id, notifications::uses_direct_push_rules(&room)));
                    }
                }

                Ok(CommandOk::RoomNotificationModes {
                    modes: push_rules::room_modes(&rules, rooms),
                })
            }

            Command::DefaultNotificationModes => Ok(CommandOk::DefaultNotificationModes {
                modes: push_rules::default_modes(&self.push_rules().await?.snapshot().await),
            }),

            Command::MentionNotifications => Ok(CommandOk::MentionNotifications {
                modes: push_rules::mention_notifications(
                    &self.push_rules().await?.snapshot().await,
                ),
            }),

            Command::MembershipNotifications => Ok(CommandOk::MembershipNotifications {
                enabled: push_rules::membership_notifications(
                    &self.push_rules().await?.snapshot().await,
                ),
            }),

            Command::SetPusher { pusher } => {
                notifications::set_pusher(&self.client().await?, pusher)
                    .await
                    .or_failed(self, "set_pusher")?;

                Ok(CommandOk::SetPusher)
            }

            Command::RemovePusher { pushkey, app_id } => {
                notifications::remove_pusher(&self.client().await?, pushkey, app_id)
                    .await
                    .or_failed(self, "remove_pusher")?;

                Ok(CommandOk::RemovePusher)
            }

            Command::WebPusherSupport => Ok(CommandOk::WebPusherSupport {
                vapid: webpush::support(&self.client().await?)
                    .await
                    .or_failed(self, "webpusher_support")?,
            }),

            Command::SetWebPusher { pusher } => {
                webpush::set_pusher(&self.client().await?, pusher)
                    .await
                    .or_failed(self, "set_webpusher")?;

                Ok(CommandOk::SetWebPusher)
            }

            Command::WebPushers => Ok(CommandOk::WebPushers {
                pushers: webpush::pushers(&self.client().await?)
                    .await
                    .or_failed(self, "webpushers")?,
            }),

            Command::PingPushGateway { url } => Ok(CommandOk::PingPushGateway {
                reached: push_check::ping_gateway(&url).await,
            }),

            Command::DiscoverPushGateway { endpoint } => Ok(CommandOk::DiscoverPushGateway {
                gateway: push_check::discover_gateway(&endpoint).await,
            }),

            Command::SendDiagnosticPush { pushkey, app_id } => Ok(CommandOk::SendDiagnosticPush {
                push: push_check::send_diagnostic_push(&self.client().await?, &pushkey, &app_id)
                    .await
                    .or_failed(self, "send_diagnostic_push")?,
            }),

            Command::AckWebPusher { app_id, ack_token } => {
                webpush::ack(&self.client().await?, app_id, ack_token)
                    .await
                    .or_failed(self, "ack_webpusher")?;

                Ok(CommandOk::AckWebPusher)
            }

            Command::SetNotificationContent { visible, encrypted } => {
                self.notification_content.store(visible, Ordering::Relaxed);
                self.notification_encrypted_content
                    .store(encrypted, Ordering::Relaxed);

                Ok(CommandOk::SetNotificationContent)
            }

            Command::SetNotificationSounds { enabled } => {
                self.notification_sounds.store(enabled, Ordering::Relaxed);

                Ok(CommandOk::SetNotificationSounds)
            }

            Command::SetNotifyOnce { enabled } => {
                self.notify_once.store(enabled, Ordering::Relaxed);

                Ok(CommandOk::SetNotifyOnce)
            }

            Command::SetNotificationsEnabled { enabled } => {
                self.notifications_enabled.store(enabled, Ordering::Relaxed);

                Ok(CommandOk::SetNotificationsEnabled)
            }

            Command::SetSearchOptions {
                disk_budget_mb,
                crawler,
                unmetered_only,
                server_search,
                tuning,
                foreground,
            } => {
                self.search_foreground.store(foreground, Ordering::Relaxed);
                self.search_network.set_unmetered_only(unmetered_only);
                self.search_crawl.lock().await.tuning = tuning.clamped();
                self.search_crawler_enabled
                    .store(crawler, Ordering::Relaxed);
                self.server_search_enabled
                    .store(server_search, Ordering::Relaxed);
                self.search_index
                    .lock()
                    .await
                    .set_disk_budget(usize::try_from(disk_budget_mb).unwrap_or(usize::MAX) << 20);

                Ok(CommandOk::SetSearchOptions)
            }

            Command::SetReadRoom { room_id } => {
                self.set_read_room(room_id);

                Ok(CommandOk::SetReadRoom)
            }

            Command::SetPresence {
                presence,
                status_message,
            } => {
                self.set_desired_presence(presence);

                self.client()
                    .await?
                    .set_presence(presence::state(presence), status_message, true)
                    .await
                    .or_failed(self, "set_presence")?;

                Ok(CommandOk::SetPresence)
            }

            Command::FetchPresence { user_ids } => {
                self.fetch_presence(user_ids).await;

                Ok(CommandOk::FetchPresence)
            }

            Command::SetRoomNotificationMode { room_id, mode } => {
                let room = self.room(&room_id).await?;
                let rules = self.push_rules().await?;
                let direct = notifications::uses_direct_push_rules(&room);
                let writes =
                    push_rules::plan_room_mode(&rules.snapshot().await, &room_id, direct, mode);
                rules
                    .apply(writes)
                    .await
                    .or_failed(self, "set_room_notification_mode")?;

                Ok(CommandOk::SetRoomNotificationMode)
            }

            Command::SetDefaultNotificationMode { direct, mode } => {
                let rules = self.push_rules().await?;
                let before = rules.snapshot().await;
                let writes = push_rules::plan_default_mode(&before, direct, mode)
                    .or_failed(self, "set_default_notification_mode")?;
                rules
                    .apply(writes)
                    .await
                    .or_failed(self, "set_default_notification_mode")?;

                Ok(CommandOk::SetDefaultNotificationMode)
            }

            Command::SetMentionNotifications { rule, mode } => {
                let rules = self.push_rules().await?;
                let writes = push_rules::plan_mention(&rules.snapshot().await, rule, mode)
                    .or_failed(self, "set_mention_notifications")?;
                rules
                    .apply(writes)
                    .await
                    .or_failed(self, "set_mention_notifications")?;

                Ok(CommandOk::SetMentionNotifications)
            }

            Command::SetMembershipNotifications { enabled } => {
                self.push_rules()
                    .await?
                    .apply(push_rules::plan_membership(enabled))
                    .await
                    .or_failed(self, "set_membership_notifications")?;

                Ok(CommandOk::SetMembershipNotifications)
            }

            Command::Notification { room_id, event_id } => {
                let client = self.client().await?;
                let setup = NotificationProcessSetup::SingleProcess {
                    sync_service: self.sync_service().await?,
                };

                Ok(CommandOk::Notification {
                    notification: notifications::notification(&client, setup, &room_id, &event_id)
                        .await,
                })
            }

            Command::PushEvent { room_id, event_id } => {
                let client = self.client().await?;
                let sync_service = self.sync_service().await?;

                Ok(CommandOk::PushEvent {
                    fetched: Box::pin(notifications::fetch_push_event(
                        &client,
                        sync_service,
                        &room_id,
                        &event_id,
                    ))
                    .await,
                })
            }

            Command::SetRoomTag { room_id, tag, set } => {
                let room = self.room(&room_id).await?;
                let name = match tag {
                    RoomTag::Favourite => TagName::Favorite,
                };

                if set {
                    room.set_tag(name, TagInfo::new())
                        .await
                        .map_err(|error| self.room_error("set_room_tag", error))?;
                } else {
                    room.remove_tag(name)
                        .await
                        .map_err(|error| self.room_error("remove_room_tag", error))?;
                }

                Ok(CommandOk::SetRoomTag)
            }

            Command::SetDirect {
                room_id,
                direct,
                user_id,
            } => {
                self.set_direct(&room_id, direct, user_id).await?;
                Ok(CommandOk::SetDirect)
            }

            Command::SetRoomJoinRule { room_id, rule } => {
                self.set_room_join_rule(&room_id, rule).await?;
                Ok(CommandOk::SetRoomJoinRule)
            }

            Command::SendStateEvent {
                room_id,
                event_type,
                state_key,
                content,
            } => {
                let response = self
                    .room(&room_id)
                    .await?
                    .send_state_event_raw(&event_type, &state_key, &content)
                    .await
                    .map_err(|error| self.room_error("send_state_event", error))?;
                self.pack_cache
                    .lock()
                    .await
                    .forget_room(&room_id, &event_type);
                if self.note_cosmetic_state(&room_id, &event_type, &state_key, &content) {
                    self.emit(CoreEvent::RoomCosmeticsChanged { room_id });
                }

                Ok(CommandOk::SendStateEvent {
                    event_id: response.event_id,
                })
            }

            Command::SetRoomName { room_id, name } => {
                // The spec clears a name with an empty one.
                self.room(&room_id)
                    .await?
                    .set_name(name.unwrap_or_default())
                    .await
                    .map_err(|error| self.room_error("set_room_name", error))?;

                Ok(CommandOk::SetRoomName)
            }

            Command::SetRoomTopic { room_id, topic } => {
                self.room(&room_id)
                    .await?
                    .set_room_topic(&topic)
                    .await
                    .map_err(|error| self.room_error("set_room_topic", error))?;

                Ok(CommandOk::SetRoomTopic)
            }

            Command::SetRoomAvatar { room_id, url } => {
                let room = self.room(&room_id).await?;

                match url {
                    Some(url) => {
                        room.set_avatar_url(&mxc_uri(&url)?, None)
                            .await
                            .map_err(|error| self.room_error("set_room_avatar", error))?;
                    }
                    // State cannot be deleted, so empty content is the removal.
                    None => {
                        room.send_state_event(RoomAvatarEventContent::new())
                            .await
                            .map_err(|error| self.room_error("clear_room_avatar", error))?;
                    }
                }

                Ok(CommandOk::SetRoomAvatar)
            }

            Command::SetUserPowerLevel {
                room_id,
                user_id,
                power_level,
            } => {
                self.room(&room_id)
                    .await?
                    .update_power_levels(vec![(&user_id, power_level.into())])
                    .await
                    .map_err(|error| self.room_error("set_user_power_level", error))?;

                Ok(CommandOk::SetUserPowerLevel)
            }

            Command::KickUser {
                room_id,
                user_id,
                reason,
            } => {
                self.room(&room_id)
                    .await?
                    .kick_user(&user_id, reason.as_deref())
                    .await
                    .map_err(|error| self.room_error("kick_user", error))?;

                Ok(CommandOk::KickUser)
            }

            Command::BanUser {
                room_id,
                user_id,
                reason,
            } => {
                self.room(&room_id)
                    .await?
                    .ban_user(&user_id, reason.as_deref())
                    .await
                    .map_err(|error| self.room_error("ban_user", error))?;

                Ok(CommandOk::BanUser)
            }

            Command::UnbanUser {
                room_id,
                user_id,
                reason,
            } => {
                self.room(&room_id)
                    .await?
                    .unban_user(&user_id, reason.as_deref())
                    .await
                    .map_err(|error| self.room_error("unban_user", error))?;

                Ok(CommandOk::UnbanUser)
            }

            Command::RequestVerification { user_id, device_id } => {
                let encryption = self.client().await?.encryption();
                let request = match device_id {
                    Some(device_id) => encryption
                        .get_device(&user_id, &device_id)
                        .await
                        .or_failed(self, "request_verification_device")?
                        .ok_or(CommandErr::Unavailable)?
                        .request_verification_with_methods(
                            crate::verification::VERIFICATION_METHODS.to_vec(),
                        )
                        .await
                        .or_failed(self, "request_verification")?,
                    None => encryption
                        .get_user_identity(&user_id)
                        .await
                        .or_failed(self, "request_verification_identity")?
                        .ok_or(CommandErr::Unavailable)?
                        .request_verification_with_methods(
                            crate::verification::VERIFICATION_METHODS.to_vec(),
                        )
                        .await
                        .or_failed(self, "request_verification")?,
                };

                if request.is_cancelled() {
                    return Err(self.failed(
                        "request_verification",
                        "cancelled on creation by another ongoing request",
                    ));
                }

                let flow_id = request.flow_id().to_owned();
                self.watch_verification(request);

                Ok(CommandOk::RequestVerification { flow_id })
            }

            Command::SetDeviceBlocked {
                user_id,
                device_id,
                blocked,
            } => {
                crate::verification::set_device_blocked(self, &user_id, &device_id, blocked)
                    .await?;
                Ok(CommandOk::SetDeviceBlocked)
            }

            Command::WithdrawVerification { user_id } => {
                self.client()
                    .await?
                    .encryption()
                    .get_user_identity(&user_id)
                    .await
                    .or_failed(self, "withdraw_verification_identity")?
                    .ok_or(CommandErr::Unavailable)?
                    .withdraw_verification()
                    .await
                    .or_failed(self, "withdraw_verification")?;
                Ok(CommandOk::WithdrawVerification)
            }

            Command::StartQrLogin {
                homeserver,
                redirect_uri,
                scanned,
            } => {
                self.start_qr_login(homeserver, redirect_uri, scanned)
                    .await?;
                Ok(CommandOk::StartQrLogin)
            }

            Command::StartQrGrant { scanned } => {
                self.start_qr_grant(scanned).await?;
                Ok(CommandOk::StartQrGrant)
            }

            Command::QrCheckCode { code } => {
                self.qr_check_code(code).await?;
                Ok(CommandOk::QrCheckCode)
            }

            Command::QrGrantContinue { confirm } => {
                self.qr_grant_continue(confirm).await?;
                Ok(CommandOk::QrGrantContinue)
            }

            Command::CancelQr => {
                self.cancel_qr().await;
                Ok(CommandOk::CancelQr)
            }

            Command::AcceptVerification { user_id, flow_id } => {
                let request = self.verification_request(&user_id, &flow_id).await?;

                request
                    .accept_with_methods(crate::verification::VERIFICATION_METHODS.to_vec())
                    .await
                    .or_failed(self, "accept_verification")?;

                Ok(CommandOk::AcceptVerification)
            }

            Command::ScanVerificationQr {
                user_id,
                flow_id,
                data,
            } => {
                self.scan_verification_qr(user_id, flow_id, &data).await?;

                Ok(CommandOk::ScanVerificationQr)
            }

            Command::StartSasVerification { user_id, flow_id } => {
                self.verification_request(&user_id, &flow_id)
                    .await?
                    .start_sas()
                    .await
                    .or_failed(self, "start_sas_verification")?
                    .ok_or(CommandErr::Unavailable)?;

                Ok(CommandOk::StartSasVerification)
            }

            Command::ConfirmVerification { user_id, flow_id } => {
                match self.sas(&user_id, &flow_id).await {
                    Ok(sas) => sas.confirm().await,
                    Err(_) => self.qr(&user_id, &flow_id).await?.confirm().await,
                }
                .or_failed(self, "confirm_verification")?;

                Ok(CommandOk::ConfirmVerification)
            }

            Command::CancelVerification {
                user_id,
                flow_id,
                mismatch,
            } => {
                // No SAS to report a mismatch on before the emoji show.
                match self.sas(&user_id, &flow_id).await {
                    Ok(sas) if mismatch => sas
                        .mismatch()
                        .await
                        .or_failed(self, "cancel_verification_mismatch")?,
                    Ok(sas) => sas
                        .cancel()
                        .await
                        .or_failed(self, "cancel_verification_sas")?,
                    Err(_) if let Ok(qr) = self.qr(&user_id, &flow_id).await => {
                        qr.cancel()
                            .await
                            .or_failed(self, "cancel_verification_qr")?;
                    }
                    Err(_) => self
                        .verification_request(&user_id, &flow_id)
                        .await?
                        .cancel()
                        .await
                        .or_failed(self, "cancel_verification")?,
                }

                Ok(CommandOk::CancelVerification)
            }

            Command::CreateRoom {
                name,
                topic,
                kind,
                public,
                encrypted,
                invite,
                parent_space,
                alias,
                room_version,
                join_rule,
                federate,
                predecessor,
            } => {
                let client = self.client().await?;
                let mut request = create_room::v3::Request::new();
                request.name = name;
                request.topic = topic;
                request.invite = invite;
                request.room_alias_name = alias;
                request.room_version = room_version
                    .map(RoomVersionId::try_from)
                    .transpose()
                    .or_failed(self, "create_room_room_version")?;
                request.visibility = if public {
                    Visibility::Public
                } else {
                    Visibility::Private
                };
                request.preset = Some(if public {
                    RoomPreset::PublicChat
                } else {
                    RoomPreset::PrivateChat
                });

                let room_type = match kind {
                    CreateRoomKind::Text => None,
                    CreateRoomKind::Space => Some(RoomType::Space),
                    CreateRoomKind::Voice => Some(RoomType::Call),
                    CreateRoomKind::Forum => Some(RoomType::from(view::FORUM_ROOM_TYPE)),
                    CreateRoomKind::Calendar => {
                        Some(RoomType::from(crate::calendar::CALENDAR_ROOM_TYPE))
                    }
                };
                if room_type.is_some() || !federate || predecessor.is_some() {
                    let mut creation = RoomCreateEventContent::new_v11();
                    creation.room_type = room_type;
                    creation.federate = federate;
                    creation.predecessor = predecessor.map(PreviousRoom::new);
                    request.creation_content = Some(
                        Raw::new(&creation)
                            .or_failed(self, "create_room_creation_content")?
                            .cast_unchecked(),
                    );
                }

                if let Some(rule) = join_rule_content(join_rule, parent_space.as_deref()) {
                    request.initial_state.push(
                        Raw::new(&rule)
                            .or_failed(self, "create_room_join_rule")?
                            .cast_unchecked(),
                    );
                }

                if matches!(kind, CreateRoomKind::Voice) {
                    // Joining a call means writing your own membership, which the
                    // defaults reserve for moderators. The override is a shallow
                    // merge, so naming `events` drops the server's whole default
                    // map: re-state it or anyone can rename the room.
                    request.power_level_content_override = Some(
                        Raw::new(&serde_json::json!({
                            "events": {
                                "m.room.avatar": 50,
                                "m.room.canonical_alias": 50,
                                "m.room.encryption": 100,
                                "m.room.history_visibility": 100,
                                "m.room.name": 50,
                                "m.room.power_levels": 100,
                                "m.room.server_acl": 100,
                                "m.room.tombstone": 100,
                                (view::CALL_MEMBER_TYPE): 0,
                            },
                        }))
                        .or_failed(self, "create_room_call_power_levels")?
                        .cast_unchecked(),
                    );
                    request.initial_state.push(
                        Raw::new(&serde_json::json!({
                            "type": view::CALL_TYPE,
                            "state_key": "",
                            "content": {},
                        }))
                        .or_failed(self, "create_room_call_state")?
                        .cast_unchecked(),
                    );
                    let mut slot = serde_json::Map::new();
                    slot.insert("status".to_owned(), serde_json::json!("open"));
                    slot.insert(
                        "application".to_owned(),
                        serde_json::json!({"type": "m.call"}),
                    );
                    if encrypted && !public {
                        slot.insert(
                            "encryption".to_owned(),
                            serde_json::json!({"type": "org.matrix.msc4143.per_member"}),
                        );
                    }
                    request.initial_state.push(
                        Raw::new(&serde_json::json!({
                            "type": view::RTC_SLOT_TYPE,
                            "state_key": view::CALL_SLOT_ID,
                            "content": slot,
                        }))
                        .or_failed(self, "create_room_call_slot")?
                        .cast_unchecked(),
                    );
                }

                // Anyone can join and read a public room, so encryption only
                // breaks previews.
                if encrypted && !public {
                    request.initial_state.push(
                        InitialStateEvent::with_empty_state_key(
                            RoomEncryptionEventContent::with_recommended_defaults(),
                        )
                        .to_raw_any(),
                    );
                }

                let room = client
                    .create_room(request)
                    .await
                    .or_failed(self, "create_room")?;

                if matches!(kind, CreateRoomKind::Calendar)
                    && let Err(error) = self.calendar_id(&room).await
                {
                    tracing::warn!(?error, "calendar setup failed");
                }

                if let Some(space_id) = parent_space {
                    self.add_to_space(&space_id, room.room_id(), None).await?;
                }

                Ok(CommandOk::CreateRoom {
                    room_id: room.room_id().to_owned(),
                })
            }

            Command::CreateDm { user_id, encrypted } => {
                let client = self.client().await?;
                let existing = client.get_dm_rooms(&user_id).find(|room| {
                    !room.is_tombstoned()
                        && encrypted
                            .is_none_or(|wanted| room.encryption_state().is_encrypted() == wanted)
                });
                let room = match existing {
                    Some(room) => room,
                    None if encrypted == Some(false) => {
                        let mut request = create_room::v3::Request::new();
                        request.invite = vec![user_id];
                        request.is_direct = true;
                        request.preset = Some(RoomPreset::TrustedPrivateChat);
                        client
                            .create_room(request)
                            .await
                            .or_failed(self, "create_dm")?
                    }
                    None => client
                        .create_dm(&user_id)
                        .await
                        .or_failed(self, "create_dm")?,
                };

                Ok(CommandOk::CreateDm {
                    room_id: room.room_id().to_owned(),
                })
            }

            Command::AddToSpace {
                space_id,
                room_id,
                suggested,
            } => {
                self.add_to_space(&space_id, &room_id, suggested).await?;

                Ok(CommandOk::AddToSpace)
            }

            Command::SetSpaceChildOrder {
                space_id,
                room_id,
                order,
            } => self.set_space_child_order(&space_id, &room_id, order).await,

            Command::SetSpaceChildSuggested {
                space_id,
                room_id,
                suggested,
            } => {
                self.set_space_child_suggested(&space_id, &room_id, suggested)
                    .await
            }

            Command::SpaceHierarchy { space_id, from } => {
                self.space_hierarchy(&space_id, from).await
            }

            Command::RemoveFromSpace { space_id, room_id } => {
                // The spec delists by omitting `via`. The typed content has it
                // non-optional and would send `{"via": []}`, a valid array.
                self.room(&space_id)
                    .await?
                    .send_state_event_raw("m.space.child", room_id.as_str(), &serde_json::json!({}))
                    .await
                    .map_err(|error| self.room_error("remove_from_space", error))?;

                Ok(CommandOk::RemoveFromSpace)
            }

            Command::SpaceSidebar => Ok(CommandOk::SpaceSidebar {
                items: self.space_sidebar().await?,
            }),

            Command::SetSpaceSidebar { items } => {
                self.set_space_sidebar(&items).await?;

                Ok(CommandOk::SetSpaceSidebar)
            }

            Command::RoomPreview { address, via } => self.room_preview(&address, &via).await,

            Command::JoinRoom { address, via } => {
                let address =
                    RoomOrAliasId::parse(&address).map_err(|_| CommandErr::UnknownRoom)?;

                let via = via
                    .iter()
                    .filter_map(|server| ServerName::parse(server).ok())
                    .collect::<Vec<_>>();

                let room = self
                    .client()
                    .await?
                    .join_room_by_id_or_alias(&address, &via)
                    .await
                    .map_err(|error| self.room_error("join_room", error))?;

                Ok(CommandOk::JoinRoom {
                    room_id: room.room_id().to_owned(),
                })
            }

            Command::KnockRoom {
                address,
                via,
                reason,
            } => self.knock_room(&address, &via, reason).await,

            Command::RoomViaServers { room_id } => {
                let room = self.room(&room_id).await?;

                Ok(CommandOk::RoomViaServers {
                    servers: self.room_via_servers(&room).await?,
                })
            }

            Command::LeaveRoom { room_id } => {
                self.room(&room_id)
                    .await?
                    .leave()
                    .await
                    .map_err(|error| self.room_error("leave_room", error))?;

                // Keeping it would hand a stale timeline back on rejoin.
                self.timelines.lock().await.remove(&room_id);

                Ok(CommandOk::LeaveRoom)
            }

            Command::InviteUser { room_id, user_id } => {
                self.room(&room_id)
                    .await?
                    .invite_user_by_id(&user_id)
                    .await
                    .map_err(|error| self.room_error("invite_user", error))?;

                Ok(CommandOk::InviteUser)
            }

            Command::MarkRead {
                room_id,
                event_id,
                private_receipt,
                thread_root,
                subscription,
            } => {
                let receipt_type = if private_receipt {
                    matrix_sdk::ruma::api::client::receipt::create_receipt::v3::ReceiptType::ReadPrivate
                } else {
                    matrix_sdk::ruma::api::client::receipt::create_receipt::v3::ReceiptType::Read
                };

                let Some(event_id) = event_id else {
                    let room = self.room(&room_id).await?;
                    let timeline = room
                        .timeline_builder()
                        .with_focus(TimelineFocus::Live {
                            hide_threaded_events: false,
                        })
                        .build()
                        .await
                        .or_failed(self, "build_mark_read_timeline")?;
                    timeline
                        .mark_as_read(receipt_type.clone())
                        .await
                        .or_failed(self, "mark_read")?;
                    let main = room
                        .timeline_builder()
                        .with_focus(TimelineFocus::Live {
                            hide_threaded_events: true,
                        })
                        .build()
                        .await
                        .or_failed(self, "build_mark_read_timeline")?;
                    main.mark_as_read(receipt_type)
                        .await
                        .or_failed(self, "mark_read")?;
                    timeline
                        .mark_as_read(
                            matrix_sdk::ruma::api::client::receipt::create_receipt::v3::ReceiptType::FullyRead,
                        )
                        .await
                        .or_failed(self, "mark_read")?;
                    return Ok(CommandOk::MarkRead);
                };

                let timeline = if let Some(subscription) = subscription {
                    let timeline = self
                        .subscriptions
                        .lock()
                        .await
                        .get(&subscription)
                        .filter(|subscription| subscription.thread_root == thread_root)
                        .and_then(|subscription| subscription.timeline.clone())
                        .ok_or(CommandErr::UnknownSubscription)?;
                    if timeline.room().room_id() != room_id {
                        return Err(CommandErr::UnknownSubscription);
                    }
                    timeline
                } else {
                    self.timeline_for(&room_id, thread_root.as_ref()).await?
                };
                timeline
                    .send_single_receipt(receipt_type, event_id.clone())
                    .await
                    .or_failed(self, "mark_read")?;
                if thread_root.is_none() {
                    timeline
                        .send_multiple_receipts(Receipts::new().fully_read_marker(event_id))
                        .await
                        .or_failed(self, "mark_read")?;
                }
                Ok(CommandOk::MarkRead)
            }

            Command::MarkUnread {
                room_id,
                read_marker,
            } => {
                let room = self.room(&room_id).await?;

                if let Some(event_id) = read_marker {
                    room.send_multiple_receipts(Receipts::new().fully_read_marker(event_id))
                        .await
                        .map_err(|error| self.room_error("mark_unread_marker", error))?;
                }

                room.set_unread_flag(true)
                    .await
                    .map_err(|error| self.room_error("mark_unread", error))?;

                Ok(CommandOk::MarkUnread)
            }

            Command::RetrySend {
                room_id,
                transaction_id,
                thread_root,
            } => {
                self.client().await?.send_queue().set_enabled(true).await;

                self.local_echo(&room_id, &transaction_id, thread_root.as_ref())
                    .await?
                    .unwedge()
                    .await
                    .or_failed(self, "retry_send")?;

                Ok(CommandOk::RetrySend)
            }

            Command::RetryDecryption {
                room_id,
                session_id,
                sender,
                thread_root,
            } => {
                let timeline = self.timeline_for(&room_id, thread_root.as_ref()).await?;
                if let Err(error) = self
                    .client()
                    .await?
                    .encryption()
                    .request_user_identity(&sender)
                    .await
                {
                    tracing::warn!(%error, %sender, "refreshing sender identity before decryption retry failed");
                }
                timeline.retry_decryption([session_id]).await;
                Ok(CommandOk::RetryDecryption)
            }

            Command::CancelSend {
                room_id,
                transaction_id,
                thread_root,
            } => {
                let cancelled = self
                    .local_echo(&room_id, &transaction_id, thread_root.as_ref())
                    .await?
                    .abort()
                    .await
                    .or_failed(self, "cancel_send")?;

                self.client().await?.send_queue().set_enabled(true).await;

                Ok(CommandOk::CancelSend { cancelled })
            }
        }
    }
}

pub(crate) const BUNDLED_LINK_PREVIEWS: &str = "com.beeper.linkpreviews";
const IMAGE_SOURCE_PACKS: &str = "com.beeper.msc4459.image_source_packs";

fn extra_content<const N: usize>(
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

fn empty_mentions_extra() -> Option<serde_json::Map<String, serde_json::Value>> {
    extra_content(None, [("m.mentions", Some(serde_json::json!({})))])
}

fn ensure_empty_mentions(content: &mut serde_json::Value) {
    if let Some(object) = content.as_object_mut() {
        object
            .entry("m.mentions")
            .or_insert_with(|| serde_json::json!({}));
    }
}

const REACTION_SHORTCODE: &str = "shortcode";
const MAX_REACTION_SHORTCODE_BYTES: usize = 100;

fn reaction_shortcode(key: &str, shortcode: Option<&str>) -> Option<serde_json::Value> {
    if !key.starts_with("mxc://") {
        return None;
    }
    let name = shortcode?.trim().trim_matches(':');
    if name.is_empty() {
        return None;
    }
    let budget = MAX_REACTION_SHORTCODE_BYTES - 2;
    let end = name
        .char_indices()
        .map(|(start, character)| start + character.len_utf8())
        .take_while(|end| *end <= budget)
        .last()?;
    name.get(..end)
        .map(|name| serde_json::json!(format!(":{name}:")))
}

fn image_source_pack_extra(
    url: &str,
    source: Option<ImageSourcePackView>,
) -> Option<serde_json::Value> {
    source.map(|source| serde_json::json!({ url: source }))
}

fn image_source_pack_references(
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

fn bundled_link_previews(previews: &[UrlPreviewView]) -> Option<serde_json::Value> {
    (!previews.is_empty()).then(|| {
        serde_json::Value::Array(
            previews
                .iter()
                .map(|preview| {
                    let mut bundle = serde_json::Map::new();
                    bundle.insert("matched_url".to_owned(), preview.url.clone().into());
                    bundle.insert("og:url".to_owned(), preview.url.clone().into());
                    if let Some(title) = &preview.title {
                        bundle.insert("og:title".to_owned(), title.clone().into());
                    }
                    if let Some(description) = &preview.description {
                        bundle.insert("og:description".to_owned(), description.clone().into());
                    }
                    if let Some(site_name) = &preview.site_name {
                        bundle.insert("og:site_name".to_owned(), site_name.clone().into());
                    }
                    if let Some(image) = &preview.image {
                        bundle.insert("og:image".to_owned(), image.clone().into());
                    }
                    if let Some(width) = preview.image_width {
                        bundle.insert("og:image:width".to_owned(), width.into());
                    }
                    if let Some(height) = preview.image_height {
                        bundle.insert("og:image:height".to_owned(), height.into());
                    }
                    if let Some(video) = &preview.video {
                        bundle.insert("og:video".to_owned(), video.source.clone().into());
                        if let Some(mime) = &video.mime {
                            bundle.insert("og:video:type".to_owned(), mime.clone().into());
                        }
                        if let Some(width) = video.width {
                            bundle.insert("og:video:width".to_owned(), width.into());
                        }
                        if let Some(height) = video.height {
                            bundle.insert("og:video:height".to_owned(), height.into());
                        }
                    }
                    if let Some(color) = &preview.theme_color {
                        bundle.insert(PREVIEW_THEME_COLOR.to_owned(), color.clone().into());
                    }
                    if let Some(card) = &preview.card {
                        bundle.insert(PREVIEW_CARD.to_owned(), card.clone().into());
                    }
                    if let Some(author) = &preview.author_name {
                        bundle.insert(PREVIEW_AUTHOR.to_owned(), author.clone().into());
                    }
                    serde_json::Value::Object(bundle)
                })
                .collect(),
        )
    })
}

fn sticker_info(declared: Option<PackImageInfoView>) -> ImageInfo {
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

const fn profile_propagation(view: ProfilePropagationView) -> PropagateTo {
    match view {
        ProfilePropagationView::All => PropagateTo::All,
        ProfilePropagationView::Unchanged => PropagateTo::Unchanged,
        ProfilePropagationView::None => PropagateTo::None,
    }
}

fn membership_filter(memberships: &[MembershipView]) -> RoomMemberships {
    if memberships.is_empty() {
        return RoomMemberships::JOIN;
    }

    memberships
        .iter()
        .fold(RoomMemberships::empty(), |filter, membership| {
            filter
                | match membership {
                    MembershipView::Join => RoomMemberships::JOIN,
                    MembershipView::Invite => RoomMemberships::INVITE,
                    MembershipView::Knock => RoomMemberships::KNOCK,
                    MembershipView::Leave => RoomMemberships::LEAVE,
                    MembershipView::Ban => RoomMemberships::BAN,
                }
        })
}

impl Core {
    async fn room_permissions(
        &self,
        room_id: &OwnedRoomId,
    ) -> Result<crate::protocol::RoomPermissionsView, CommandErr> {
        let room = self.room(room_id).await?;
        let user_id = room
            .client()
            .user_id()
            .ok_or_else(|| self.failed("room_permissions", "no session"))?
            .to_owned();
        // An invited room carries only stripped state, so the levels are
        // often absent. Spec defaults beat failing the whole command.
        let power_levels = room.power_levels_or_default().await;

        Ok(view::room_permissions(&power_levels, &user_id))
    }

    async fn room_state_events(
        &self,
        room_id: &OwnedRoomId,
        event_type: &str,
    ) -> Result<Vec<RoomStateEventView>, CommandErr> {
        let client = self.client().await?;
        let room = self.room(room_id).await?;
        let stored = room
            .get_state_events(event_type.into())
            .await
            .map_err(|error| self.room_error("room_state_events", error))?;

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

        let events = room_state_events_from_server(&client, &room, event_type)
            .await
            .map_err(|error| self.room_error("room_state_events", error))?;

        Ok(events)
    }

    pub(crate) async fn room_state_event_content(
        &self,
        room_id: OwnedRoomId,
        event_type: String,
        state_key: String,
    ) -> Result<Option<serde_json::Value>, CommandErr> {
        let client = self.client().await?;
        let room = self.room(&room_id).await?;
        let event = room
            .get_state_event(event_type.clone().into(), &state_key)
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

        let content = match content {
            Some(content) => Some(content),
            None => match client
                .send(get_state_event_for_key::v3::Request::new(
                    room_id,
                    event_type.into(),
                    state_key,
                ))
                .await
            {
                Ok(response) => state_event_content(response.event_or_content.get()),
                Err(error) if error.client_api_error_kind() == Some(&ErrorKind::NotFound) => None,
                Err(error) => {
                    return Err(self.room_error("room_state_event", error.into()));
                }
            },
        };

        Ok(content)
    }
}

async fn room_state_events_from_server(
    client: &matrix_sdk::Client,
    room: &matrix_sdk::Room,
    event_type: &str,
) -> Result<Vec<RoomStateEventView>, matrix_sdk::Error> {
    let response = client
        .send(get_state_events::v3::Request::new(
            room.room_id().to_owned(),
        ))
        .await?;

    Ok(response
        .room_state
        .iter()
        .filter(|raw| {
            raw.get_field::<String>("type")
                .ok()
                .flatten()
                .is_some_and(|found| found == event_type)
        })
        .filter_map(|raw| {
            Some(RoomStateEventView {
                state_key: raw.get_field::<String>("state_key").ok().flatten()?,
                content: raw
                    .get_field::<serde_json::Value>("content")
                    .ok()
                    .flatten()?,
            })
        })
        .collect())
}

#[cfg(test)]
mod tests {
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

    use super::{empty_mentions_extra, ensure_empty_mentions, state_event_content};
    use matrix_sdk::room::edit::EditedContent;
    use matrix_sdk::ruma::RoomId;
    use matrix_sdk::ruma::events::room::message::AddMentions;

    use crate::messages::edit_content;
    use crate::outgoing::{
        gif_content, location_content, message_content, reply_relation_fallback, thread_reply,
    };
    use crate::protocol::{CreateJoinRuleView, MessageKind};

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
            Some(super::Relation::Reply(super::Reply { in_reply_to, .. }))
                if in_reply_to.event_id == event_id
        ));
    }

    #[test]
    fn a_preview_with_nothing_to_show_is_no_preview() {
        let empty = serde_json::json!({ "og:title": "   ", "og:image": "https://cdn/x.png" });
        assert!(super::url_preview("https://e".to_owned(), &empty).is_none());
        assert!(super::url_preview("https://e".to_owned(), &serde_json::json!({})).is_none());
    }

    #[test]
    fn a_video_alone_is_a_preview() {
        let data = serde_json::json!({
            "og:video": "mxc://s/clip",
            "og:video:type": "video/mp4",
            "og:video:width": 1280,
            "og:video:height": 720,
        });
        let preview = super::url_preview("https://e".to_owned(), &data).expect("a preview");
        let video = preview.video.expect("a video");
        assert_eq!(video.source, "mxc://s/clip");
        assert_eq!(video.mime.as_deref(), Some("video/mp4"));
        assert_eq!((video.width, video.height), (Some(1280), Some(720)));

        let remote = serde_json::json!({ "og:video": "https://cdn.example/clip.mp4" });
        assert!(super::url_preview("https://e".to_owned(), &remote).is_none());
    }

    #[test]
    fn presentation_hints_are_validated() {
        let data = serde_json::json!({
            "og:title": "Title",
            "com.sable.theme_color": "#ff4500",
            "com.sable.card": "summary_large_image",
            "com.sable.author_name": "someone",
        });
        let preview = super::url_preview("https://e".to_owned(), &data).expect("a preview");
        assert_eq!(preview.theme_color.as_deref(), Some("#ff4500"));
        assert_eq!(preview.card.as_deref(), Some("summary_large_image"));
        assert_eq!(preview.author_name.as_deref(), Some("someone"));

        let data = serde_json::json!({
            "og:title": "Title",
            "com.sable.theme_color": "red; background:url(x)",
            "com.sable.card": "player",
        });
        let preview = super::url_preview("https://e".to_owned(), &data).expect("a preview");
        assert_eq!(preview.theme_color, None);
        assert_eq!(preview.card, None);
    }

    #[test]
    fn a_preview_keeps_only_an_mxc_image() {
        let data = serde_json::json!({
            "og:title": "Title",
            "og:image": "https://cdn.example/x.png",
        });
        let preview = super::url_preview("https://e".to_owned(), &data).expect("a preview");
        assert_eq!(preview.image, None);

        let data = serde_json::json!({
            "og:title": "Title",
            "og:image": "mxc://example.org/1",
            "og:image:width": 640,
        });
        let preview = super::url_preview("https://e".to_owned(), &data).expect("a preview");
        assert_eq!(preview.image.as_deref(), Some("mxc://example.org/1"));
        assert_eq!(preview.image_width, Some(640));
    }

    #[test]
    fn a_restricted_room_without_a_space_falls_back_to_invite() {
        let rule = |kind, space: Option<&str>| {
            super::join_rule_content(
                Some(kind),
                space.map(|id| <&RoomId>::try_from(id).expect("a room id")),
            )
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

    use crate::view;
    use matrix_sdk::ruma::owned_user_id;

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
            empty_mentions_extra().unwrap()["m.mentions"],
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
