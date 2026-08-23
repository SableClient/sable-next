use std::sync::Arc;
use std::time::Duration;

use matrix_sdk::executor::{JoinHandleExt, spawn};
use matrix_sdk::ruma::api::client::account::request_openid_token;
use matrix_sdk::ruma::api::client::delayed_events::{
    DelayParameters, delayed_state_event, update_delayed_event,
};
use matrix_sdk::ruma::events::call::member::{
    ActiveFocus, ActiveLivekitFocus, Application, CallApplicationContent, CallMemberEventContent,
    CallMemberStateKey, CallScope, Focus, LivekitFocus,
};
use matrix_sdk::ruma::{DeviceId, OwnedDeviceId, OwnedRoomId, UserId};

use crate::protocol::{CallSessionId, CommandErr, CommandOk, OpenIdTokenView};
use crate::{CallSession, Core};

const HANGUP_DELAY: Duration = Duration::from_secs(20);
const HANGUP_POSTPONE_INTERVAL: Duration = Duration::from_secs(5);
const ADVERTISED_MEMBERSHIP_EXPIRY: Duration = Duration::from_hours(4);

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

impl Core {
    pub(crate) async fn join_call(
        self: &Arc<Self>,
        room_id: OwnedRoomId,
        livekit_service_url: String,
    ) -> Result<CommandOk, CommandErr> {
        let room = self.room(&room_id).await?;
        let client = room.client();
        let user_id = client.user_id().ok_or(CommandErr::NotLoggedIn)?.to_owned();
        let device_id = client
            .device_id()
            .ok_or(CommandErr::NotLoggedIn)?
            .to_owned();

        let state_key = membership_state_key(&user_id, &device_id);
        let membership = joined_membership(&room_id, device_id, livekit_service_url);

        let delay_id = self.schedule_hangup(&room_id, &state_key).await;

        room.send_state_event_for_key(&state_key, membership)
            .await
            .map_err(|error| self.room_error("join_call", error))?;

        let openid = client
            .send(request_openid_token::v3::Request::new(user_id))
            .await
            .map_err(|error| self.failed("join_call: openid token", error))?;

        let session = CallSessionId(self.allocate_subscription().0);

        self.call_sessions.lock().await.insert(
            session,
            CallSession {
                room_id,
                state_key,
                _postpone: delay_id.clone().map(|id| self.spawn_postpone_loop(id)),
                delay_id,
            },
        );

        Ok(CommandOk::JoinCall {
            session,
            openid_token: OpenIdTokenView {
                access_token: openid.access_token,
                matrix_server_name: openid.matrix_server_name.to_string(),
                expires_in_ms: u64::try_from(openid.expires_in.as_millis()).unwrap_or(u64::MAX),
            },
        })
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

    fn spawn_postpone_loop(self: &Arc<Self>, delay_id: String) -> crate::Task {
        let core = self.clone();

        spawn(async move {
            loop {
                matrix_sdk::sleep::sleep(HANGUP_POSTPONE_INTERVAL).await;

                let Ok(client) = core.client().await else {
                    return;
                };

                if let Err(error) = client
                    .send(update_delayed_event::unstable_v1::Request::new(
                        delay_id.clone(),
                        update_delayed_event::UpdateAction::Restart,
                    ))
                    .await
                {
                    tracing::warn!(?error, "could not postpone call hangup, stopping");
                    return;
                }
            }
        })
        .abort_on_drop()
    }
}

#[cfg(test)]
mod tests {
    use matrix_sdk::ruma::{device_id, user_id};

    use super::membership_state_key;

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
}
