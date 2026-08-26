mod keys;
mod membership;
mod notify;
mod sfu;

use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::Duration;

use matrix_sdk::event_handler::EventHandlerDropGuard;
use matrix_sdk::executor::{JoinHandleExt, spawn};
use matrix_sdk::ruma::api::client::delayed_events::{
    DelayParameters, delayed_state_event, update_delayed_event,
};
use matrix_sdk::ruma::api::error::ErrorKind;
use matrix_sdk::ruma::events::StateEventType;
use matrix_sdk::ruma::events::call::member::{
    ActiveFocus, ActiveLivekitFocus, Application, CallApplicationContent, CallMemberEventContent,
    CallMemberStateKey, CallScope, Focus, LivekitFocus,
};
use matrix_sdk::ruma::serde::Raw;
use matrix_sdk::ruma::{DeviceId, EventId, OwnedDeviceId, OwnedRoomId, UserId};
use matrix_sdk::{Client, Room};
use tokio::sync::Mutex;

use crate::protocol::{
    CallMemberView, CallSessionId, CallSupportView, CommandErr, CommandOk, CoreEvent,
};
use crate::{CallSession, Core};

use keys::{KeyDistributor, Rolled};
use membership::CallMember;
use sfu::ProvisionError;

const HANGUP_DELAY: Duration = Duration::from_secs(20);
const HANGUP_POSTPONE_INTERVAL: Duration = Duration::from_secs(5);
const HANGUP_RETRY_BACKOFF: Duration = Duration::from_secs(1);
const HANGUP_RETRY_BUDGET: Duration = Duration::from_secs(12);
const ADVERTISED_MEMBERSHIP_EXPIRY: Duration = Duration::from_hours(4);
const USE_KEY_DELAY: Duration = Duration::from_secs(1);

const APPLICATION_SUFFIX: &str = "m.call";

fn membership_state_key(user_id: &UserId, device_id: &DeviceId) -> CallMemberStateKey {
    CallMemberStateKey::new(
        user_id.to_owned(),
        Some(format!("{device_id}_{APPLICATION_SUFFIX}")),
        false,
    )
}

fn joined_membership(
    room_id: &OwnedRoomId,
    device_id: OwnedDeviceId,
    livekit_service_url: String,
) -> CallMemberEventContent {
    CallMemberEventContent::new(
        Application::Call(CallApplicationContent::new(
            room_id.to_string(),
            CallScope::Room,
        )),
        device_id,
        ActiveFocus::Livekit(ActiveLivekitFocus::new()),
        vec![Focus::Livekit(LivekitFocus::new(
            room_id.to_string(),
            livekit_service_url,
        ))],
        None,
        Some(ADVERTISED_MEMBERSHIP_EXPIRY),
    )
}

fn left_membership() -> CallMemberEventContent {
    CallMemberEventContent::new_empty(None)
}

fn member_views(members: &[CallMember]) -> Vec<CallMemberView> {
    members
        .iter()
        .map(|member| CallMemberView {
            user_id: member.user_id.clone(),
            device_id: member.device_id.to_string(),
            identity: sfu::livekit_identity(&member.user_id, &member.device_id),
        })
        .collect()
}

impl Core {
    pub(crate) async fn join_call(
        self: &Arc<Self>,
        room_id: OwnedRoomId,
        livekit_service_url: Option<String>,
    ) -> Result<CommandOk, CommandErr> {
        let generation = self.session_generation.load(Ordering::SeqCst);
        let room = self.room(&room_id).await?;
        let client = room.client();
        let user_id = client.user_id().ok_or(CommandErr::NotLoggedIn)?.to_owned();
        let device_id = client
            .device_id()
            .ok_or(CommandErr::NotLoggedIn)?
            .to_owned();

        let existing = membership::active_members(&room).await;
        let was_running = existing
            .iter()
            .any(|member| !member.is_own(&user_id, &device_id));

        let service_url = self
            .resolve_focus(&existing, livekit_service_url, &room)
            .await
            .ok_or(CommandErr::NoCallFocus)?;

        let state_key = membership_state_key(&user_id, &device_id);
        let membership = joined_membership(&room_id, device_id.clone(), service_url.clone());

        let delay_id = self.schedule_hangup(&room_id, &state_key).await;
        let postpone = delay_id.clone().map(|id| self.spawn_postpone_loop(id));

        let membership_event_id = room
            .send_state_event_for_key(&state_key, membership)
            .await
            .map_err(|error| self.room_error("join_call", error))?
            .event_id;

        if !was_running {
            self.announce_call(&room, &membership_event_id).await;
        }

        let provisioned = match sfu::provision(&room, &service_url, &device_id).await {
            Ok(provisioned) => provisioned,
            Err(error) => {
                self.retract_membership(&room, &state_key, delay_id).await;
                return Err(self.provision_error(&service_url, &error));
            }
        };

        let encrypt_media = room
            .latest_encryption_state()
            .await
            .is_ok_and(|state| state.is_encrypted());
        let session = CallSessionId(self.allocate_subscription().0);

        let distributor = encrypt_media.then(|| {
            Arc::new(Mutex::new(KeyDistributor::new(
                room_id.clone(),
                user_id.clone(),
                device_id.clone(),
            )))
        });

        let mut handlers = vec![self.watch_call_memberships(
            &client,
            generation,
            session,
            room_id.clone(),
            distributor.clone(),
        )];
        if encrypt_media {
            handlers.push(self.watch_call_keys(&client, generation, session, room_id.clone()));
        }

        if self.session_generation.load(Ordering::SeqCst) != generation {
            drop(postpone);
            self.retract_membership(&room, &state_key, delay_id).await;
            return Err(CommandErr::NotLoggedIn);
        }

        self.call_sessions.lock().await.insert(
            session,
            CallSession {
                room_id,
                state_key,
                _postpone: postpone,
                delay_id,
                _handlers: handlers,
            },
        );

        self.refresh_call(generation, session, &room, distributor.as_ref())
            .await;

        Ok(CommandOk::JoinCall {
            session,
            url: provisioned.url,
            jwt: provisioned.jwt,
            identity: sfu::livekit_identity(&user_id, &device_id),
            encrypt_media,
        })
    }

    pub(crate) async fn call_support(&self, room_id: OwnedRoomId) -> Result<CommandOk, CommandErr> {
        let room = self.room(&room_id).await?;
        let user_id = room
            .client()
            .user_id()
            .ok_or(CommandErr::NotLoggedIn)?
            .to_owned();

        let members = membership::active_members(&room).await;
        let has_focus = self.resolve_focus(&members, None, &room).await.is_some();
        let can_join = room
            .power_levels_or_default()
            .await
            .user_can_send_state(&user_id, StateEventType::CallMember);

        Ok(CommandOk::CallSupport(CallSupportView {
            has_focus,
            can_join,
        }))
    }

    async fn resolve_focus(
        &self,
        members: &[CallMember],
        configured: Option<String>,
        room: &Room,
    ) -> Option<String> {
        if let Some(url) = membership::advertised_service_urls(members)
            .into_iter()
            .next()
        {
            return Some(url);
        }

        if let Some(url) = configured.filter(|url| !url.trim().is_empty()) {
            return Some(url);
        }

        let server = room.client().server()?.clone();
        sfu::well_known_service_urls(&server)
            .await
            .into_iter()
            .next()
    }

    pub(crate) fn watch_incoming_calls(self: &Arc<Self>, client: &Client, generation: u64) {
        let Some(own_user_id) = client.user_id().map(ToOwned::to_owned) else {
            return;
        };

        client.add_event_handler({
            let core = self.clone();
            move |event: notify::OriginalSyncRtcNotificationEvent, room: Room| {
                let core = core.clone();
                let own_user_id = own_user_id.clone();

                async move {
                    let Some(incoming) = notify::accept(
                        &event.content,
                        &event.sender,
                        &own_user_id,
                        event.origin_server_ts.get().into(),
                        keys::now_ms(),
                    ) else {
                        return;
                    };

                    core.emit_if_current(
                        generation,
                        CoreEvent::IncomingCall {
                            room_id: room.room_id().to_owned(),
                            notification_event_id: event.event_id.to_string(),
                            sender: event.sender,
                            ring: incoming.kind == notify::NotificationKind::Ring,
                            expires_at_ms: incoming.expires_at,
                        },
                    );
                }
            }
        });

        client.add_event_handler({
            let core = self.clone();
            move |event: notify::OriginalSyncRtcDeclineEvent| {
                let core = core.clone();

                async move {
                    core.emit_if_current(
                        generation,
                        CoreEvent::IncomingCallEnded {
                            notification_event_id: event.content.relates_to.event_id.to_string(),
                        },
                    );
                }
            }
        });
    }

    async fn retract_membership(
        &self,
        room: &Room,
        state_key: &CallMemberStateKey,
        delay_id: Option<String>,
    ) {
        if let Some(delay_id) = delay_id
            && self.fire_hangup(delay_id).await.is_ok()
        {
            return;
        }

        if let Err(error) = room
            .send_state_event_for_key(state_key, left_membership())
            .await
        {
            tracing::warn!(?error, "could not retract a call membership");
        }
    }

    async fn announce_call(self: &Arc<Self>, room: &Room, membership_event_id: &EventId) {
        let kind = if room.is_direct().await.unwrap_or(false) {
            notify::NotificationKind::Ring
        } else {
            notify::NotificationKind::Notification
        };

        let content = notify::notification_content(membership_event_id, kind);
        let Ok(raw) = Raw::new(&content) else {
            return;
        };

        if let Err(error) = room
            .send_queue()
            .send_raw(
                raw.cast_unchecked(),
                notify::NOTIFICATION_EVENT_TYPE.to_owned(),
            )
            .await
        {
            tracing::warn!(?error, "could not announce the call");
        }
    }

    pub(crate) async fn decline_call(
        &self,
        room_id: OwnedRoomId,
        notification_event_id: String,
    ) -> Result<CommandOk, CommandErr> {
        let event_id = EventId::parse(&notification_event_id)
            .map_err(|error| self.failed("decline_call", error))?;
        let content = notify::decline_content(&event_id);
        let raw = Raw::new(&content).map_err(|error| self.failed("decline_call", error))?;

        self.room(&room_id)
            .await?
            .send_queue()
            .send_raw(raw.cast_unchecked(), notify::DECLINE_EVENT_TYPE.to_owned())
            .await
            .map_err(|error| self.failed("decline_call", error))?;

        Ok(CommandOk::DeclineCall)
    }

    fn provision_error(&self, service_url: &str, error: &ProvisionError) -> CommandErr {
        match error {
            ProvisionError::NotLoggedIn => CommandErr::NotLoggedIn,
            ProvisionError::Unreachable | ProvisionError::OpenIdUnavailable => {
                tracing::warn!(service_url, "{error}");
                CommandErr::Unavailable
            }
            ProvisionError::Refused(_) | ProvisionError::MalformedResponse => {
                self.failed("join_call: provision", format!("{service_url}: {error}"))
            }
        }
    }

    async fn refresh_call(
        self: &Arc<Self>,
        generation: u64,
        session: CallSessionId,
        room: &Room,
        distributor: Option<&Arc<Mutex<KeyDistributor>>>,
    ) {
        let members = membership::active_members(room).await;
        self.emit_if_current(
            generation,
            CoreEvent::CallMembers {
                session,
                members: member_views(&members),
            },
        );

        let Some(distributor) = distributor else {
            return;
        };

        let rolled = distributor.lock().await.roll(room, &members).await;
        match rolled {
            Rolled::Nothing | Rolled::Shared => {}
            Rolled::Rotated {
                announcement,
                first,
            } => {
                let event = CoreEvent::CallEncryptionKey {
                    session,
                    identity: announcement.identity,
                    key_index: announcement.index,
                    key: announcement.encoded,
                    own: true,
                };

                if first {
                    self.emit(event);
                } else {
                    let core = self.clone();
                    self.track_session_task(
                        spawn(async move {
                            matrix_sdk::sleep::sleep(USE_KEY_DELAY).await;
                            core.emit(event);
                        })
                        .abort_on_drop(),
                    );
                }
            }
        }
    }

    fn watch_call_memberships(
        self: &Arc<Self>,
        client: &Client,
        generation: u64,
        session: CallSessionId,
        room_id: OwnedRoomId,
        distributor: Option<Arc<Mutex<KeyDistributor>>>,
    ) -> EventHandlerDropGuard {
        let core = self.clone();
        let handle = client.add_event_handler(
            move |_: matrix_sdk::ruma::events::call::member::SyncCallMemberEvent, room: Room| {
                let core = core.clone();
                let room_id = room_id.clone();
                let distributor = distributor.clone();
                async move {
                    if *room.room_id() != *room_id {
                        return;
                    }
                    core.refresh_call(generation, session, &room, distributor.as_ref())
                        .await;
                }
            },
        );
        client.event_handler_drop_guard(handle)
    }

    fn watch_call_keys(
        self: &Arc<Self>,
        client: &Client,
        generation: u64,
        session: CallSessionId,
        room_id: OwnedRoomId,
    ) -> EventHandlerDropGuard {
        let core = self.clone();
        let handle =
            client.add_event_handler(
                move |event: keys::ToDeviceCallEncryptionKeysEvent,
                      encryption_info: Option<
                    matrix_sdk::deserialized_responses::EncryptionInfo,
                >| {
                    let core = core.clone();
                    let room_id = room_id.clone();
                    async move {
                        if event.content.room_id != room_id {
                            return;
                        }

                        let Some(info) = encryption_info else {
                            tracing::warn!(
                                sender = %event.sender,
                                "call media key arrived in the clear, dropping it"
                            );
                            return;
                        };

                        let Some(device_id) = info.sender_device.as_ref() else {
                            tracing::warn!("call media key has no verified sending device");
                            return;
                        };

                        if info.sender != event.sender
                            || device_id.as_str() != event.content.member.claimed_device_id
                        {
                            tracing::warn!(
                                claimed = event.content.member.claimed_device_id,
                                "call media key claims a device it was not sent from"
                            );
                            return;
                        }

                        if keys::decode_key(&event.content.keys.key).is_none() {
                            tracing::warn!("call media key is not decodable base64");
                            return;
                        }

                        core.emit_if_current(
                            generation,
                            CoreEvent::CallEncryptionKey {
                                session,
                                identity: sfu::livekit_identity(&info.sender, device_id),
                                key_index: event.content.keys.index,
                                key: event.content.keys.key,
                                own: false,
                            },
                        );
                    }
                },
            );
        client.event_handler_drop_guard(handle)
    }

    pub(crate) async fn end_all_calls(&self) {
        let calls: Vec<CallSession> = self
            .call_sessions
            .lock()
            .await
            .drain()
            .map(|(_, call)| call)
            .collect();

        for call in calls {
            let result = match call.delay_id.clone() {
                Some(delay_id) => self.fire_hangup(delay_id).await,
                None => self.send_left_membership(&call).await,
            };
            if let Err(error) = result {
                tracing::warn!(?error, room_id = %call.room_id, "could not hang up on session end");
            }
        }
    }

    pub(crate) async fn leave_call(&self, session: CallSessionId) -> Result<CommandOk, CommandErr> {
        let call = self
            .call_sessions
            .lock()
            .await
            .remove(&session)
            .ok_or(CommandErr::UnknownCall)?;

        match call.delay_id.clone() {
            Some(delay_id) => self.fire_hangup(delay_id).await,
            None => self.send_left_membership(&call).await,
        }
    }

    async fn fire_hangup(&self, delay_id: String) -> Result<CommandOk, CommandErr> {
        self.client()
            .await?
            .send(update_delayed_event::unstable_v1::Request::new(
                delay_id,
                update_delayed_event::UpdateAction::Send,
            ))
            .await
            .map_err(|error| self.failed("leave_call", error))?;

        Ok(CommandOk::LeaveCall)
    }

    async fn send_left_membership(&self, call: &CallSession) -> Result<CommandOk, CommandErr> {
        self.room(&call.room_id)
            .await?
            .send_state_event_for_key(&call.state_key, left_membership())
            .await
            .map_err(|error| self.room_error("leave_call", error))?;

        Ok(CommandOk::LeaveCall)
    }

    async fn schedule_hangup(
        &self,
        room_id: &OwnedRoomId,
        state_key: &CallMemberStateKey,
    ) -> Option<String> {
        let request = delayed_state_event::unstable::Request::new(
            room_id.clone(),
            state_key.as_ref().to_owned(),
            DelayParameters::Timeout {
                timeout: HANGUP_DELAY,
            },
            &left_membership(),
        )
        .ok()?;

        match self.client().await.ok()?.send(request).await {
            Ok(response) => Some(response.delay_id),
            Err(error) => {
                tracing::warn!(
                    ?error,
                    "delayed events unavailable, membership will expire instead of hanging up"
                );
                None
            }
        }
    }

    async fn postpone_hangup(&self, delay_id: &str) -> bool {
        let mut backoff = HANGUP_RETRY_BACKOFF;
        let mut spent = Duration::ZERO;

        loop {
            let Ok(client) = self.client().await else {
                return false;
            };

            let Err(error) = client
                .send(update_delayed_event::unstable_v1::Request::new(
                    delay_id.to_owned(),
                    update_delayed_event::UpdateAction::Restart,
                ))
                .await
            else {
                return true;
            };

            if matches!(
                error.client_api_error_kind(),
                Some(ErrorKind::NotFound | ErrorKind::Forbidden)
            ) {
                tracing::warn!(?error, "the delayed hangup is gone, stopping");
                return false;
            }

            if spent.saturating_add(backoff) >= HANGUP_RETRY_BUDGET {
                tracing::warn!(
                    ?error,
                    "could not postpone the call hangup in time, stopping"
                );
                return false;
            }

            matrix_sdk::sleep::sleep(backoff).await;
            spent = spent.saturating_add(backoff);
            backoff = backoff.saturating_mul(2);
        }
    }

    fn spawn_postpone_loop(self: &Arc<Self>, delay_id: String) -> crate::Task {
        let core = self.clone();

        spawn(async move {
            loop {
                matrix_sdk::sleep::sleep(HANGUP_POSTPONE_INTERVAL).await;

                if !core.postpone_hangup(&delay_id).await {
                    return;
                }
            }
        })
        .abort_on_drop()
    }
}

#[cfg(test)]
mod tests {
    use matrix_sdk::ruma::{device_id, owned_user_id, user_id};

    use super::membership::CallMember;
    use super::{member_views, membership_state_key};

    #[test]
    fn test_a_membership_is_keyed_per_device() {
        let user = user_id!("@erwan:localhost");

        let first = membership_state_key(user, device_id!("AAAAAAAA"));
        let second = membership_state_key(user, device_id!("BBBBBBBB"));

        assert_eq!(first.as_ref(), "@erwan:localhost_AAAAAAAA_m.call");
        assert_ne!(
            first.as_ref(),
            second.as_ref(),
            "two devices sharing a state key means the second evicts the first"
        );
    }

    #[test]
    fn test_the_state_key_carries_the_users_own_id() {
        let key = membership_state_key(user_id!("@erwan:localhost"), device_id!("DEVICEID"));

        assert_eq!(key.user_id(), user_id!("@erwan:localhost"));
    }

    #[test]
    fn test_a_member_view_carries_the_identity_the_sfu_granted() {
        let views = member_views(&[CallMember {
            user_id: owned_user_id!("@erwan:localhost"),
            device_id: "LAPTOP".into(),
            created_ts: 0,
            foci: Vec::new(),
        }]);

        assert_eq!(views[0].identity, "@erwan:localhost:LAPTOP");
        assert_eq!(views[0].device_id, "LAPTOP");
    }
}
