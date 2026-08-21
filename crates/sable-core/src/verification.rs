use std::sync::Arc;

use futures_util::StreamExt;
use matrix_sdk::encryption::verification::{
    SasState, SasVerification, VerificationRequest, VerificationRequestState,
};
use matrix_sdk::encryption::{VerificationState, recovery::RecoveryState};
use matrix_sdk::executor::{JoinHandleExt, spawn};
use matrix_sdk::ruma::events::key::verification::request::ToDeviceKeyVerificationRequestEvent;
use matrix_sdk::ruma::events::room::message::{MessageType, OriginalSyncRoomMessageEvent};
use matrix_sdk::ruma::{OwnedUserId, UserId};

use crate::protocol::{
    CommandErr, CoreEvent, EmojiView, EncryptionStatusView, RecoveryStateView,
    VerificationStateView, VerificationView,
};

use crate::Core;

impl Core {
    /// Self-verification travels to-device, verifying someone else as a DM
    /// message, so both need a handler or one direction never prompts.
    pub(crate) fn watch_incoming_verifications(self: &Arc<Self>, client: &matrix_sdk::Client) {
        client.add_event_handler({
            let core = self.clone();
            move |event: ToDeviceKeyVerificationRequestEvent, client: matrix_sdk::Client| {
                let core = core.clone();

                async move {
                    let request = client
                        .encryption()
                        .get_verification_request(
                            &event.sender,
                            event.content.transaction_id.as_str(),
                        )
                        .await;

                    tracing::info!(
                        operation = "verification",
                        request_available = request.is_some(),
                        "received to-device verification request"
                    );

                    if let Some(request) = request {
                        core.watch_verification(request);
                    }
                }
            }
        });

        client.add_event_handler({
            let core = self.clone();
            move |event: OriginalSyncRoomMessageEvent, client: matrix_sdk::Client| {
                let core = core.clone();

                async move {
                    if !matches!(event.content.msgtype, MessageType::VerificationRequest(_)) {
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
    pub(crate) fn watch_verification(self: &Arc<Self>, request: VerificationRequest) {
        let core = self.clone();
        let task = spawn(async move {
            let user_id = request.other_user_id().to_owned();
            let flow_id = request.flow_id().to_owned();

            let mut changes = request.changes();
            core.emit_verification(&user_id, &flow_id, request_view(&request, &request.state()));

            while let Some(state) = changes.next().await {
                match state {
                    VerificationRequestState::Ready { .. } => {
                        if request.we_started()
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
        })
        .abort_on_drop();
        self.track_session_task(task);
    }

    fn watch_sas(self: &Arc<Self>, user_id: OwnedUserId, flow_id: String, sas: SasVerification) {
        let core = self.clone();
        let task = spawn(async move {
            let mut changes = sas.changes();
            core.emit_verification(&user_id, &flow_id, sas_view(&sas, &sas.state()));

            if !sas.we_started()
                && let Err(error) = sas.accept().await
            {
                core.failed("verification: accept_sas", error);
            }

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
        })
        .abort_on_drop();
        self.track_session_task(task);
    }

    fn emit_verification(&self, user_id: &UserId, flow_id: &str, state: VerificationView) {
        tracing::info!(
            operation = "verification",
            phase = verification_phase(&state),
            "verification state changed"
        );
        self.emit(CoreEvent::Verification {
            user_id: user_id.to_owned(),
            flow_id: flow_id.to_owned(),
            state,
        });
    }

    pub(crate) async fn verification_request(
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

    pub(crate) async fn sas(
        &self,
        user_id: &UserId,
        flow_id: &str,
    ) -> Result<SasVerification, CommandErr> {
        self.client()
            .await?
            .encryption()
            .get_verification(user_id, flow_id)
            .await
            .and_then(matrix_sdk::encryption::verification::Verification::sas)
            .ok_or(CommandErr::UnknownVerification)
    }
}

fn request_view(
    request: &VerificationRequest,
    state: &VerificationRequestState,
) -> VerificationView {
    match state {
        VerificationRequestState::Created { .. } => VerificationView::Requested {
            is_self: request.is_self_verification(),
            initiated_by_us: true,
        },
        VerificationRequestState::Requested { .. } => VerificationView::Requested {
            is_self: request.is_self_verification(),
            initiated_by_us: false,
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

const fn verification_phase(state: &VerificationView) -> &'static str {
    match state {
        VerificationView::Requested { .. } => "requested",
        VerificationView::Waiting => "waiting",
        VerificationView::Compare { .. } => "compare",
        VerificationView::Confirmed => "confirmed",
        VerificationView::Done => "done",
        VerificationView::Cancelled { .. } => "cancelled",
    }
}

pub(crate) async fn encryption_status(client: &matrix_sdk::Client) -> EncryptionStatusView {
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
