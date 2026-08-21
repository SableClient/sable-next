use std::sync::Arc;

use futures_util::{StreamExt, pin_mut};
use matrix_sdk::executor::{JoinHandleExt, spawn};
use matrix_sdk::ruma::events::presence::PresenceEvent;
use matrix_sdk::ruma::events::room::message::OriginalSyncRoomMessageEvent;
use matrix_sdk::ruma::events::typing::SyncTypingEvent;
use matrix_sdk::ruma::presence::PresenceState;
use matrix_sdk_ui::room_list_service::State as RoomListState;
use matrix_sdk_ui::sync_service::State as SyncState;

use crate::protocol::{CoreEvent, PresenceView, SyncStatus};
use matrix_sdk::ruma::push::Action;
use matrix_sdk_ui::notification_client::NotificationProcessSetup;

use crate::Core;
use crate::notifications;

impl Core {
    pub(crate) fn watch_send_queue(self: &Arc<Self>, client: &matrix_sdk::Client) {
        let queue = client.send_queue();
        let mut errors = queue.subscribe_errors();

        self.track_session_task(
            spawn(async move {
                let mut failures = 0u32;
                loop {
                    let recoverable = match errors.recv().await {
                        Ok(error) => error.is_recoverable,
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => true,
                        Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                    };

                    if !recoverable {
                        continue;
                    }

                    failures = failures.saturating_add(1);
                    matrix_sdk::sleep::sleep(std::time::Duration::from_secs(
                        2u64.saturating_pow(failures.min(5)),
                    ))
                    .await;
                    queue.set_enabled(true).await;
                }
            })
            .abort_on_drop(),
        );
    }

    pub(crate) fn watch_notifications(
        self: &Arc<Self>,
        client: &matrix_sdk::Client,
        generation: u64,
    ) {
        let core = self.clone();
        let client = client.clone();
        self.track_session_task(
            spawn(async move {
                let Ok(sync_service) = core.sync_service().await else {
                    return;
                };
                let mut state = sync_service.room_list_service().state();
                while !matches!(state.get(), RoomListState::Running) {
                    if state.next().await.is_none() {
                        return;
                    }
                }

                client.add_event_handler({
                    let core = core.clone();
                    move |event: OriginalSyncRoomMessageEvent,
                          room: matrix_sdk::Room,
                          client: matrix_sdk::Client,
                          actions: Vec<Action>| {
                        let core = core.clone();

                        async move {
                            if Some(event.sender.as_ref()) == client.user_id() {
                                return;
                            }
                            if !notifications::notifies(&actions) {
                                return;
                            }

                            let Ok(sync_service) = core.sync_service().await else {
                                return;
                            };
                            let setup = NotificationProcessSetup::SingleProcess { sync_service };
                            if let Some(notification) = notifications::notification(
                                &client,
                                setup,
                                room.room_id(),
                                &event.event_id,
                            )
                            .await
                            {
                                core.emit_if_current(
                                    generation,
                                    CoreEvent::Notification { notification },
                                );
                            }
                        }
                    }
                });
            })
            .abort_on_drop(),
        );
    }

    pub(crate) fn watch_notification_settings(
        self: &Arc<Self>,
        client: &matrix_sdk::Client,
        generation: u64,
    ) {
        let core = self.clone();
        let watched = client.clone();
        self.track_session_task(
            spawn(async move {
                let mut changes = watched.notification_settings().await.subscribe_to_changes();
                while changes.recv().await.is_ok() {
                    core.emit_if_current(generation, CoreEvent::NotificationSettingsChanged);
                }
            })
            .abort_on_drop(),
        );
    }

    /// Two streams, one status, so either firing re-reads both.
    pub(crate) fn watch_encryption(self: &Arc<Self>, client: &matrix_sdk::Client, generation: u64) {
        let mut verification = client.encryption().verification_state();
        let recovery = client.encryption().recovery().state_stream();

        let core = self.clone();
        let watched = client.clone();
        self.track_session_task(
            spawn(async move {
                while verification.next().await.is_some() {
                    core.emit_if_current(
                        generation,
                        CoreEvent::EncryptionStatus {
                            status: crate::verification::encryption_status(&watched).await,
                        },
                    );
                }
            })
            .abort_on_drop(),
        );

        let core = self.clone();
        let watched = client.clone();
        self.track_session_task(
            spawn(async move {
                pin_mut!(recovery);
                while recovery.next().await.is_some() {
                    core.emit_if_current(
                        generation,
                        CoreEvent::EncryptionStatus {
                            status: crate::verification::encryption_status(&watched).await,
                        },
                    );
                }
            })
            .abort_on_drop(),
        );
    }

    /// Ordinary sync events, so one handler each covers every room. Per-room
    /// registration would mean tracking what the UI looks at, and a room list
    /// row needs typing for rooms that are shut.
    pub(crate) fn watch_ephemeral(self: &Arc<Self>, client: &matrix_sdk::Client, generation: u64) {
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

                    core.emit_if_current(
                        generation,
                        CoreEvent::Typing {
                            room_id: room.room_id().to_owned(),
                            user_ids,
                        },
                    );
                }
            }
        });

        client.add_event_handler({
            let core = self.clone();
            move |event: PresenceEvent| {
                let core = core.clone();

                async move {
                    core.emit_if_current(
                        generation,
                        CoreEvent::Presence {
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
                        },
                    );
                }
            }
        });
    }
}

pub(crate) fn sync_status(state: SyncState) -> SyncStatus {
    match state {
        SyncState::Idle | SyncState::Terminated | SyncState::Offline => SyncStatus::Offline,
        SyncState::Running => SyncStatus::Live,
        SyncState::Error(error) => SyncStatus::Error {
            message: error.to_string(),
        },
    }
}
