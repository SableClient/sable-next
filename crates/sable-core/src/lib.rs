#![recursion_limit = "512"]

pub mod protocol;
pub mod rt;
pub mod session;
pub mod store;
pub mod view;

use std::{
    collections::HashMap,
    fmt::Display,
    sync::{
        Arc,
        atomic::{AtomicU32, AtomicU64, Ordering},
    },
};

use futures_util::{StreamExt, pin_mut};
use matrix_sdk::RoomMemberships;
use matrix_sdk::authentication::oauth::error::OAuthDiscoveryError;
use matrix_sdk::encryption::VerificationState;
use matrix_sdk::encryption::recovery::RecoveryState;
use matrix_sdk::encryption::verification::{
    SasState, SasVerification, VerificationRequest, VerificationRequestState,
};
use matrix_sdk::media::{MediaFormat, MediaRequestParameters, MediaThumbnailSettings};
use matrix_sdk::room::edit::EditedContent;
use matrix_sdk::ruma::api::client::profile::{AvatarUrl, DisplayName};
use matrix_sdk::ruma::api::client::receipt::create_receipt::v3::ReceiptType;
use matrix_sdk::ruma::api::client::room::Visibility;
use matrix_sdk::ruma::api::client::room::create_room::{self, v3::RoomPreset};
use matrix_sdk::ruma::api::client::session::get_login_types::v3::LoginType;
use matrix_sdk::ruma::api::client::uiaa::{AuthData, AuthType, Password, UserIdentifier};
use matrix_sdk::ruma::api::error::{ErrorKind, RetryAfter};
use matrix_sdk::ruma::events::InitialStateEvent;
use matrix_sdk::ruma::events::key::verification::request::ToDeviceKeyVerificationRequestEvent;
use matrix_sdk::ruma::events::presence::PresenceEvent;
use matrix_sdk::ruma::events::room::MediaSource;
use matrix_sdk::ruma::events::room::avatar::RoomAvatarEventContent;
use matrix_sdk::ruma::events::room::create::RoomCreateEventContent;
use matrix_sdk::ruma::events::room::encryption::RoomEncryptionEventContent;
use matrix_sdk::ruma::events::room::join_rules::{JoinRule, RoomJoinRulesEventContent};
use matrix_sdk::ruma::events::room::message::{MessageType, OriginalSyncRoomMessageEvent};
use matrix_sdk::ruma::events::space::child::SpaceChildEventContent;
use matrix_sdk::ruma::events::tag::{TagInfo, TagName};
use matrix_sdk::ruma::events::typing::SyncTypingEvent;
use matrix_sdk::ruma::presence::PresenceState;
use matrix_sdk::ruma::room::RoomType;
use matrix_sdk::ruma::serde::Raw;
use matrix_sdk::ruma::{
    OwnedEventId, OwnedMxcUri, OwnedRoomId, OwnedUserId, RoomId, RoomOrAliasId, ServerName, UserId,
    events::room::message::{RoomMessageEventContent, TextMessageEventContent},
};
use matrix_sdk::send_queue::SendHandle;
use matrix_sdk_ui::{
    room_list_service::filters::new_filter_non_left,
    sync_service::State as SyncState,
    timeline::{AttachmentConfig, AttachmentSource, RoomExt, Timeline, TimelineEventItemId},
};
use mime::Mime;
use tokio::sync::{Mutex, RwLock, mpsc};
use url::Url;

use protocol::{
    Command, CommandErr, CommandOk, CoreEvent, EmojiView, EncryptionStatusView, JoinRuleView,
    PresenceView, ProfileView, RecoveryStateView, RoomTag, SessionInfo, SubscriptionId, SyncStatus,
    VerificationStateView, VerificationView,
};
use rt::Task;
use session::{Credentials, PersistedSession, Session};
use store::SessionStore;

const ROOM_LIST_PAGE_SIZE: usize = 200;

async fn encryption_status(client: &matrix_sdk::Client) -> EncryptionStatusView {
    let encryption = client.encryption();

    EncryptionStatusView {
        verification: match encryption.verification_state().get() {
            VerificationState::Verified => VerificationStateView::Verified,
            VerificationState::Unverified => VerificationStateView::Unverified,
            VerificationState::Unknown => VerificationStateView::Unknown,
        },
        recovery: match encryption.recovery().state() {
            RecoveryState::Enabled => RecoveryStateView::Enabled,
            RecoveryState::Disabled => RecoveryStateView::Disabled,
            RecoveryState::Incomplete => RecoveryStateView::Incomplete,
            RecoveryState::Unknown => RecoveryStateView::Unknown,
        },
        // A partial set cannot sign another device, so it does not count.
        cross_signing_ready: encryption
            .cross_signing_status()
            .await
            .is_some_and(|status| status.is_complete()),
    }
}

fn mxc_uri(url: &str) -> Result<OwnedMxcUri, CommandErr> {
    let uri = OwnedMxcUri::from(url);
    if uri.parts().is_err() {
        return Err(CommandErr::InvalidMedia);
    }
    Ok(uri)
}

fn same_redirect_target(expected: &Url, callback: &Url) -> bool {
    let mut expected_target = expected.clone();
    expected_target.set_query(None);
    expected_target.set_fragment(None);

    let mut callback_target = callback.clone();
    callback_target.set_query(None);
    callback_target.set_fragment(None);

    expected_target == callback_target
}

fn message_content(body: String, formatted: Option<String>) -> RoomMessageEventContent {
    match formatted {
        Some(html) => RoomMessageEventContent::text_html(body, html),
        None => RoomMessageEventContent::text_plain(body),
    }
}

fn request_view(
    request: &VerificationRequest,
    state: &VerificationRequestState,
) -> VerificationView {
    match state {
        VerificationRequestState::Requested { .. } => VerificationView::Requested {
            is_self: request.is_self_verification(),
        },
        VerificationRequestState::Done => VerificationView::Done,
        VerificationRequestState::Cancelled(info) => VerificationView::Cancelled {
            reason: info.reason().to_owned(),
        },
        _ => VerificationView::Waiting,
    }
}

fn sas_view(sas: &SasVerification, state: &SasState) -> VerificationView {
    match state {
        // From the SAS itself, so a flow joined mid-way still reports emoji.
        SasState::KeysExchanged { decimals, .. } => VerificationView::Compare {
            emojis: sas
                .emoji()
                .map(|emoji| {
                    emoji
                        .iter()
                        .map(|emoji| EmojiView {
                            symbol: emoji.symbol.to_owned(),
                            description: emoji.description.to_owned(),
                        })
                        .collect()
                })
                .unwrap_or_default(),
            decimals: *decimals,
        },
        SasState::Confirmed => VerificationView::Confirmed,
        SasState::Done { .. } => VerificationView::Done,
        SasState::Cancelled(info) => VerificationView::Cancelled {
            reason: info.reason().to_owned(),
        },
        _ => VerificationView::Waiting,
    }
}

fn sync_status(state: SyncState) -> SyncStatus {
    match state {
        SyncState::Idle | SyncState::Terminated => SyncStatus::Offline,
        SyncState::Running => SyncStatus::Live,
        SyncState::Error(error) => SyncStatus::Error {
            message: error.to_string(),
        },
        SyncState::Offline => SyncStatus::Syncing,
    }
}

/// Owns every piece of Matrix state. A carrier only moves `Command`s in and
/// `CoreEvent`s out.
pub struct Core {
    store_id: String,
    sessions: Box<dyn SessionStore>,
    events: mpsc::UnboundedSender<CoreEvent>,
    next_subscription: AtomicU32,
    next_log_id: AtomicU64,
    session_generation: AtomicU64,
    session_store_lock: Mutex<()>,
    session: RwLock<Option<Session>>,
    pending_login: Mutex<Option<PendingLogin>>,
    subscriptions: Mutex<HashMap<SubscriptionId, Task>>,
    timelines: Mutex<HashMap<OwnedRoomId, Arc<Timeline>>>,
}

enum PendingLogin {
    Oidc(String, matrix_sdk::Client),
    Sso(String, Url, matrix_sdk::Client),
}

impl Core {
    #[allow(clippy::arc_with_non_send_sync)] // WASM keeps the core on one event-loop thread
    pub fn new(
        store_id: impl Into<String>,
        sessions: Box<dyn SessionStore>,
    ) -> (Arc<Self>, mpsc::UnboundedReceiver<CoreEvent>) {
        let (events, rx) = mpsc::unbounded_channel();
        let core = Arc::new(Self {
            store_id: store_id.into(),
            sessions,
            events,
            next_subscription: AtomicU32::new(1),
            next_log_id: AtomicU64::new(1),
            session_generation: AtomicU64::new(1),
            session_store_lock: Mutex::new(()),
            session: RwLock::new(None),
            pending_login: Mutex::new(None),
            subscriptions: Mutex::new(HashMap::new()),
            timelines: Mutex::new(HashMap::new()),
        });
        (core, rx)
    }

    /// No carrier means no UI, and syncing continues, so a drop is not an error.
    pub fn emit(&self, event: CoreEvent) {
        let _ = self.events.send(event);
    }

    fn allocate_subscription(&self) -> SubscriptionId {
        SubscriptionId(self.next_subscription.fetch_add(1, Ordering::Relaxed))
    }

    fn failed(&self, context: &str, error: impl Display) -> CommandErr {
        let log_id = format!("e{}", self.next_log_id.fetch_add(1, Ordering::Relaxed));
        tracing::error!(log_id, context, "{error}");
        CommandErr::Failed { log_id }
    }

    fn login_error(&self, error: matrix_sdk::Error) -> CommandErr {
        if error.client_api_error_kind() == Some(&ErrorKind::Forbidden) {
            return CommandErr::Denied;
        }

        match error {
            matrix_sdk::Error::Http(error) => self.homeserver_http_error("login", *error),
            _ => self.failed("login", error),
        }
    }

    fn homeserver_http_error(&self, context: &str, error: matrix_sdk::HttpError) -> CommandErr {
        match error.client_api_error_kind() {
            Some(ErrorKind::LimitExceeded(limit)) => CommandErr::RateLimited {
                retry_after_ms: limit.retry_after.as_ref().and_then(|retry_after| {
                    let RetryAfter::Delay(delay) = retry_after else {
                        return None;
                    };
                    delay.as_millis().try_into().ok()
                }),
            },
            _ if error
                .as_client_api_error()
                .is_some_and(|api_error| api_error.status_code.as_u16() == 429) =>
            {
                CommandErr::RateLimited {
                    retry_after_ms: None,
                }
            }
            _ if matches!(error, matrix_sdk::HttpError::Reqwest(_)) => CommandErr::Unavailable,
            _ if error
                .as_client_api_error()
                .is_some_and(|api_error| api_error.status_code.is_server_error()) =>
            {
                CommandErr::Unavailable
            }
            _ => self.failed(context, error),
        }
    }

    fn discovery_error(&self, error: matrix_sdk::ClientBuildError) -> CommandErr {
        match error {
            matrix_sdk::ClientBuildError::Http(error) => {
                self.homeserver_http_error("login_flows: discovery", error)
            }
            _ => CommandErr::UnknownHomeserver,
        }
    }

    /// Dispatches one protocol command to the Matrix client.
    ///
    /// # Errors
    ///
    /// Returns a protocol error when the command is invalid, the user is not
    /// authenticated, or the Matrix operation fails.
    #[allow(clippy::assigning_clones, clippy::too_many_lines)] // protocol dispatch centralizes one boundary; the SDK response is borrowed
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

            Command::StartOidcLogin {
                homeserver,
                redirect_uri,
            } => self.start_oidc_login(homeserver, redirect_uri).await,

            Command::CompleteOidcLogin { callback_url } => {
                self.complete_oidc_login(callback_url).await
            }

            Command::StartSsoLogin {
                homeserver,
                redirect_uri,
                idp_id,
            } => self.start_sso_login(homeserver, redirect_uri, idp_id).await,

            Command::CompleteSsoLogin { callback_url } => {
                self.complete_sso_login(callback_url).await
            }

            Command::Restore => self.restore().await,

            Command::Logout => self.logout().await,

            Command::SubscribeRoomList => self.subscribe_room_list().await,

            Command::SubscribeTimeline { room_id } => self.subscribe_timeline(room_id).await,

            Command::Unsubscribe { subscription } => {
                let task = self.subscriptions.lock().await.remove(&subscription);
                task.map_or(Err(CommandErr::UnknownSubscription), |task| {
                    task.abort();
                    Ok(CommandOk::Unsubscribe)
                })
            }

            Command::Paginate { room_id, count } => {
                let timeline = self.timeline(&room_id).await?;
                let reached_start = timeline
                    .paginate_backwards(count)
                    .await
                    .map_err(|error| self.failed("paginate", error))?;

                Ok(CommandOk::Paginate { reached_start })
            }

            Command::SendMessage {
                room_id,
                body,
                formatted,
                in_reply_to,
            } => {
                let timeline = self.timeline(&room_id).await?;
                let content = message_content(body, formatted);

                match in_reply_to {
                    // `send_reply` fills the thread relation itself.
                    Some(event_id) => timeline
                        .send_reply(content.into(), event_id)
                        .await
                        .map_err(|error| self.failed("send_reply", error))?,
                    None => {
                        timeline
                            .send(content.into())
                            .await
                            .map_err(|error| self.failed("send_message", error))?;
                    }
                }

                Ok(CommandOk::SendMessage)
            }

            Command::EditMessage {
                room_id,
                event_id,
                body,
                formatted,
            } => {
                self.timeline(&room_id)
                    .await?
                    .edit(
                        &TimelineEventItemId::EventId(event_id),
                        EditedContent::RoomMessage(message_content(body, formatted).into()),
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

            Command::UserProfile { user_id } => {
                let response = self
                    .client()
                    .await?
                    .account()
                    .fetch_user_profile_of(&user_id)
                    .await
                    .map_err(|error| self.failed("user_profile", error))?;

                Ok(CommandOk::UserProfile {
                    profile: ProfileView {
                        user_id,
                        display_name: response.get_static::<DisplayName>().ok().flatten(),
                        avatar_url: response
                            .get_static::<AvatarUrl>()
                            .ok()
                            .flatten()
                            .map(|url| url.to_string()),
                    },
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

            Command::EncryptionStatus => Ok(CommandOk::EncryptionStatus {
                status: encryption_status(&self.client().await?).await,
            }),

            Command::Devices => {
                let client = self.client().await?;
                let own_device_id = client.device_id().map(ToOwned::to_owned);

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
                })
            }

            Command::RecoverIdentity { recovery_key } => {
                self.client()
                    .await?
                    .encryption()
                    .recovery()
                    .recover(&recovery_key)
                    .await
                    .map_err(|error| self.failed("recover_identity", error))?;

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

                // The flows cannot be asked for up front.
                let Err(error) = client.delete_devices(&devices, None).await else {
                    return Ok(CommandOk::DeleteDevice);
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
                auth.session = uiaa.session.clone();

                client
                    .delete_devices(&devices, Some(AuthData::Password(auth)))
                    .await
                    .map_err(|error| match error.as_uiaa_response() {
                        // A wrong password comes back as another challenge.
                        Some(_) => CommandErr::Denied,
                        None => self.failed("delete_device: auth", error),
                    })?;

                Ok(CommandOk::DeleteDevice)
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

            Command::SetRoomTag { room_id, tag, set } => {
                let room = self.room(&room_id).await?;
                let name = match tag {
                    RoomTag::Favourite => TagName::Favorite,
                    RoomTag::LowPriority => TagName::LowPriority,
                };

                if set {
                    room.set_tag(name, TagInfo::new())
                        .await
                        .map_err(|error| self.failed("set_room_tag", error))?;
                } else {
                    room.remove_tag(name)
                        .await
                        .map_err(|error| self.failed("remove_room_tag", error))?;
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
                let rule = match rule {
                    JoinRuleView::Public => JoinRule::Public,
                    JoinRuleView::Invite => JoinRule::Invite,
                    JoinRuleView::Knock => JoinRule::Knock,
                };

                self.room(&room_id)
                    .await?
                    .send_state_event(RoomJoinRulesEventContent::new(rule))
                    .await
                    .map_err(|error| self.failed("set_room_join_rule", error))?;

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
                    .map_err(|error| self.failed("send_state_event", error))?;

                Ok(CommandOk::SendStateEvent)
            }

            Command::SetRoomName { room_id, name } => {
                // The spec clears a name with an empty one.
                self.room(&room_id)
                    .await?
                    .set_name(name.unwrap_or_default())
                    .await
                    .map_err(|error| self.failed("set_room_name", error))?;

                Ok(CommandOk::SetRoomName)
            }

            Command::SetRoomTopic { room_id, topic } => {
                self.room(&room_id)
                    .await?
                    .set_room_topic(&topic)
                    .await
                    .map_err(|error| self.failed("set_room_topic", error))?;

                Ok(CommandOk::SetRoomTopic)
            }

            Command::SetRoomAvatar { room_id, url } => {
                let room = self.room(&room_id).await?;

                match url {
                    Some(url) => {
                        room.set_avatar_url(&mxc_uri(&url)?, None)
                            .await
                            .map_err(|error| self.failed("set_room_avatar", error))?;
                    }
                    // State cannot be deleted, so empty content is the removal.
                    None => {
                        room.send_state_event(RoomAvatarEventContent::new())
                            .await
                            .map_err(|error| self.failed("clear_room_avatar", error))?;
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
                    .map_err(|error| self.failed("set_user_power_level", error))?;

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
                    .map_err(|error| self.failed("kick_user", error))?;

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
                    .map_err(|error| self.failed("ban_user", error))?;

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
                    .map_err(|error| self.failed("unban_user", error))?;

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
                is_space,
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

                if is_space {
                    let mut creation = RoomCreateEventContent::new_v11();
                    creation.room_type = Some(RoomType::Space);
                    request.creation_content = Some(
                        Raw::new(&creation)
                            .map_err(|error| self.failed("create_room: space type", error))?
                            .cast_unchecked(),
                    );
                } else if encrypted && !public {
                    // Anyone can join and read, so encryption only breaks previews.
                    request.initial_state = vec![
                        InitialStateEvent::with_empty_state_key(
                            RoomEncryptionEventContent::with_recommended_defaults(),
                        )
                        .to_raw_any(),
                    ];
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

            Command::RemoveFromSpace { space_id, room_id } => {
                // The spec delists by omitting `via`. The typed content has it
                // non-optional and would send `{"via": []}`, a valid array.
                self.room(&space_id)
                    .await?
                    .send_state_event_raw("m.space.child", room_id.as_str(), &serde_json::json!({}))
                    .await
                    .map_err(|error| self.failed("remove_from_space", error))?;

                Ok(CommandOk::RemoveFromSpace)
            }

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
                    .map_err(|error| self.failed("join_room", error))?;

                Ok(CommandOk::JoinRoom {
                    room_id: room.room_id().to_owned(),
                })
            }

            Command::LeaveRoom { room_id } => {
                self.room(&room_id)
                    .await?
                    .leave()
                    .await
                    .map_err(|error| self.failed("leave_room", error))?;

                // Keeping it would hand a stale timeline back on rejoin.
                self.timelines.lock().await.remove(&room_id);

                Ok(CommandOk::LeaveRoom)
            }

            Command::InviteUser { room_id, user_id } => {
                self.room(&room_id)
                    .await?
                    .invite_user_by_id(&user_id)
                    .await
                    .map_err(|error| self.failed("invite_user", error))?;

                Ok(CommandOk::InviteUser)
            }

            Command::MarkRead { room_id, event_id } => {
                // The server drops it unless newer, so the UI may send freely.
                self.timeline(&room_id)
                    .await?
                    .send_single_receipt(ReceiptType::Read, event_id)
                    .await
                    .map_err(|error| self.failed("mark_read", error))?;

                Ok(CommandOk::MarkRead)
            }

            Command::RetrySend {
                room_id,
                transaction_id,
            } => {
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

    /// Without a `via` server the edge is ignored.
    async fn add_to_space(
        &self,
        space_id: &OwnedRoomId,
        room_id: &RoomId,
    ) -> Result<(), CommandErr> {
        let client = self.client().await?;
        let via = vec![
            client
                .user_id()
                .ok_or(CommandErr::NotLoggedIn)?
                .server_name()
                .to_owned(),
        ];

        self.room(space_id)
            .await?
            .send_state_event_for_key(room_id, SpaceChildEventContent::new(via))
            .await
            .map_err(|error| self.failed("add_to_space", error))?;

        Ok(())
    }

    /// The handle lives on the timeline item, so the id has to be looked up.
    async fn local_echo(
        &self,
        room_id: &OwnedRoomId,
        transaction_id: &str,
    ) -> Result<SendHandle, CommandErr> {
        self.timeline(room_id)
            .await?
            .items()
            .await
            .iter()
            .filter_map(|item| item.as_event())
            .find(|event| {
                event
                    .transaction_id()
                    .is_some_and(|id| id == transaction_id)
            })
            .and_then(matrix_sdk_ui::timeline::EventTimelineItem::local_echo_send_handle)
            .ok_or(CommandErr::UnknownLocalEcho)
    }

    // session

    async fn login(
        self: &Arc<Self>,
        homeserver: String,
        username: String,
        password: String,
    ) -> Result<CommandOk, CommandErr> {
        let client = session::build_client(&self.store_id, &homeserver)
            .await
            .map_err(|error| self.failed("build_client", error))?;

        client
            .matrix_auth()
            .login_username(&username, &password)
            .initial_device_display_name("Sable")
            .request_refresh_token()
            .await
            .map_err(|error| self.login_error(error))?;

        let matrix = client
            .matrix_auth()
            .session()
            .ok_or_else(|| self.failed("login", "no session after a successful login"))?;

        let user_id = matrix.meta.user_id.clone();
        let generation = self.session_generation.fetch_add(1, Ordering::SeqCst) + 1;
        self.persist(
            &PersistedSession {
                homeserver: homeserver.clone(),
                credentials: Credentials::Password(matrix),
            },
            generation,
        )
        .await?;
        self.start_session(client, homeserver, generation).await?;

        Ok(CommandOk::Login { user_id })
    }

    async fn login_flows(self: &Arc<Self>, homeserver: String) -> Result<CommandOk, CommandErr> {
        let client = session::discovery_client(&homeserver)
            .await
            .map_err(|error| self.discovery_error(error))?;

        let mut flows = protocol::LoginFlowsView {
            password: false,
            oidc: false,
            sso: false,
            oauth_aware_preferred: false,
            sso_identity_providers: Vec::new(),
        };

        // An OAuth-only homeserver answers 404 `M_UNRECOGNIZED` here, which
        // means "no legacy flows", not "no homeserver".
        match client.matrix_auth().get_login_types().await {
            Ok(types) => {
                for flow in &types.flows {
                    match flow {
                        LoginType::Password(_) => flows.password = true,
                        LoginType::Sso(sso) => {
                            flows.sso = true;
                            flows.oauth_aware_preferred |= sso.oauth_aware_preferred;
                            flows
                                .sso_identity_providers
                                .extend(sso.identity_providers.iter().map(|provider| {
                                    protocol::SsoIdentityProviderView {
                                        id: provider.id.clone(),
                                        name: provider.name.clone(),
                                        icon: provider.icon.as_ref().map(ToString::to_string),
                                        brand: provider.brand.as_ref().and_then(|brand| {
                                            serde_json::to_value(brand)
                                                .ok()?
                                                .as_str()
                                                .map(str::to_owned)
                                        }),
                                    }
                                }));
                        }
                        _ => {}
                    }
                }
            }
            Err(error) if error.is_endpoint_not_implemented() => {
                tracing::debug!("homeserver has no legacy login flows: {error}");
            }
            Err(error) => {
                return Err(self.homeserver_http_error("login_flows: legacy", error));
            }
        }

        // OAuth is advertised by auth-metadata, not by /login.
        match client.oauth().server_metadata().await {
            Ok(_) => flows.oidc = true,
            Err(OAuthDiscoveryError::NotSupported) => {}
            Err(OAuthDiscoveryError::Http(error)) if !flows.password && !flows.sso => {
                return Err(self.homeserver_http_error("login_flows: oauth", error));
            }
            Err(error) if !flows.password && !flows.sso => {
                return Err(self.failed("login_flows: oauth", error));
            }
            Err(error) => tracing::debug!("OAuth login is unavailable: {error}"),
        }

        // Nothing we can drive. Report it instead of an empty form.
        if !flows.password && !flows.sso && !flows.oidc {
            return Err(CommandErr::Unsupported);
        }

        Ok(CommandOk::LoginFlows { flows })
    }

    /// Parked in `pending_oidc` so step 2 finishes on the same `Client`: the
    /// PKCE verifier and CSRF state live inside it and cannot be rebuilt.
    async fn start_oidc_login(
        self: &Arc<Self>,
        homeserver: String,
        redirect_uri: String,
    ) -> Result<CommandOk, CommandErr> {
        let redirect_uri = Url::parse(&redirect_uri)
            .map_err(|error| self.failed("start_oidc_login: redirect_uri", error))?;

        let client = session::build_client(&self.store_id, &homeserver)
            .await
            .map_err(|error| self.failed("start_oidc_login: build_client", error))?;

        let registration = session::client_metadata(&redirect_uri).into();

        let data = client
            .oauth()
            .login(redirect_uri, None, Some(registration), None)
            .build()
            .await
            .map_err(|error| self.failed("start_oidc_login", error))?;

        let authorization_url = data.url.to_string();
        let mut pending = self.pending_login.lock().await;
        if matches!(pending.as_ref(), Some(PendingLogin::Sso(_, _, _))) {
            return Err(CommandErr::Unavailable);
        }

        if pending.is_some() {
            tracing::warn!("replacing unfinished OIDC login with a new attempt");
        }
        *pending = Some(PendingLogin::Oidc(homeserver, client));

        Ok(CommandOk::StartOidcLogin { authorization_url })
    }

    async fn complete_oidc_login(
        self: &Arc<Self>,
        callback_url: String,
    ) -> Result<CommandOk, CommandErr> {
        let url = Url::parse(&callback_url)
            .map_err(|error| self.failed("complete_oidc_login: callback_url", error))?;

        let mut pending = self.pending_login.lock().await;
        let Some(PendingLogin::Oidc(_, client)) = pending.as_ref() else {
            tracing::warn!("no pending OIDC login: it was started elsewhere or the core restarted");
            return Err(CommandErr::Unavailable);
        };

        client
            .oauth()
            .finish_login(url.into())
            .await
            .map_err(|error| self.failed("complete_oidc_login", error))?;

        let Some(PendingLogin::Oidc(homeserver, client)) = pending.take() else {
            return Err(CommandErr::Unavailable);
        };
        drop(pending);

        let full = client
            .oauth()
            .full_session()
            .ok_or_else(|| self.failed("complete_oidc_login", "no session after finish_login"))?;

        let user_id = full.user.meta.user_id.clone();
        let generation = self.session_generation.fetch_add(1, Ordering::SeqCst) + 1;
        self.persist(
            &PersistedSession {
                homeserver: homeserver.clone(),
                credentials: Credentials::oauth(full),
            },
            generation,
        )
        .await?;
        self.start_session(client, homeserver, generation).await?;

        Ok(CommandOk::CompleteOidcLogin { user_id })
    }

    async fn start_sso_login(
        self: &Arc<Self>,
        homeserver: String,
        redirect_uri: String,
        idp_id: Option<String>,
    ) -> Result<CommandOk, CommandErr> {
        let redirect_uri = Url::parse(&redirect_uri)
            .map_err(|error| self.failed("start_sso_login: redirect_uri", error))?;

        let client = session::build_client(&self.store_id, &homeserver)
            .await
            .map_err(|error| self.failed("start_sso_login: build_client", error))?;

        let authorization_url = client
            .matrix_auth()
            .get_sso_login_url(redirect_uri.as_str(), idp_id.as_deref())
            .await
            .map_err(|error| self.failed("start_sso_login", error))?;

        let mut authorization_url = Url::parse(&authorization_url)
            .map_err(|error| self.failed("start_sso_login: authorization_url", error))?;
        authorization_url
            .query_pairs_mut()
            .append_pair("action", "login");

        let mut pending = self.pending_login.lock().await;
        if pending.is_some() {
            return Err(CommandErr::Unavailable);
        }
        *pending = Some(PendingLogin::Sso(homeserver, redirect_uri, client));

        Ok(CommandOk::StartSsoLogin {
            authorization_url: authorization_url.to_string(),
        })
    }

    async fn complete_sso_login(
        self: &Arc<Self>,
        callback_url: String,
    ) -> Result<CommandOk, CommandErr> {
        // The login token is single-use, so keep the client that created the
        // redirect and consume the pending flow exactly once.
        let callback_url = Url::parse(&callback_url)
            .map_err(|error| self.failed("complete_sso_login: callback_url", error))?;

        let mut pending = self.pending_login.lock().await;
        let Some(PendingLogin::Sso(_, expected_redirect_uri, _)) = pending.as_ref() else {
            tracing::warn!("no pending SSO login: it was started elsewhere or the core restarted");
            return Err(CommandErr::Unavailable);
        };

        if !same_redirect_target(expected_redirect_uri, &callback_url) {
            return Err(self.failed(
                "complete_sso_login: callback_url",
                "callback URL does not match the redirect URI used to start SSO",
            ));
        }

        let Some(PendingLogin::Sso(homeserver, _, client)) = pending.take() else {
            return Err(CommandErr::Unavailable);
        };
        drop(pending);

        client
            .matrix_auth()
            .login_with_sso_callback(callback_url.into())
            .map_err(|error| self.failed("complete_sso_login: callback_url", error))?
            .initial_device_display_name("Sable")
            .request_refresh_token()
            .await
            .map_err(|error| self.failed("complete_sso_login", error))?;

        let matrix = client.matrix_auth().session().ok_or_else(|| {
            self.failed("complete_sso_login", "no session after a successful login")
        })?;
        let user_id = matrix.meta.user_id.clone();

        let generation = self.session_generation.fetch_add(1, Ordering::SeqCst) + 1;
        self.persist(
            &PersistedSession {
                homeserver: homeserver.clone(),
                credentials: Credentials::Password(matrix),
            },
            generation,
        )
        .await?;
        self.start_session(client, homeserver, generation).await?;

        Ok(CommandOk::CompleteSsoLogin { user_id })
    }

    async fn restore(self: &Arc<Self>) -> Result<CommandOk, CommandErr> {
        let Some(bytes) = self.sessions.load().await else {
            return Ok(CommandOk::Restore { session: None });
        };

        let persisted: PersistedSession = serde_json::from_slice(&bytes)
            .map_err(|error| self.failed("restore: parse session file", error))?;

        let client = session::build_client(&self.store_id, &persisted.homeserver)
            .await
            .map_err(|error| self.failed("restore: build_client", error))?;

        let info = SessionInfo {
            user_id: persisted
                .credentials
                .user_id()
                .parse()
                .map_err(|error| self.failed("restore: user id", error))?,
            device_id: persisted.credentials.device_id(),
        };

        match persisted.credentials {
            Credentials::Password(matrix) => client
                .restore_session(matrix)
                .await
                .map_err(|error| self.failed("restore_session", error))?,
            Credentials::OAuth { client_id, user } => client
                .oauth()
                .restore_session(
                    session::oauth_session(client_id, user),
                    matrix_sdk::store::RoomLoadSettings::default(),
                )
                .await
                .map_err(|error| self.failed("restore_session: oauth", error))?,
        }

        let generation = self.session_generation.fetch_add(1, Ordering::SeqCst) + 1;
        self.start_session(client, persisted.homeserver, generation)
            .await?;

        Ok(CommandOk::Restore {
            session: Some(info),
        })
    }

    async fn logout(self: &Arc<Self>) -> Result<CommandOk, CommandErr> {
        self.session_generation.fetch_add(1, Ordering::SeqCst);
        let session = self.take_session().await;
        if let Some(session) = session {
            let result = if session.oauth {
                session
                    .client
                    .oauth()
                    .logout()
                    .await
                    .map_err(|e| e.to_string())
            } else {
                session
                    .client
                    .matrix_auth()
                    .logout()
                    .await
                    .map(|_| ())
                    .map_err(|e| e.to_string())
            };

            if let Err(error) = result {
                tracing::warn!("server-side logout failed, clearing locally anyway: {error}");
            }

            session.sync_service.stop().await;
        }

        self.clear_persisted_session().await;

        Ok(CommandOk::Logout)
    }

    async fn persist(
        &self,
        persisted: &PersistedSession,
        generation: u64,
    ) -> Result<(), CommandErr> {
        let bytes = serde_json::to_vec(persisted)
            .map_err(|error| self.failed("persist: serialize", error))?;

        let _guard = self.session_store_lock.lock().await;
        if self.session_generation.load(Ordering::SeqCst) != generation {
            return Ok(());
        }

        self.sessions
            .save(bytes)
            .await
            .map_err(|error| self.failed("persist: save", error))
    }

    async fn clear_persisted_session(&self) {
        let _guard = self.session_store_lock.lock().await;
        self.sessions.clear().await;
    }

    async fn take_session(&self) -> Option<Session> {
        self.subscriptions.lock().await.clear();
        self.timelines.lock().await.clear();
        self.session.write().await.take()
    }

    async fn start_session(
        self: &Arc<Self>,
        client: matrix_sdk::Client,
        homeserver: String,
        generation: u64,
    ) -> Result<(), CommandErr> {
        let oauth = client.oauth().full_session().is_some();
        self.watch_session(&client, &homeserver, generation);
        self.watch_ephemeral(&client);
        self.watch_encryption(&client);
        self.watch_incoming_verifications(&client);

        let sync_service = session::start_sync(client.clone())
            .await
            .map_err(|error| self.failed("start_sync", error))?;

        let core = self.clone();
        let mut states = sync_service.state();
        // `Subscriber::next` yields only on *change*, so emit the first by hand.
        core.emit(CoreEvent::SyncStatus(sync_status(states.get())));
        rt::spawn(async move {
            while let Some(state) = states.next().await {
                core.emit(CoreEvent::SyncStatus(sync_status(state)));
            }
        });

        *self.session.write().await = Some(Session {
            client,
            sync_service,
            homeserver,
            oauth,
        });

        Ok(())
    }

    /// Two streams, one status, so either firing re-reads both.
    fn watch_encryption(self: &Arc<Self>, client: &matrix_sdk::Client) {
        let mut verification = client.encryption().verification_state();
        let recovery = client.encryption().recovery().state_stream();

        let core = self.clone();
        let watched = client.clone();
        rt::spawn(async move {
            while verification.next().await.is_some() {
                core.emit(CoreEvent::EncryptionStatus {
                    status: encryption_status(&watched).await,
                });
            }
        });

        let core = self.clone();
        let watched = client.clone();
        rt::spawn(async move {
            pin_mut!(recovery);
            while recovery.next().await.is_some() {
                core.emit(CoreEvent::EncryptionStatus {
                    status: encryption_status(&watched).await,
                });
            }
        });
    }

    /// Self-verification travels to-device, verifying someone else as a DM
    /// message, so both need a handler or one direction never prompts.
    fn watch_incoming_verifications(self: &Arc<Self>, client: &matrix_sdk::Client) {
        client.add_event_handler({
            let core = self.clone();
            move |event: ToDeviceKeyVerificationRequestEvent, client: matrix_sdk::Client| {
                let core = core.clone();

                async move {
                    if let Some(request) = client
                        .encryption()
                        .get_verification_request(
                            &event.sender,
                            event.content.transaction_id.as_str(),
                        )
                        .await
                    {
                        core.watch_verification(request);
                    }
                }
            }
        });

        let own_user_id = client.user_id().map(ToOwned::to_owned);

        client.add_event_handler({
            let core = self.clone();
            move |event: OriginalSyncRoomMessageEvent, client: matrix_sdk::Client| {
                let core = core.clone();
                let own_user_id = own_user_id.clone();

                async move {
                    // Our own echoes back, and the command already watches it.
                    if !matches!(event.content.msgtype, MessageType::VerificationRequest(_))
                        || Some(&event.sender) == own_user_id.as_ref()
                    {
                        return;
                    }

                    if let Some(request) = client
                        .encryption()
                        .get_verification_request(&event.sender, event.event_id.as_str())
                        .await
                    {
                        core.watch_verification(request);
                    }
                }
            }
        });
    }

    /// The request and the SAS it becomes are two objects with two state enums.
    /// Both funnel into one event stream keyed by the flow id.
    fn watch_verification(self: &Arc<Self>, request: VerificationRequest) {
        let core = self.clone();
        rt::spawn(async move {
            let user_id = request.other_user_id().to_owned();
            let flow_id = request.flow_id().to_owned();

            let mut changes = request.changes();
            core.emit_verification(&user_id, &flow_id, request_view(&request, &request.state()));

            while let Some(state) = changes.next().await {
                match state {
                    VerificationRequestState::Ready { .. } => {
                        // Two start events would need the spec's tie-break, so
                        // only the accepter starts.
                        if !request.we_started()
                            && let Err(error) = request.start_sas().await
                        {
                            core.failed("verification: start_sas", error);
                        }

                        core.emit_verification(&user_id, &flow_id, VerificationView::Waiting);
                    }

                    VerificationRequestState::Transitioned { verification, .. } => {
                        // QR is not compiled in, so any other flow is
                        // undriveable. Say so instead of spinning.
                        match verification.sas() {
                            Some(sas) => core.watch_sas(user_id.clone(), flow_id.clone(), sas),
                            None => core.emit_verification(
                                &user_id,
                                &flow_id,
                                VerificationView::Cancelled {
                                    reason: "unsupported verification method".to_owned(),
                                },
                            ),
                        }

                        break;
                    }

                    other => {
                        let view = request_view(&request, &other);
                        let done = matches!(
                            view,
                            VerificationView::Done | VerificationView::Cancelled { .. }
                        );
                        core.emit_verification(&user_id, &flow_id, view);

                        if done {
                            break;
                        }
                    }
                }
            }
        });
    }

    fn watch_sas(self: &Arc<Self>, user_id: OwnedUserId, flow_id: String, sas: SasVerification) {
        let core = self.clone();
        rt::spawn(async move {
            let mut changes = sas.changes();
            core.emit_verification(&user_id, &flow_id, sas_view(&sas, &sas.state()));

            while let Some(state) = changes.next().await {
                let view = sas_view(&sas, &state);
                let done = matches!(
                    view,
                    VerificationView::Done | VerificationView::Cancelled { .. }
                );
                core.emit_verification(&user_id, &flow_id, view);

                if done {
                    break;
                }
            }
        });
    }

    fn emit_verification(&self, user_id: &UserId, flow_id: &str, state: VerificationView) {
        self.emit(CoreEvent::Verification {
            user_id: user_id.to_owned(),
            flow_id: flow_id.to_owned(),
            state,
        });
    }

    async fn verification_request(
        &self,
        user_id: &UserId,
        flow_id: &str,
    ) -> Result<VerificationRequest, CommandErr> {
        self.client()
            .await?
            .encryption()
            .get_verification_request(user_id, flow_id)
            .await
            .ok_or(CommandErr::UnknownVerification)
    }

    async fn sas(&self, user_id: &UserId, flow_id: &str) -> Result<SasVerification, CommandErr> {
        self.client()
            .await?
            .encryption()
            .get_verification(user_id, flow_id)
            .await
            .and_then(matrix_sdk::encryption::verification::Verification::sas)
            .ok_or(CommandErr::UnknownVerification)
    }

    /// Ordinary sync events, so one handler each covers every room. Per-room
    /// registration would mean tracking what the UI looks at, and a room list
    /// row needs typing for rooms that are shut.
    fn watch_ephemeral(self: &Arc<Self>, client: &matrix_sdk::Client) {
        let own_user_id = client.user_id().map(ToOwned::to_owned);

        client.add_event_handler({
            let core = self.clone();
            move |event: SyncTypingEvent, room: matrix_sdk::Room| {
                let core = core.clone();
                let own_user_id = own_user_id.clone();

                async move {
                    // `Room::subscribe_to_typing_notifications` filters our own
                    // user out. A raw handler does not, and the echo reads as
                    // "you are typing" in your own room list.
                    let user_ids = event
                        .content
                        .user_ids
                        .into_iter()
                        .filter(|id| Some(id) != own_user_id.as_ref())
                        .collect();

                    core.emit(CoreEvent::Typing {
                        room_id: room.room_id().to_owned(),
                        user_ids,
                    });
                }
            }
        });

        client.add_event_handler({
            let core = self.clone();
            move |event: PresenceEvent| {
                let core = core.clone();

                async move {
                    core.emit(CoreEvent::Presence {
                        user_id: event.sender,
                        presence: match event.content.presence {
                            PresenceState::Online => PresenceView::Online,
                            PresenceState::Offline => PresenceView::Offline,
                            // `PresenceState` is non-exhaustive. Anything added
                            // later reads as away, not online.
                            _ => PresenceView::Unavailable,
                        },
                        status_message: event.content.status_msg,
                        last_active_ago: event.content.last_active_ago.map(Into::into),
                    });
                }
            }
        });
    }

    /// The SDK rotates the OAuth refresh token when it refreshes. Without
    /// re-persisting, the next cold start authenticates with a spent one.
    fn watch_session(
        self: &Arc<Self>,
        client: &matrix_sdk::Client,
        homeserver: &str,
        generation: u64,
    ) {
        let saver = self.clone();
        let saved_homeserver = homeserver.to_owned();

        let save = move |client: matrix_sdk::Client| {
            let Some(persisted) = session::current_session(&client, saved_homeserver.clone())
            else {
                return Ok(());
            };

            // The callback is synchronous and the store is not. A failure only
            // costs the next restore, so it is logged.
            let core = saver.clone();
            rt::spawn(async move {
                if let Err(error) = core.persist(&persisted, generation).await {
                    tracing::error!("could not persist refreshed session: {error:?}");
                }
            });

            Ok(())
        };

        let reload = move |client: matrix_sdk::Client| {
            client
                .session_tokens()
                .ok_or_else(|| "no session tokens to reload".into())
        };

        if let Err(error) = client.set_session_callbacks(Box::new(reload), Box::new(save)) {
            tracing::error!("could not install session callbacks: {error}");
        }

        let core = self.clone();
        let mut changes = client.subscribe_to_session_changes();
        rt::spawn(async move {
            while let Ok(change) = changes.recv().await {
                // The session is over. No retry will fix it.
                if let matrix_sdk::SessionChange::UnknownToken(_) = change {
                    if core
                        .session_generation
                        .compare_exchange(
                            generation,
                            generation + 1,
                            Ordering::SeqCst,
                            Ordering::SeqCst,
                        )
                        .is_err()
                    {
                        return;
                    }

                    if let Some(session) = core.take_session().await {
                        session.sync_service.stop().await;
                    }
                    core.clear_persisted_session().await;
                    core.emit(CoreEvent::SessionEnded {
                        reason: "token_rejected".to_owned(),
                    });
                }
            }
        });
    }

    // subscriptions

    async fn subscribe_room_list(self: &Arc<Self>) -> Result<CommandOk, CommandErr> {
        let sync_service = {
            let guard = self.session.read().await;
            guard
                .as_ref()
                .ok_or(CommandErr::NotLoggedIn)?
                .sync_service
                .clone()
        };

        let subscription = self.allocate_subscription();
        let core = self.clone();

        let client = {
            let guard = self.session.read().await;
            guard
                .as_ref()
                .ok_or(CommandErr::NotLoggedIn)?
                .client
                .clone()
        };

        let task = rt::spawn(async move {
            let room_list = match sync_service.room_list_service().all_rooms().await {
                Ok(room_list) => room_list,
                Err(error) => {
                    tracing::error!("all_rooms failed: {error}");
                    return;
                }
            };

            let (stream, controller) = room_list.entries_with_dynamic_adapters(ROOM_LIST_PAGE_SIZE);
            controller.set_filter(Box::new(new_filter_non_left()));

            // Stable over a stream's life, so resolved once per room.
            let mut room_cache: HashMap<OwnedRoomId, view::RoomInfo> = HashMap::new();

            pin_mut!(stream);
            while let Some(diffs) = stream.next().await {
                view::prime_display_names(&diffs).await;
                for diff in &diffs {
                    view::enrich_room_fields(&client, diff, &mut room_cache).await;
                }
                core.emit(CoreEvent::RoomListDiff {
                    subscription,
                    diffs: diffs
                        .into_iter()
                        .map(|diff| {
                            view::map_diff(diff, |item| view::room_summary(item, &room_cache))
                        })
                        .collect(),
                });
            }
        });

        self.subscriptions.lock().await.insert(subscription, task);

        // The filter makes the stream open with a `Reset` carrying everything.
        Ok(CommandOk::SubscribeRoomList {
            subscription,
            rooms: Vec::new(),
        })
    }

    async fn subscribe_timeline(
        self: &Arc<Self>,
        room_id: OwnedRoomId,
    ) -> Result<CommandOk, CommandErr> {
        let timeline = self.timeline(&room_id).await?;
        let (items, stream) = timeline.subscribe().await;

        let subscription = self.allocate_subscription();
        let core = self.clone();

        let task = rt::spawn(async move {
            pin_mut!(stream);
            while let Some(diffs) = stream.next().await {
                core.emit(CoreEvent::TimelineDiff {
                    subscription,
                    diffs: diffs
                        .into_iter()
                        .map(|diff| view::map_diff(diff, view::timeline_item))
                        .collect(),
                });
            }
        });

        self.subscriptions.lock().await.insert(subscription, task);

        Ok(CommandOk::SubscribeTimeline {
            subscription,
            items: items.iter().map(view::timeline_item).collect(),
        })
    }

    async fn client(&self) -> Result<matrix_sdk::Client, CommandErr> {
        let guard = self.session.read().await;
        Ok(guard
            .as_ref()
            .ok_or(CommandErr::NotLoggedIn)?
            .client
            .clone())
    }

    async fn room(&self, room_id: &OwnedRoomId) -> Result<matrix_sdk::Room, CommandErr> {
        self.client()
            .await?
            .get_room(room_id)
            .ok_or(CommandErr::UnknownRoom)
    }

    /// Authenticated media needs the access token, so the fetch happens here.
    ///
    /// # Errors
    ///
    /// Returns an error when the media URI is invalid, the user is logged out,
    /// or the homeserver rejects the request.
    pub async fn media_thumbnail(
        &self,
        source: String,
        width: u32,
        height: u32,
    ) -> Result<Vec<u8>, CommandErr> {
        let uri = OwnedMxcUri::from(source);
        if uri.parts().is_err() {
            return Err(CommandErr::InvalidMedia);
        }

        let request = MediaRequestParameters {
            source: MediaSource::Plain(uri),
            format: MediaFormat::Thumbnail(MediaThumbnailSettings::new(
                width.into(),
                height.into(),
            )),
        };

        self.client()
            .await?
            .media()
            .get_media_content(&request, true)
            .await
            .map_err(|error| self.failed("media_thumbnail", error))
    }

    /// For the avatar commands. Not for attachments: `send_attachment` keeps the
    /// upload and the event in one queue entry so they retry together.
    ///
    /// # Errors
    ///
    /// Returns an error when the MIME type is invalid, the user is logged out,
    /// or the upload fails.
    pub async fn upload_media(&self, mime: String, bytes: Vec<u8>) -> Result<String, CommandErr> {
        let mime: Mime = mime.parse().map_err(|_| CommandErr::InvalidMedia)?;

        let response = self
            .client()
            .await?
            .media()
            .upload(&mime, bytes, None)
            .await
            .map_err(|error| self.failed("upload_media", error))?;

        Ok(response.content_uri.to_string())
    }

    /// Returns once queued, not once uploaded. Progress and failure arrive as
    /// `send_state` on the local echo.
    ///
    /// # Errors
    ///
    /// Returns an error when an attachment field is invalid, the room is
    /// unavailable, or queuing the upload fails.
    pub async fn send_attachment(
        &self,
        room_id: String,
        filename: String,
        mime: String,
        bytes: Vec<u8>,
        caption: Option<String>,
        in_reply_to: Option<String>,
    ) -> Result<(), CommandErr> {
        let room_id = OwnedRoomId::try_from(room_id).map_err(|_| CommandErr::UnknownRoom)?;
        let mime: Mime = mime.parse().map_err(|_| CommandErr::InvalidMedia)?;

        let in_reply_to = match in_reply_to {
            Some(id) => Some(OwnedEventId::try_from(id).map_err(|_| CommandErr::UnknownRoom)?),
            None => None,
        };

        let config = AttachmentConfig {
            caption: caption.map(TextMessageEventContent::plain),
            in_reply_to,
            ..AttachmentConfig::default()
        };

        self.timeline(&room_id)
            .await?
            .send_attachment(AttachmentSource::Data { bytes, filename }, mime, config)
            // Inline, a dropped connection loses the file. Queued, it retries.
            .use_send_queue()
            .await
            .map_err(|error| self.failed("send_attachment", error))?;

        Ok(())
    }

    /// Cached: building one twice gives the UI two streams for one room.
    #[allow(clippy::arc_with_non_send_sync)] // Matrix timelines are single-threaded on WASM
    async fn timeline(&self, room_id: &OwnedRoomId) -> Result<Arc<Timeline>, CommandErr> {
        if let Some(timeline) = self.timelines.lock().await.get(room_id) {
            return Ok(timeline.clone());
        }

        let room = self.room(room_id).await?;
        let timeline = Arc::new(
            room.timeline()
                .await
                .map_err(|error| self.failed("build timeline", error))?,
        );

        self.timelines
            .lock()
            .await
            .insert(room_id.clone(), timeline.clone());

        Ok(timeline)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn commands_before_login_are_rejected() {
        let (core, _rx) = Core::new("test", Box::new(store::MemorySessionStore::default()));
        assert!(matches!(
            core.dispatch(Command::SubscribeRoomList).await,
            Err(CommandErr::NotLoggedIn)
        ));
    }
}

#[cfg(test)]
// These ignored network tests intentionally panic with context on an unexpected
// server response; production command paths remain panic-free.
#[allow(clippy::expect_used, clippy::panic)]
mod live_tests {
    use super::*;

    #[tokio::test]
    #[ignore = "hits matrix.org"]
    async fn discovers_a_real_homeserver() {
        let (core, _rx) = Core::new(
            "sable-next-discover",
            Box::new(store::MemorySessionStore::default()),
        );
        let result = core
            .dispatch(Command::DiscoverHomeserver {
                server_name: "matrix.org".into(),
            })
            .await
            .expect("discovery should succeed");

        let CommandOk::DiscoverHomeserver { homeserver } = result else {
            panic!("wrong response variant");
        };
        assert!(homeserver.contains("matrix.org"), "got {homeserver}");
    }

    #[tokio::test]
    #[ignore = "hits matrix.org"]
    async fn rejects_bad_credentials() {
        let dir = std::env::temp_dir().join("sable-next-badlogin");
        let (core, _rx) = Core::new(
            dir.to_string_lossy().into_owned(),
            Box::new(store::MemorySessionStore::default()),
        );
        let error = core
            .dispatch(Command::Login {
                homeserver: "https://matrix.org".into(),
                username: "sable-next-does-not-exist".into(),
                password: "definitely-wrong".into(),
            })
            .await
            .expect_err("login should fail");

        assert!(matches!(error, CommandErr::Denied), "got {error:?}");
    }
}
