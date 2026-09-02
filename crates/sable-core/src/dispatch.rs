use std::sync::{Arc, atomic::Ordering};

use futures_util::{StreamExt, pin_mut};
use matrix_sdk::RoomMemberships;
use matrix_sdk::deserialized_responses::RawAnySyncOrStrippedState;
use matrix_sdk::room::ListThreadsOptions;
use matrix_sdk::room::edit::EditedContent;
use matrix_sdk::room::reply::{EnforceThread, Reply as SdkReply};
use matrix_sdk::room::{ParentSpace, Receipts};
use matrix_sdk::ruma::RoomAliasId;
use matrix_sdk::ruma::api::Direction;
use matrix_sdk::ruma::api::client::alias::{create_alias, delete_alias};
use matrix_sdk::ruma::api::client::authenticated_media::get_media_preview;
use matrix_sdk::ruma::api::client::directory::{get_room_visibility, set_room_visibility};
use matrix_sdk::ruma::api::client::discovery::get_capabilities;
use matrix_sdk::ruma::api::client::presence::set_presence;
use matrix_sdk::ruma::api::client::room::Visibility;
use matrix_sdk::ruma::api::client::room::aliases;
use matrix_sdk::ruma::api::client::room::create_room::{self, v3::RoomPreset};
use matrix_sdk::ruma::api::client::room::get_event_by_timestamp;
use matrix_sdk::ruma::api::client::room::upgrade_room;
use matrix_sdk::ruma::api::client::state::{get_state_event_for_key, get_state_events};
use matrix_sdk::ruma::api::client::uiaa::{AuthData, AuthType, Password, UserIdentifier};
use matrix_sdk::ruma::api::error::ErrorKind;
use matrix_sdk::ruma::api::federation::discovery::get_server_version;
use matrix_sdk::ruma::events::InitialStateEvent;
use matrix_sdk::ruma::events::relation::{InReplyTo, Reply, Thread};
use matrix_sdk::ruma::events::room::ImageInfo;
use matrix_sdk::ruma::events::room::avatar::RoomAvatarEventContent;
use matrix_sdk::ruma::events::room::create::RoomCreateEventContent;
use matrix_sdk::ruma::events::room::encryption::RoomEncryptionEventContent;
use matrix_sdk::ruma::events::room::join_rules::{AllowRule, JoinRule, RoomJoinRulesEventContent};
use matrix_sdk::ruma::events::room::message::{
    AddMentions, ImageMessageEventContent, MessageType, Relation, ReplyWithinThread,
};
use matrix_sdk::ruma::events::sticker::StickerEventContent;
use matrix_sdk::ruma::events::tag::{TagInfo, TagName};
use matrix_sdk::ruma::events::{AnySyncMessageLikeEvent, AnySyncTimelineEvent};
use matrix_sdk::ruma::presence::PresenceState;
use matrix_sdk::ruma::profile::{ProfileFieldName, ProfileFieldValue};
use matrix_sdk::ruma::room::RoomType;
use matrix_sdk::ruma::serde::Raw;
use matrix_sdk::ruma::{
    MilliSecondsSinceUnixEpoch, OwnedMxcUri, OwnedUserId, RoomId, RoomOrAliasId, ServerName, UInt,
    events::Mentions, events::room::MediaSource, events::room::member::MembershipState,
    events::room::message::RoomMessageEventContent,
};
use matrix_sdk::ruma::{
    RoomVersionId, api::client::discovery::get_capabilities::v3::RoomVersionStability,
};
use matrix_sdk_ui::timeline::TimelineEventItemId;

use crate::protocol::{
    Command, CommandErr, CommandOk, CreateJoinRuleView, CreateRoomKind, HomeserverSoftwareView,
    JoinRuleView, MembershipView, MessageKind, MutualRoomView, PackImageInfoView,
    PaginationDirection, PresenceView, RoomStateEventView, RoomTag, RoomVersionView,
    RoomVersionsView, ThreadRootView, UrlPreviewView,
};
use matrix_sdk_ui::notification_client::NotificationProcessSetup;

use crate::media::mxc_uri;
use crate::profiles::profile_view;
use crate::rooms::join_rule_support;
use crate::verification::encryption_status;
use crate::{Core, SubscriptionKind};
use crate::{notifications, session, spaces, view};

const MAX_SEARCH_RESULTS: usize = 200;

fn thread_root(raw: &Raw<AnySyncTimelineEvent>) -> Option<ThreadRootView> {
    let event = raw.deserialize().ok()?;
    let AnySyncTimelineEvent::MessageLike(AnySyncMessageLikeEvent::RoomMessage(message)) = event
    else {
        return None;
    };
    let original = message.as_original()?;

    Some(ThreadRootView {
        event_id: original.event_id.clone(),
        sender: original.sender.clone(),
        body: original.content.body().to_owned(),
        timestamp: Some(u64::from(original.origin_server_ts.0)),
    })
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
        image_width: number("og:image:width"),
        image_height: number("og:image:height"),
    };

    if preview.title.is_none() && preview.description.is_none() && preview.image.is_none() {
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
                homeserver,
                username,
                password,
            } => self.login(homeserver, username, password).await,

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

            Command::StartOidcLogin {
                homeserver,
                redirect_uri,
                intent,
            } => {
                self.start_oidc_login(homeserver, redirect_uri, intent)
                    .await
            }

            Command::CompleteOidcLogin { callback_url } => {
                self.complete_oidc_login(callback_url).await
            }

            Command::StartSsoLogin {
                homeserver,
                redirect_uri,
                idp_id,
                intent,
            } => {
                self.start_sso_login(homeserver, redirect_uri, idp_id, intent)
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
                let _update = self.room_subscription_lock.lock().await;
                let Some(removed) = self.subscriptions.lock().await.remove(&subscription) else {
                    return Err(CommandErr::UnknownSubscription);
                };
                let live_room = match &removed.kind {
                    SubscriptionKind::LiveTimeline(room_id) => Some(room_id.clone()),
                    SubscriptionKind::Other | SubscriptionKind::FocusedTimeline => None,
                };
                drop(removed);

                if let Some(room_id) = live_room {
                    self.sync_timeline_rooms_locked(None).await?;

                    let subscriptions = self.subscriptions.lock().await;
                    let watched = subscriptions.values().any(|subscription| {
                        matches!(
                            &subscription.kind,
                            SubscriptionKind::LiveTimeline(id) if *id == room_id
                        )
                    });
                    drop(subscriptions);
                    if !watched {
                        self.timelines.lock().await.remove(&room_id);
                    }
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
                                matches!(subscription.kind, SubscriptionKind::FocusedTimeline),
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
                .map_err(|error| self.failed("paginate", error))?;

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
                persona,
            } => {
                let timeline = self.timeline_for(&room_id, thread_root.as_ref()).await?;
                let content = message_content(body, formatted, kind, mentions, mentions_room);

                if let Some(persona) = persona {
                    let room = self.room(&room_id).await?;
                    let reply = thread_reply(in_reply_to, thread_root.clone());
                    let content = match reply {
                        Some(reply) => room
                            .make_reply_event(content.into(), reply)
                            .await
                            .map_err(|error| self.failed("send_reply", error))?,
                        None => content,
                    };

                    self.send_with_persona(&room, &content.into(), &persona)
                        .await?;
                    return Ok(CommandOk::SendMessage);
                }

                match in_reply_to {
                    // `send_reply` fills the thread relation itself.
                    Some(event_id) => {
                        timeline
                            .send_reply(content.into(), event_id)
                            .await
                            .map_err(|error| self.failed("send_reply", error))?;
                    }
                    None => {
                        timeline
                            .send(content.into())
                            .await
                            .map_err(|error| self.failed("send_message", error))?;
                    }
                }

                Ok(CommandOk::SendMessage)
            }

            Command::SendRawEvent {
                room_id,
                event_type,
                content,
            } => {
                self.room(&room_id)
                    .await?
                    .send_raw(&event_type, content)
                    .await
                    .map_err(|error| self.failed("send_raw_event", error))?;

                Ok(CommandOk::SendRawEvent)
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

            Command::SetPersonaSelection {
                room_id,
                persona_id,
                valid_until,
            } => {
                self.set_persona_selection(room_id, persona_id, valid_until)
                    .await?;
                Ok(CommandOk::SetPersonaSelection)
            }

            Command::SendSticker {
                room_id,
                url,
                body,
                info,
                in_reply_to,
                thread_root,
            } => {
                let url = OwnedMxcUri::from(url);
                if url.parts().is_err() {
                    return Err(CommandErr::InvalidMedia);
                }

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

                timeline
                    .send(content.into())
                    .await
                    .map_err(|error| self.failed("send_sticker", error))?;

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
                thread_root,
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
                let content = RoomMessageEventContent::new(MessageType::Image(
                    ImageMessageEventContent::plain(body, url).info(Box::new(info)),
                ));

                match in_reply_to {
                    Some(event_id) => {
                        timeline
                            .send_reply(content.into(), event_id)
                            .await
                            .map_err(|error| self.failed("send_gif_reply", error))?;
                    }
                    None => {
                        timeline
                            .send(content.into())
                            .await
                            .map_err(|error| self.failed("send_gif", error))?;
                    }
                }

                Ok(CommandOk::SendGif)
            }

            Command::EditMessage {
                room_id,
                event_id,
                body,
                formatted,
                kind,
                image,
                thread_root,
                mentions,
                mentions_room,
                persona,
            } => {
                let edited = EditedContent::RoomMessage(
                    edit_content(body, formatted, kind, image, mentions, mentions_room)?.into(),
                );

                if let Some(persona) = persona {
                    let room = self.room(&room_id).await?;
                    let content = room
                        .make_edit_event(&event_id, edited)
                        .await
                        .map_err(|error| self.failed("edit_message", error))?;

                    self.send_with_persona(&room, &content, &persona).await?;
                    return Ok(CommandOk::EditMessage);
                }

                self.timeline_for(&room_id, thread_root.as_ref())
                    .await?
                    .edit(&TimelineEventItemId::EventId(event_id), edited)
                    .await
                    .map_err(|error| self.failed("edit_message", error))?;

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
                    .map_err(|error| self.failed("fetch_event_details", error))?;

                Ok(CommandOk::FetchEventDetails)
            }

            Command::SearchMessages {
                query,
                filter,
                order,
                limit,
                offset,
            } => {
                let hits = self
                    .search_messages(
                        &query,
                        &filter,
                        order,
                        (limit as usize).min(MAX_SEARCH_RESULTS),
                        offset as usize,
                    )
                    .await;

                Ok(CommandOk::SearchMessages {
                    hits: hits.into_iter().map(view::search_hit_view).collect(),
                })
            }

            Command::JoinCall {
                room_id,
                livekit_service_url,
            } => self.join_call(room_id, livekit_service_url).await,

            Command::CallSupport { room_id } => self.call_support(room_id).await,

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
                    .map_err(|error| self.failed("room_members", error))?;

                Ok(CommandOk::RoomMembers {
                    members: members.iter().map(view::member_view).collect(),
                })
            }

            Command::RoomPermissions { room_id } => {
                let room = self.room(&room_id).await?;
                let user_id = room
                    .client()
                    .user_id()
                    .ok_or_else(|| self.failed("room_permissions", "no session"))?
                    .to_owned();
                // An invited room carries only stripped state, so the levels are
                // often absent. Spec defaults beat failing the whole command.
                let power_levels = room.power_levels_or_default().await;

                Ok(CommandOk::RoomPermissions(view::room_permissions(
                    &power_levels,
                    &user_id,
                )))
            }

            Command::ImagePacks { room_id } => self.image_packs(room_id).await,
            Command::AllImagePacks => self.all_image_packs().await,

            Command::UserProfile { user_id } => {
                let response = self
                    .client()
                    .await?
                    .account()
                    .fetch_user_profile_of(&user_id)
                    .await
                    .map_err(|error| self.failed("user_profile", error))?;

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
                    .map_err(|error| self.failed("room_versions", error))?;

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
                    RoomVersionId::try_from(new_version)
                        .map_err(|error| self.failed("upgrade_room", error))?,
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
                let alias = RoomAliasId::parse(alias)
                    .map_err(|error| self.failed("create_room_alias", error))?;

                self.client()
                    .await?
                    .send(create_alias::v3::Request::new(alias, room_id))
                    .await
                    .map_err(|error| self.room_error("create_room_alias", error.into()))?;

                Ok(CommandOk::CreateRoomAlias)
            }

            Command::DeleteRoomAlias { alias } => {
                let alias = RoomAliasId::parse(alias)
                    .map_err(|error| self.failed("delete_room_alias", error))?;

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
            } => self.public_rooms(server, search, since).await,

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

            Command::NotificationKeywords => {
                let keywords = notifications::keywords(&self.client().await?)
                    .await
                    .map_err(|error| self.failed("notification_keywords", error))?;

                Ok(CommandOk::NotificationKeywords { keywords })
            }

            Command::AddNotificationKeyword { keyword } => {
                notifications::add_keyword(&self.client().await?, keyword)
                    .await
                    .map_err(|error| self.failed("add_notification_keyword", error))?;

                Ok(CommandOk::AddNotificationKeyword)
            }

            Command::RemoveNotificationKeyword { keyword } => {
                notifications::remove_keyword(&self.client().await?, keyword)
                    .await
                    .map_err(|error| self.failed("remove_notification_keyword", error))?;

                Ok(CommandOk::RemoveNotificationKeyword)
            }

            Command::ListThreads { room_id, from } => {
                let client = self.client().await?;
                let room = client.get_room(&room_id).ok_or(CommandErr::UnknownRoom)?;
                let options = ListThreadsOptions {
                    from,
                    ..ListThreadsOptions::default()
                };
                let threads = room
                    .list_threads(options)
                    .await
                    .map_err(|error| self.room_error("list_threads", error))?;

                let roots = threads
                    .chunk
                    .iter()
                    .filter_map(|event| thread_root(event.raw()))
                    .collect();

                Ok(CommandOk::ListThreads {
                    roots,
                    next_batch: threads.prev_batch_token,
                })
            }

            Command::UrlPreview { url } => {
                let response = self
                    .client()
                    .await?
                    .send(get_media_preview::v1::Request::new(url.clone()))
                    .await
                    .map_err(|error| self.homeserver_http_error("url_preview", error))?;

                let preview = response
                    .data
                    .and_then(|raw| serde_json::from_str::<serde_json::Value>(raw.get()).ok())
                    .and_then(|data| url_preview(url, &data));

                Ok(CommandOk::UrlPreview { preview })
            }

            Command::RoomStateEvents {
                room_id,
                event_type,
            } => {
                let client = self.client().await?;
                let room = client.get_room(&room_id).ok_or(CommandErr::UnknownRoom)?;
                let stored = room
                    .get_state_events(event_type.as_str().into())
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
                    return Ok(CommandOk::RoomStateEvents { events });
                }

                let events = room_state_events_from_server(&client, &room, &event_type)
                    .await
                    .map_err(|error| self.room_error("room_state_events", error))?;

                Ok(CommandOk::RoomStateEvents { events })
            }

            Command::RoomStateEvent {
                room_id,
                event_type,
                state_key,
            } => {
                let client = self.client().await?;
                let room = client.get_room(&room_id).ok_or(CommandErr::UnknownRoom)?;
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
                        Err(error)
                            if error.client_api_error_kind() == Some(&ErrorKind::NotFound) =>
                        {
                            None
                        }
                        Err(error) => {
                            return Err(self.room_error("room_state_event", error.into()));
                        }
                    },
                };

                Ok(CommandOk::RoomStateEvent { content })
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

            Command::AccountDataTypes => Ok(CommandOk::AccountDataTypes {
                event_types: self.account_data_types().await?,
            }),

            Command::AccessToken => Ok(CommandOk::AccessToken {
                token: self.client().await?.access_token(),
            }),

            Command::AccountData { event_type } => {
                self.remember_account_data_type(event_type.as_str()).await;
                let event = self
                    .client()
                    .await?
                    .account()
                    .fetch_account_data(event_type.into())
                    .await
                    .map_err(|error| self.failed("account_data", error))?;
                let content = event.and_then(|raw| raw.deserialize_as::<serde_json::Value>().ok());
                Ok(CommandOk::AccountData { content })
            }

            Command::SetAccountData {
                event_type,
                content,
            } => {
                self.remember_account_data_type(event_type.as_str()).await;
                let raw = Raw::new(&content)
                    .map_err(|error| self.failed("set_account_data", error))?
                    .cast_unchecked();
                self.client()
                    .await?
                    .account()
                    .set_account_data_raw(event_type.into(), raw)
                    .await
                    .map_err(|error| self.failed("set_account_data", error))?;

                Ok(CommandOk::SetAccountData)
            }

            Command::SetRoomAccountData {
                room_id,
                event_type,
                content,
            } => {
                let raw = Raw::new(&content)
                    .map_err(|error| self.failed("set_room_account_data", error))?
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

            Command::EventSource { room_id, event_id } => Ok(CommandOk::EventSource {
                source: self.event_source(&room_id, &event_id).await?,
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
                self.timeline_for(&room_id, thread_root.as_ref())
                    .await?
                    .redact(&TimelineEventItemId::EventId(event_id), reason.as_deref())
                    .await
                    .map_err(|error| self.failed("redact", error))?;

                Ok(CommandOk::Redact)
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
                thread_root,
            } => {
                self.timeline_for(&room_id, thread_root.as_ref())
                    .await?
                    .toggle_reaction(&TimelineEventItemId::EventId(event_id), &key)
                    .await
                    .map_err(|error| self.failed("react", error))?;

                Ok(CommandOk::React)
            }

            Command::RoomTimelineEvents {
                room_id,
                event_type,
                msgtype,
                limit,
                since,
            } => Ok(CommandOk::RoomTimelineEvents {
                events: self
                    .room_timeline_events(
                        &room_id,
                        &event_type,
                        msgtype.as_deref(),
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
            Command::SearchUserDirectory { term, limit } => {
                let (limited, results) = self.search_user_directory(&term, limit).await?;
                Ok(CommandOk::SearchUserDirectory { limited, results })
            }
            Command::OpenIdToken => Ok(CommandOk::OpenIdToken {
                token: self.openid_token().await?,
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
            Command::DelayedEventsSupported => Ok(CommandOk::DelayedEventsSupported {
                supported: self.delayed_events_supported().await?,
            }),
            Command::SendLocation {
                room_id,
                body,
                geo_uri,
                in_reply_to,
                thread_root,
            } => {
                if view::geo_coordinates(&geo_uri).is_none() {
                    return Err(CommandErr::InvalidLocation);
                }

                self.timeline_for(&room_id, thread_root.as_ref())
                    .await?
                    .send_location(body, geo_uri, None, None, None, in_reply_to)
                    .await
                    .map_err(|error| self.failed("send_location", error))?;

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
                    .send(content.into())
                    .await
                    .map_err(|error| self.failed("create poll", error))?;

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
                    .send(content.into())
                    .await
                    .map_err(|error| self.failed("vote poll", error))?;

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
                    .send(content.into())
                    .await
                    .map_err(|error| self.failed("end poll", error))?;

                Ok(CommandOk::EndPoll)
            }

            Command::EncryptionStatus => Ok(CommandOk::EncryptionStatus {
                status: encryption_status(&self.client().await?).await,
            }),

            Command::SyncStatus => Ok(CommandOk::SyncStatus {
                status: crate::watchers::sync_status(self.sync_service().await?.state().get()),
            }),

            Command::SearchCoverage => Ok(CommandOk::SearchCoverage {
                coverage: self.search_coverage(&self.client().await?).await,
            }),

            Command::Devices => {
                let client = self.client().await?;
                let account_management = client.oauth().full_session().is_some()
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
                })
            }

            Command::RecoverIdentity { recovery_key } => {
                self.client()
                    .await?
                    .encryption()
                    .recovery()
                    .recover(&recovery_key)
                    .await
                    .map_err(|error| self.recovery_error(error))?;

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
                .map_err(|error| self.failed("enable_recovery", error))?;

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
                .map_err(|error| self.failed("reset_recovery_key", error))?;

                Ok(CommandOk::ResetRecoveryKey { recovery_key })
            }

            Command::DeleteDevice {
                device_id,
                password,
            } => {
                let client = self.client().await?;
                let devices = [device_id];

                if client.oauth().full_session().is_some()
                && let Ok(metadata) = client.oauth().server_metadata().await
                && let Some(url) = metadata.account_management_url_with_action(
                    matrix_sdk::ruma::api::client::discovery::get_authorization_server_metadata::v1::AccountManagementActionData::DeviceDelete(
                        matrix_sdk::ruma::api::client::discovery::get_authorization_server_metadata::v1::DeviceDeleteData::new(devices[0].as_ref()),
                    ),
                )
            {
                return Ok(CommandOk::DeleteDevice {
                    management_url: Some(url.to_string()),
                });
            }

                // The flows cannot be asked for up front.
                let Err(error) = client.delete_devices(&devices, None).await else {
                    return Ok(CommandOk::DeleteDevice {
                        management_url: None,
                    });
                };

                let Some(uiaa) = error.as_uiaa_response() else {
                    return Err(self.failed("delete_device", error));
                };

                // Recaptcha, SSO and terms need the server's fallback page.
                let password_only = uiaa
                    .flows
                    .iter()
                    .any(|flow| flow.stages == [AuthType::Password]);

                let password = match password {
                    Some(password) if password_only => password,
                    _ => {
                        return Err(CommandErr::InteractiveAuthRequired {
                            stages: uiaa
                                .flows
                                .iter()
                                .flat_map(|flow| &flow.stages)
                                .map(|stage| stage.as_str().to_owned())
                                .collect(),
                        });
                    }
                };

                let user_id = client.user_id().ok_or(CommandErr::NotLoggedIn)?.to_owned();
                let mut auth = Password::new(UserIdentifier::Matrix(user_id.into()), password);
                // Without the session id this starts a new flow.
                auth.session.clone_from(&uiaa.session);

                client
                    .delete_devices(&devices, Some(AuthData::Password(auth)))
                    .await
                    .map_err(|error| match error.as_uiaa_response() {
                        // A wrong password comes back as another challenge.
                        Some(_) => CommandErr::Denied,
                        None => self.failed("delete_device: auth", error),
                    })?;

                Ok(CommandOk::DeleteDevice {
                    management_url: None,
                })
            }

            Command::RenameDevice {
                device_id,
                display_name,
            } => {
                self.client()
                    .await?
                    .rename_device(&device_id, &display_name)
                    .await
                    .map_err(|error| self.failed("rename_device", error))?;

                Ok(CommandOk::RenameDevice)
            }

            Command::SetDisplayName { name } => {
                self.client()
                    .await?
                    .account()
                    .set_display_name(name.as_deref())
                    .await
                    .map_err(|error| self.failed("set_display_name", error))?;

                Ok(CommandOk::SetDisplayName)
            }

            Command::SetAvatarUrl { url } => {
                let url = match url {
                    Some(url) => Some(mxc_uri(&url)?),
                    None => None,
                };

                self.client()
                    .await?
                    .account()
                    .set_avatar_url(url.as_deref())
                    .await
                    .map_err(|error| self.failed("set_avatar_url", error))?;

                Ok(CommandOk::SetAvatarUrl)
            }

            Command::SetProfileField { field, value } => {
                let account = self.client().await?.account();
                match value {
                    Some(value) => {
                        let value = ProfileFieldValue::new(&field, value).map_err(|error| {
                            self.failed("set_profile_field: invalid value", error)
                        })?;
                        account
                            .set_profile_field(value)
                            .await
                            .map_err(|error| self.failed("set_profile_field", error))?;
                    }
                    None => {
                        account
                            .delete_profile_field(ProfileFieldName::from(field.as_str()))
                            .await
                            .map_err(|error| self.failed("delete_profile_field", error))?;
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
                    .map_err(|error| self.failed("account_contacts", error))?
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

            Command::IgnoreUser { user_id } => {
                self.client()
                    .await?
                    .account()
                    .ignore_user(&user_id)
                    .await
                    .map_err(|error| self.failed("ignore_user", error))?;

                Ok(CommandOk::IgnoreUser)
            }

            Command::UnignoreUser { user_id } => {
                self.client()
                    .await?
                    .account()
                    .unignore_user(&user_id)
                    .await
                    .map_err(|error| self.failed("unignore_user", error))?;

                Ok(CommandOk::UnignoreUser)
            }

            Command::SetTyping { room_id, typing } => {
                self.room(&room_id)
                    .await?
                    .typing_notice(typing)
                    .await
                    .map_err(|error| self.failed("set_typing", error))?;

                Ok(CommandOk::SetTyping)
            }

            Command::NotificationSettings { room_id } => {
                let room = self.room(&room_id).await?;

                Ok(CommandOk::NotificationSettings(
                    notifications::settings(&room).await,
                ))
            }

            Command::DefaultNotificationModes => {
                let (direct, group) = notifications::default_modes(&self.client().await?).await;

                Ok(CommandOk::DefaultNotificationModes { direct, group })
            }

            Command::SetPusher { pusher } => {
                notifications::set_pusher(&self.client().await?, pusher)
                    .await
                    .map_err(|error| self.failed("set_pusher", error))?;

                Ok(CommandOk::SetPusher)
            }

            Command::RemovePusher { pushkey, app_id } => {
                notifications::remove_pusher(&self.client().await?, pushkey, app_id)
                    .await
                    .map_err(|error| self.failed("remove_pusher", error))?;

                Ok(CommandOk::RemovePusher)
            }

            Command::SetNotificationContent { visible, encrypted } => {
                self.notification_content.store(visible, Ordering::Relaxed);
                self.notification_encrypted_content
                    .store(encrypted, Ordering::Relaxed);

                Ok(CommandOk::SetNotificationContent)
            }

            Command::SetPresence {
                presence,
                status_message,
            } => {
                let client = self.client().await?;
                let user_id = client.user_id().ok_or(CommandErr::NotLoggedIn)?.to_owned();
                let mut request = set_presence::v3::Request::new(
                    user_id,
                    match presence {
                        PresenceView::Online => PresenceState::Online,
                        PresenceView::Offline => PresenceState::Offline,
                        PresenceView::Unavailable => PresenceState::Unavailable,
                    },
                );
                request.status_msg = status_message;
                client
                    .send(request)
                    .await
                    .map_err(|error| self.failed("set_presence", error))?;

                Ok(CommandOk::SetPresence)
            }

            Command::SetRoomNotificationMode { room_id, mode } => {
                let room = self.room(&room_id).await?;
                notifications::set_room_mode(&room, mode)
                    .await
                    .map_err(|error| self.failed("set_room_notification_mode", error))?;

                Ok(CommandOk::SetRoomNotificationMode)
            }

            Command::SetDefaultNotificationMode { direct, mode } => {
                notifications::set_default_mode(&self.client().await?, direct, mode)
                    .await
                    .map_err(|error| self.failed("set_default_notification_mode", error))?;

                Ok(CommandOk::SetDefaultNotificationMode)
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

            Command::SetRoomTag { room_id, tag, set } => {
                let room = self.room(&room_id).await?;
                let name = match tag {
                    RoomTag::Favourite => TagName::Favorite,
                    RoomTag::LowPriority => TagName::LowPriority,
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

            Command::SetDirect { room_id, direct } => {
                let client = self.client().await?;
                let room = self.room(&room_id).await?;

                if direct {
                    // `m.direct` is keyed by the other user, not by the room.
                    let members = room
                        .members(RoomMemberships::ACTIVE)
                        .await
                        .map_err(|error| self.failed("set_direct: members", error))?;

                    let others: Vec<OwnedUserId> = members
                        .iter()
                        .map(|member| member.user_id().to_owned())
                        .filter(|user_id| Some(user_id.as_ref()) != client.user_id())
                        .collect();

                    client
                        .account()
                        .mark_as_dm(&room_id, &others)
                        .await
                        .map_err(|error| self.failed("set_direct", error))?;
                } else {
                    room.set_is_direct(false)
                        .await
                        .map_err(|error| self.failed("unset_direct", error))?;
                }

                Ok(CommandOk::SetDirect)
            }

            Command::SetRoomJoinRule { room_id, rule } => {
                let room = self.room(&room_id).await?;
                let (supports_knock, supports_restricted, supports_knock_restricted) =
                    join_rule_support(&room).await;
                let content = match rule {
                    JoinRuleView::Public => RoomJoinRulesEventContent::new(JoinRule::Public),
                    JoinRuleView::Invite => RoomJoinRulesEventContent::new(JoinRule::Invite),
                    JoinRuleView::Knock if supports_knock => {
                        RoomJoinRulesEventContent::new(JoinRule::Knock)
                    }
                    JoinRuleView::Knock => return Err(CommandErr::Unsupported),
                    JoinRuleView::Restricted if !supports_restricted => {
                        return Err(CommandErr::Unsupported);
                    }
                    JoinRuleView::KnockRestricted if !supports_knock_restricted => {
                        return Err(CommandErr::Unsupported);
                    }
                    JoinRuleView::Restricted | JoinRuleView::KnockRestricted => {
                        let parents = room.parent_spaces().await.map_err(|error| {
                            self.room_error("set_room_join_rule: parents", error)
                        })?;
                        pin_mut!(parents);
                        let mut allow = Vec::new();

                        while let Some(parent) = parents.next().await {
                            let parent = parent.map_err(|error| {
                                self.room_error("set_room_join_rule: parent", error)
                            })?;
                            if let ParentSpace::Reciprocal(space) = parent
                                && space.is_space()
                            {
                                allow.push(AllowRule::room_membership(space.room_id().to_owned()));
                            }
                        }

                        if allow.is_empty() {
                            return Err(CommandErr::Denied);
                        }

                        if matches!(rule, JoinRuleView::Restricted) {
                            RoomJoinRulesEventContent::restricted(allow)
                        } else {
                            RoomJoinRulesEventContent::knock_restricted(allow)
                        }
                    }
                };

                room.send_state_event(content)
                    .await
                    .map_err(|error| self.room_error("set_room_join_rule", error))?;

                Ok(CommandOk::SetRoomJoinRule)
            }

            Command::SendStateEvent {
                room_id,
                event_type,
                state_key,
                content,
            } => {
                self.room(&room_id)
                    .await?
                    .send_state_event_raw(&event_type, &state_key, &content)
                    .await
                    .map_err(|error| self.room_error("send_state_event", error))?;

                Ok(CommandOk::SendStateEvent)
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
                        .map_err(|error| self.failed("request_verification: device", error))?
                        .ok_or(CommandErr::Unavailable)?
                        .request_verification()
                        .await
                        .map_err(|error| self.failed("request_verification", error))?,
                    None => encryption
                        .get_user_identity(&user_id)
                        .await
                        .map_err(|error| self.failed("request_verification: identity", error))?
                        .ok_or(CommandErr::Unavailable)?
                        .request_verification()
                        .await
                        .map_err(|error| self.failed("request_verification", error))?,
                };

                let flow_id = request.flow_id().to_owned();
                self.watch_verification(request);

                Ok(CommandOk::RequestVerification { flow_id })
            }

            Command::AcceptVerification { user_id, flow_id } => {
                let request = self.verification_request(&user_id, &flow_id).await?;

                request
                    .accept()
                    .await
                    .map_err(|error| self.failed("accept_verification", error))?;

                Ok(CommandOk::AcceptVerification)
            }

            Command::ConfirmVerification { user_id, flow_id } => {
                self.sas(&user_id, &flow_id)
                    .await?
                    .confirm()
                    .await
                    .map_err(|error| self.failed("confirm_verification", error))?;

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
                        .map_err(|error| self.failed("cancel_verification: mismatch", error))?,
                    Ok(sas) => sas
                        .cancel()
                        .await
                        .map_err(|error| self.failed("cancel_verification: sas", error))?,
                    Err(_) => self
                        .verification_request(&user_id, &flow_id)
                        .await?
                        .cancel()
                        .await
                        .map_err(|error| self.failed("cancel_verification", error))?,
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
                    .map_err(|error| self.failed("create_room: room version", error))?;
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
                };
                if room_type.is_some() || !federate {
                    let mut creation = RoomCreateEventContent::new_v11();
                    creation.room_type = room_type;
                    creation.federate = federate;
                    request.creation_content = Some(
                        Raw::new(&creation)
                            .map_err(|error| self.failed("create_room: creation content", error))?
                            .cast_unchecked(),
                    );
                }

                if let Some(rule) = join_rule_content(join_rule, parent_space.as_deref()) {
                    request.initial_state.push(
                        Raw::new(&rule)
                            .map_err(|error| self.failed("create_room: join rule", error))?
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
                        .map_err(|error| self.failed("create_room: call power levels", error))?
                        .cast_unchecked(),
                    );
                    request.initial_state.push(
                        Raw::new(&serde_json::json!({
                            "type": view::CALL_TYPE,
                            "state_key": "",
                            "content": {},
                        }))
                        .map_err(|error| self.failed("create_room: call state", error))?
                        .cast_unchecked(),
                    );
                }

                // Anyone can join and read a public room, so encryption only
                // breaks previews.
                if encrypted && !public && !matches!(kind, CreateRoomKind::Space) {
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
                    .map_err(|error| self.failed("create_room", error))?;

                if let Some(space_id) = parent_space {
                    self.add_to_space(&space_id, room.room_id()).await?;
                }

                Ok(CommandOk::CreateRoom {
                    room_id: room.room_id().to_owned(),
                })
            }

            Command::CreateDm { user_id } => {
                let room = self
                    .client()
                    .await?
                    .create_dm(&user_id)
                    .await
                    .map_err(|error| self.failed("create_dm", error))?;

                Ok(CommandOk::CreateDm {
                    room_id: room.room_id().to_owned(),
                })
            }

            Command::AddToSpace { space_id, room_id } => {
                self.add_to_space(&space_id, &room_id).await?;

                Ok(CommandOk::AddToSpace)
            }

            Command::SetSpaceChildOrder {
                space_id,
                room_id,
                order,
            } => self.set_space_child_order(&space_id, &room_id, order).await,

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
                items: spaces::sidebar(&self.client().await?)
                    .await
                    .map_err(|error| self.failed("space_sidebar", error))?,
            }),

            Command::SetSpaceSidebar { items } => {
                spaces::set_sidebar(&self.client().await?, &items)
                    .await
                    .map_err(|error| self.failed("set_space_sidebar", error))?;

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
                if room.canonical_alias().is_some() {
                    return Ok(CommandOk::RoomViaServers {
                        servers: Vec::new(),
                    });
                }

                let members = room
                    .members(RoomMemberships::JOIN)
                    .await
                    .map_err(|error| self.failed("room_via_servers", error))?;

                let ranked: Vec<(String, i32)> = members
                    .iter()
                    .map(|member| {
                        (
                            member.user_id().to_string(),
                            view::clamp_power_level(member.power_level()),
                        )
                    })
                    .collect();

                Ok(CommandOk::RoomViaServers {
                    servers: view::via_servers(&ranked),
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
            } => {
                // The read marker line tracks `m.fully_read`, so a receipt alone
                // would leave it where it was. The server drops either unless
                // newer, so the UI may send freely.
                let receipts = Receipts::new().fully_read_marker(event_id.clone());
                let receipts = if private_receipt {
                    receipts.private_read_receipt(event_id)
                } else {
                    receipts.public_read_receipt(event_id)
                };

                self.timeline(&room_id)
                    .await?
                    .send_multiple_receipts(receipts)
                    .await
                    .map_err(|error| self.failed("mark_read", error))?;

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
                    .map_err(|error| self.failed("retry_send", error))?;

                Ok(CommandOk::RetrySend)
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
                    .map_err(|error| self.failed("cancel_send", error))?;

                Ok(CommandOk::CancelSend { cancelled })
            }
        }
    }
}

fn thread_reply(
    in_reply_to: Option<matrix_sdk::ruma::OwnedEventId>,
    thread_root: Option<matrix_sdk::ruma::OwnedEventId>,
) -> Option<SdkReply> {
    let (event_id, enforce_thread) = match (in_reply_to, thread_root) {
        (Some(event_id), Some(_)) => (event_id, EnforceThread::Threaded(ReplyWithinThread::Yes)),
        (Some(event_id), None) => (event_id, EnforceThread::MaybeThreaded),
        (None, Some(root)) => (root, EnforceThread::Threaded(ReplyWithinThread::No)),
        (None, None) => return None,
    };

    Some(SdkReply {
        event_id,
        enforce_thread,
        add_mentions: AddMentions::Yes,
    })
}

fn message_content(
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

    if mentions.is_empty() && !room {
        return content;
    }

    let mut wanted = Mentions::with_user_ids(mentions);
    wanted.room = room;
    content.add_mentions(wanted)
}

fn edit_content(
    body: String,
    formatted: Option<String>,
    kind: MessageKind,
    image: Option<crate::protocol::EditImageView>,
    mentions: Vec<OwnedUserId>,
    room: bool,
) -> Result<RoomMessageEventContent, CommandErr> {
    let Some(image) = image else {
        return Ok(message_content(body, formatted, kind, mentions, room));
    };

    let source = serde_json::from_str(&image.source)
        .unwrap_or_else(|_| MediaSource::Plain(OwnedMxcUri::from(image.source)));
    if let MediaSource::Plain(uri) = &source
        && uri.parts().is_err()
    {
        return Err(CommandErr::InvalidMedia);
    }

    let mut content = ImageMessageEventContent::new(body, source);
    content.filename = image.filename;
    let mut info = ImageInfo::new();
    info.mimetype = image.mime;
    info.width = image.width.and_then(|width| UInt::try_from(width).ok());
    info.height = image.height.and_then(|height| UInt::try_from(height).ok());
    content.info = Some(Box::new(info));
    Ok(RoomMessageEventContent::new(MessageType::Image(content)))
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
    use super::{edit_content, message_content, state_event_content};
    use matrix_sdk::ruma::RoomId;

    use crate::protocol::{CreateJoinRuleView, EditImageView, MessageKind};

    #[test]
    fn a_preview_with_nothing_to_show_is_no_preview() {
        let empty = serde_json::json!({ "og:title": "   ", "og:image": "https://cdn/x.png" });
        assert!(super::url_preview("https://e".to_owned(), &empty).is_none());
        assert!(super::url_preview("https://e".to_owned(), &serde_json::json!({})).is_none());
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
    fn a_message_without_pills_carries_no_mentions() {
        let content = message_content(
            "hello".to_owned(),
            None,
            MessageKind::Text,
            Vec::new(),
            false,
        );

        assert!(content.mentions.is_none());
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
    fn editing_an_image_caption_preserves_the_image_content() {
        let content = edit_content(
            "updated caption".to_owned(),
            None,
            MessageKind::Text,
            Some(EditImageView {
                source: "mxc://example.org/photo".to_owned(),
                filename: Some("photo.png".to_owned()),
                mime: Some("image/png".to_owned()),
                width: Some(800),
                height: Some(600),
            }),
            Vec::new(),
            false,
        )
        .expect("valid image source");

        assert_eq!(content.msgtype(), "m.image");
        assert_eq!(
            serde_json::to_value(content).expect("serializable image content"),
            serde_json::json!({
                "msgtype": "m.image",
                "body": "updated caption",
                "filename": "photo.png",
                "url": "mxc://example.org/photo",
                "info": { "mimetype": "image/png", "w": 800, "h": 600 },
            })
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
