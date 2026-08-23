use std::sync::{Arc, atomic::Ordering};

use futures_util::{StreamExt, pin_mut};
use matrix_sdk::RoomMemberships;
use matrix_sdk::room::edit::EditedContent;
use matrix_sdk::room::{ParentSpace, Receipts};
use matrix_sdk::ruma::api::client::room::Visibility;
use matrix_sdk::ruma::api::client::room::create_room::{self, v3::RoomPreset};
use matrix_sdk::ruma::api::client::uiaa::{AuthData, AuthType, Password, UserIdentifier};
use matrix_sdk::ruma::events::InitialStateEvent;
use matrix_sdk::ruma::events::relation::{InReplyTo, Reply};
use matrix_sdk::ruma::events::room::ImageInfo;
use matrix_sdk::ruma::events::room::avatar::RoomAvatarEventContent;
use matrix_sdk::ruma::events::room::create::RoomCreateEventContent;
use matrix_sdk::ruma::events::room::encryption::RoomEncryptionEventContent;
use matrix_sdk::ruma::events::room::join_rules::{AllowRule, JoinRule, RoomJoinRulesEventContent};
use matrix_sdk::ruma::events::room::message::{ImageMessageEventContent, MessageType, Relation};
use matrix_sdk::ruma::events::sticker::StickerEventContent;
use matrix_sdk::ruma::events::tag::{TagInfo, TagName};
use matrix_sdk::ruma::profile::{ProfileFieldName, ProfileFieldValue};
use matrix_sdk::ruma::room::RoomType;
use matrix_sdk::ruma::serde::Raw;
use matrix_sdk::ruma::{
    OwnedMxcUri, OwnedUserId, RoomOrAliasId, ServerName, events::Mentions,
    events::room::member::MembershipState, events::room::message::RoomMessageEventContent,
};
use matrix_sdk_ui::timeline::TimelineEventItemId;

use crate::protocol::{
    Command, CommandErr, CommandOk, CreateRoomKind, JoinRuleView, MutualRoomView,
    PaginationDirection, RoomTag,
};
use matrix_sdk_ui::notification_client::NotificationProcessSetup;

use crate::media::mxc_uri;
use crate::profiles::profile_view;
use crate::rooms::join_rule_support;
use crate::verification::encryption_status;
use crate::{Core, SubscriptionKind};
use crate::{notifications, protocol, session, spaces, view};

const MAX_SEARCH_RESULTS: usize = 200;

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

            Command::SubscribeRoomList => self.subscribe_room_list().await,

            Command::SubscribeTimeline {
                room_id,
                event_id,
                hidden_events,
            } => {
                self.subscribe_timeline(room_id, event_id, hidden_events)
                    .await
            }

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
                in_reply_to,
                mentions,
                mentions_room,
            } => {
                let timeline = self.timeline(&room_id).await?;
                let content = message_content(body, formatted, mentions, mentions_room);

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

            Command::SendSticker {
                room_id,
                url,
                body,
                in_reply_to,
            } => {
                let url = OwnedMxcUri::from(url);
                if url.parts().is_err() {
                    return Err(CommandErr::InvalidMedia);
                }

                let timeline = self.timeline(&room_id).await?;
                let mut content = StickerEventContent::new(body, ImageInfo::new(), url);

                if let Some(event_id) = in_reply_to {
                    content.relates_to =
                        Some(Relation::Reply(Reply::new(InReplyTo::new(event_id))));
                }

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

                let timeline = self.timeline(&room_id).await?;
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
                mentions,
                mentions_room,
            } => {
                self.timeline(&room_id)
                    .await?
                    .edit(
                        &TimelineEventItemId::EventId(event_id),
                        EditedContent::RoomMessage(
                            message_content(body, formatted, mentions, mentions_room).into(),
                        ),
                    )
                    .await
                    .map_err(|error| self.failed("edit_message", error))?;

                Ok(CommandOk::EditMessage)
            }

            Command::FetchEventDetails { room_id, event_id } => {
                self.timeline(&room_id)
                    .await?
                    .fetch_details_for_event(&event_id)
                    .await
                    .map_err(|error| self.failed("fetch_event_details", error))?;

                Ok(CommandOk::FetchEventDetails)
            }

            Command::SearchMessages {
                query,
                room_id,
                limit,
                offset,
            } => {
                let limit = (limit as usize).min(MAX_SEARCH_RESULTS);
                let offset = offset as usize;
                let index = self.search_index.lock().await;

                let hits = room_id.map_or_else(
                    || index.search_all(&query, limit, offset),
                    |room_id| index.search_room(&room_id, &query, limit, offset),
                );

                Ok(CommandOk::SearchMessages {
                    hits: hits.into_iter().map(view::search_hit_view).collect(),
                })
            }

            Command::JoinCall {
                room_id,
                livekit_service_url,
            } => self.join_call(room_id, livekit_service_url).await,

            Command::LeaveCall { session } => self.leave_call(session).await,

            Command::RoomMembers { room_id } => {
                let room = self.room(&room_id).await?;
                let members = room
                    .members(RoomMemberships::JOIN)
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

            Command::Redact {
                room_id,
                event_id,
                reason,
            } => {
                self.timeline(&room_id)
                    .await?
                    .redact(&TimelineEventItemId::EventId(event_id), reason.as_deref())
                    .await
                    .map_err(|error| self.failed("redact", error))?;

                Ok(CommandOk::Redact)
            }

            Command::React {
                room_id,
                event_id,
                key,
            } => {
                self.timeline(&room_id)
                    .await?
                    .toggle_reaction(&TimelineEventItemId::EventId(event_id), &key)
                    .await
                    .map_err(|error| self.failed("react", error))?;

                Ok(CommandOk::React)
            }

            Command::SendLocation {
                room_id,
                body,
                geo_uri,
                in_reply_to,
            } => {
                if view::geo_coordinates(&geo_uri).is_none() {
                    return Err(CommandErr::InvalidLocation);
                }

                self.timeline(&room_id)
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
            } => {
                let content = crate::polls::start(&question, &answers, undisclosed, max_selections)
                    .ok_or(CommandErr::InvalidPoll)?;
                let content = matrix_sdk::ruma::events::poll::unstable_start::UnstablePollStartEventContent::from(content);

                self.timeline(&room_id)
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
            } => {
                let content = matrix_sdk::ruma::events::poll::unstable_response::UnstablePollResponseEventContent::new(
                answers, event_id,
            );

                self.timeline(&room_id)
                    .await?
                    .send(content.into())
                    .await
                    .map_err(|error| self.failed("vote poll", error))?;

                Ok(CommandOk::VotePoll)
            }

            Command::EndPoll { room_id, event_id } => {
                let content =
                    matrix_sdk::ruma::events::poll::unstable_end::UnstablePollEndEventContent::new(
                        "The poll has closed.",
                        event_id,
                    );

                self.timeline(&room_id)
                    .await?
                    .send(content.into())
                    .await
                    .map_err(|error| self.failed("end poll", error))?;

                Ok(CommandOk::EndPoll)
            }

            Command::EncryptionStatus => Ok(CommandOk::EncryptionStatus {
                status: encryption_status(&self.client().await?).await,
            }),

            Command::Devices => {
                let client = self.client().await?;
                let own_device_id = client.device_id().map(ToOwned::to_owned);
                let account_management = client.oauth().full_session().is_some()
                    && client
                        .oauth()
                        .server_metadata()
                        .await
                        .ok()
                        .and_then(|metadata| metadata.account_management_uri)
                        .is_some();

                let user_id = client.user_id().ok_or(CommandErr::NotLoggedIn)?.to_owned();
                let devices = client
                    .encryption()
                    .get_user_devices(&user_id)
                    .await
                    .map_err(|error| self.failed("devices", error))?;

                Ok(CommandOk::Devices {
                    devices: devices
                        .devices()
                        .map(|device| protocol::DeviceView {
                            is_own: Some(device.device_id()) == own_device_id.as_deref(),
                            device_id: device.device_id().to_owned(),
                            display_name: device.display_name().map(str::to_owned),
                            is_verified: device.is_verified(),
                        })
                        .collect(),
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

            Command::SetNotificationContent { visible } => {
                self.notification_content.store(visible, Ordering::Relaxed);

                Ok(CommandOk::SetNotificationContent)
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

            Command::RequestVerification { user_id } => {
                let request = self
                    .client()
                    .await?
                    .encryption()
                    .get_user_identity(&user_id)
                    .await
                    .map_err(|error| self.failed("request_verification: identity", error))?
                    // No cross-signing identity: keys not downloaded, or none set.
                    .ok_or(CommandErr::Unavailable)?
                    .request_verification()
                    .await
                    .map_err(|error| self.failed("request_verification", error))?;

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
            } => {
                let client = self.client().await?;
                let mut request = create_room::v3::Request::new();
                request.name = name;
                request.topic = topic;
                request.invite = invite;
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

                if let Some(room_type) = match kind {
                    CreateRoomKind::Text => None,
                    CreateRoomKind::Space => Some(RoomType::Space),
                    CreateRoomKind::Voice => Some(RoomType::Call),
                } {
                    let mut creation = RoomCreateEventContent::new_v11();
                    creation.room_type = Some(room_type);
                    request.creation_content = Some(
                        Raw::new(&creation)
                            .map_err(|error| self.failed("create_room: room type", error))?
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

            Command::MarkRead { room_id, event_id } => {
                // The read marker line tracks `m.fully_read`, so a receipt alone
                // would leave it where it was. The server drops either unless
                // newer, so the UI may send freely.
                self.timeline(&room_id)
                    .await?
                    .send_multiple_receipts(
                        Receipts::new()
                            .public_read_receipt(event_id.clone())
                            .fully_read_marker(event_id),
                    )
                    .await
                    .map_err(|error| self.failed("mark_read", error))?;

                Ok(CommandOk::MarkRead)
            }

            Command::RetrySend {
                room_id,
                transaction_id,
            } => {
                self.client().await?.send_queue().set_enabled(true).await;

                self.local_echo(&room_id, &transaction_id)
                    .await?
                    .unwedge()
                    .await
                    .map_err(|error| self.failed("retry_send", error))?;

                Ok(CommandOk::RetrySend)
            }

            Command::CancelSend {
                room_id,
                transaction_id,
            } => {
                let cancelled = self
                    .local_echo(&room_id, &transaction_id)
                    .await?
                    .abort()
                    .await
                    .map_err(|error| self.failed("cancel_send", error))?;

                Ok(CommandOk::CancelSend { cancelled })
            }
        }
    }
}

fn message_content(
    body: String,
    formatted: Option<String>,
    mentions: Vec<OwnedUserId>,
    room: bool,
) -> RoomMessageEventContent {
    let content = match formatted {
        Some(html) => RoomMessageEventContent::text_html(body, html),
        None => RoomMessageEventContent::text_plain(body),
    };

    if mentions.is_empty() && !room {
        return content;
    }

    let mut wanted = Mentions::with_user_ids(mentions);
    wanted.room = room;
    content.add_mentions(wanted)
}

#[cfg(test)]
mod tests {
    use super::message_content;
    use crate::view;
    use matrix_sdk::ruma::owned_user_id;

    #[test]
    fn a_message_without_pills_carries_no_mentions() {
        let content = message_content("hello".to_owned(), None, Vec::new(), false);

        assert!(content.mentions.is_none());
    }

    #[test]
    fn pills_become_m_mentions() {
        let content = message_content(
            "hi One".to_owned(),
            None,
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
    fn a_room_mention_needs_no_user_ids() {
        let content = message_content("@room heads up".to_owned(), None, Vec::new(), true);

        let mentions = content.mentions.expect("mentions");
        assert!(mentions.user_ids.is_empty());
        assert!(mentions.room);
    }
}
