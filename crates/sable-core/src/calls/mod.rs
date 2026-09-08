mod keys;
mod membership;
mod notify;
mod runtime;
mod sfu;
mod sticky;

use std::sync::Arc;
use std::time::Duration;

use matrix_sdk::executor::{JoinHandleExt, spawn};
use matrix_sdk::ruma::api::client::delayed_events::{
    DelayParameters, delayed_state_event, update_delayed_event,
};
use matrix_sdk::ruma::api::error::ErrorKind;
use matrix_sdk::ruma::events::StateEventType;
use matrix_sdk::ruma::events::call::member::{CallMemberEventContent, CallMemberStateKey};
use matrix_sdk::ruma::serde::Raw;
use matrix_sdk::ruma::{DeviceId, EventId, OwnedRoomId, UserId};
use matrix_sdk::{Client, Room};

use crate::protocol::{
    CallMemberView, CallMode, CallSessionId, CallSupportView, CommandErr, CommandOk, CoreEvent,
};
use crate::{CallSession, Core};

use membership::CallMember;
use sfu::ProvisionError;

const HANGUP_DELAY: Duration = Duration::from_secs(20);
const HANGUP_POSTPONE_INTERVAL: Duration = Duration::from_secs(5);
const HANGUP_RETRY_BACKOFF: Duration = Duration::from_secs(1);
const HANGUP_RETRY_BUDGET: Duration = Duration::from_secs(12);
const USE_KEY_DELAY: Duration = Duration::from_secs(1);

const APPLICATION_SUFFIX: &str = "m.call";

fn membership_state_key(
    user_id: &UserId,
    device_id: &DeviceId,
    room_version: &str,
) -> CallMemberStateKey {
    let namespaced_keys = room_version == "org.matrix.msc3757"
        || room_version.starts_with("org.matrix.msc3757.")
        || room_version == "org.matrix.msc3779"
        || room_version.starts_with("org.matrix.msc3779.");
    CallMemberStateKey::new(
        user_id.to_owned(),
        Some(format!("{device_id}_{APPLICATION_SUFFIX}")),
        !namespaced_keys,
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
            identity: member.identity.clone(),
            backend_id: None,
        })
        .collect()
}

impl Core {
    pub(crate) async fn join_call(
        self: &Arc<Self>,
        room_id: OwnedRoomId,
        livekit_service_url: Option<String>,
        mode: Option<CallMode>,
    ) -> Result<CommandOk, CommandErr> {
        runtime::join(self, room_id, livekit_service_url, mode).await
    }

    pub(crate) async fn call_support(&self, room_id: OwnedRoomId) -> Result<CommandOk, CommandErr> {
        let room = self.room(&room_id).await?;
        let user_id = room
            .client()
            .user_id()
            .ok_or(CommandErr::NotLoggedIn)?
            .to_owned();

        let members = membership::active_members(&room).await;
        let mut has_focus = self.resolve_focus(&members, None, &room).await.is_some();
        let levels = room.power_levels_or_default().await;
        let state_allowed = levels.user_can_send_state(&user_id, StateEventType::CallMember);
        let sticky_available = (!has_focus || !state_allowed)
            && room
                .client()
                .unstable_features()
                .await
                .is_ok_and(|features| features.contains(&"org.matrix.msc4354".into()));
        if !has_focus && sticky_available {
            let mut sync = sticky::StickySync::new(self.allocate_subscription().0);
            if let Ok(events) = sync.sync(&room, Duration::ZERO).await {
                let mut sticky_members = membership::StickyMemberships::default();
                for event in events {
                    sticky_members.apply(&event, keys::now_ms());
                }
                has_focus =
                    !membership::advertised_service_urls(&sticky_members.members(keys::now_ms()))
                        .is_empty();
            }
        }
        let can_join = state_allowed
            || (sticky_available && levels.user_can_send_message(&user_id, "m.rtc.member".into()));

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

    pub(crate) async fn end_all_calls(&self) {
        let calls: Vec<CallSession> = self
            .call_sessions
            .lock()
            .await
            .drain()
            .map(|(_, call)| call)
            .collect();

        for mut call in calls {
            drop(call.updates.take());
            drop(call.postpone.take());
            let result = match call.delay_id.clone() {
                Some(delay_id) => match self.fire_hangup(delay_id).await {
                    Ok(result) => Ok(result),
                    Err(_) => self.send_left_membership(&call).await,
                },
                None => self.send_left_membership(&call).await,
            };
            if let Err(error) = result {
                tracing::warn!(?error, room_id = %call.room_id, "could not hang up on session end");
            }
        }
    }

    pub(crate) async fn leave_call(&self, session: CallSessionId) -> Result<CommandOk, CommandErr> {
        let mut call = self
            .call_sessions
            .lock()
            .await
            .remove(&session)
            .ok_or(CommandErr::UnknownCall)?;

        drop(call.updates.take());
        drop(call.postpone.take());
        match call.delay_id.clone() {
            Some(delay_id) => match self.fire_hangup(delay_id).await {
                Ok(result) => Ok(result),
                Err(_) => self.send_left_membership(&call).await,
            },
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
        if let Some(member_id) = &call.sticky_member {
            let room = self.room(&call.room_id).await?;
            sticky::send(
                &room.client(),
                &room,
                serde_json::json!({"msc4354_sticky_key": member_id}),
            )
            .await
            .map_err(|error| self.room_error("leave_call", error))?;
            return Ok(CommandOk::LeaveCall);
        }
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

        let first = membership_state_key(user, device_id!("AAAAAAAA"), "12");
        let second = membership_state_key(user, device_id!("BBBBBBBB"), "12");

        assert_eq!(first.as_ref(), "_@erwan:localhost_AAAAAAAA_m.call");
        assert_ne!(
            first.as_ref(),
            second.as_ref(),
            "two devices sharing a state key means the second evicts the first"
        );
    }

    #[test]
    fn test_experimental_room_versions_use_namespaced_state_keys() {
        for version in ["org.matrix.msc3757", "org.matrix.msc3779.10"] {
            let key =
                membership_state_key(user_id!("@user:example.org"), device_id!("DEVICE"), version);
            assert_eq!(key.as_ref(), "@user:example.org_DEVICE_m.call");
        }
    }

    #[test]
    fn test_the_state_key_carries_the_users_own_id() {
        let key = membership_state_key(user_id!("@erwan:localhost"), device_id!("DEVICEID"), "12");

        assert_eq!(key.user_id(), user_id!("@erwan:localhost"));
    }

    #[test]
    fn test_a_member_view_carries_the_identity_the_sfu_granted() {
        let views = member_views(&[CallMember {
            user_id: owned_user_id!("@erwan:localhost"),
            device_id: "LAPTOP".into(),
            member_id: None,
            identity: "@erwan:localhost:LAPTOP".to_owned(),
            mode: crate::protocol::CallMode::Legacy,
            created_ts: 0,
            expires_at_ms: None,
            foci: Vec::new(),
        }]);

        assert_eq!(views[0].identity, "@erwan:localhost:LAPTOP");
        assert_eq!(views[0].device_id, "LAPTOP");
    }
}
