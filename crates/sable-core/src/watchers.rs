use std::sync::Arc;

use futures_util::{StreamExt, pin_mut};
use matrix_sdk::executor::{JoinHandleExt, spawn};
use matrix_sdk::ruma::MilliSecondsSinceUnixEpoch;
use matrix_sdk::ruma::events::presence::PresenceEvent;
use matrix_sdk::ruma::events::room::member::MembershipState;
use matrix_sdk::ruma::events::typing::SyncTypingEvent;
use matrix_sdk::ruma::events::{AnyGlobalAccountDataEvent, AnyStrippedStateEvent};
use matrix_sdk::ruma::presence::PresenceState;
use matrix_sdk_ui::sync_service::State as SyncState;

use crate::protocol::{CoreEvent, PresenceView, SyncStatus};
use matrix_sdk_base::deserialized_responses::RawAnySyncOrStrippedTimelineEvent;
use matrix_sdk_base::sync::Notification;
use matrix_sdk_ui::notification_client::{NotificationClient, NotificationProcessSetup};

use crate::Core;
use crate::notifications;
use crate::spaces::{self, SidebarSpacesEvent};

type NotificationSender = tokio::sync::mpsc::UnboundedSender<(Notification, matrix_sdk::Room)>;
pub(crate) type NotificationRoute = Arc<std::sync::Mutex<Option<NotificationSender>>>;

struct NotificationWorkerRoute {
    route: NotificationRoute,
    sender: NotificationSender,
}

impl Drop for NotificationWorkerRoute {
    fn drop(&mut self) {
        let mut route = self
            .route
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if route
            .as_ref()
            .is_some_and(|sender| sender.same_channel(&self.sender))
        {
            route.take();
        }
    }
}

impl Core {
    pub(crate) fn watch_account_data(
        self: &Arc<Self>,
        client: &matrix_sdk::Client,
        generation: u64,
    ) {
        let handle = client.add_event_handler({
            let core = self.clone();
            move |event: AnyGlobalAccountDataEvent| {
                let core = core.clone();
                async move {
                    if core
                        .session_generation
                        .load(std::sync::atomic::Ordering::SeqCst)
                        == generation
                    {
                        let event_type = event.event_type().to_string();
                        core.remember_account_data_type(event_type.clone()).await;
                        core.emit(CoreEvent::AccountDataChanged { event_type });
                    }
                }
            }
        });
        self.track_session_handler(client, handle);
    }

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

    #[allow(clippy::too_many_lines)] // Keep registration and its worker lifetime together.
    pub(crate) async fn watch_notifications(
        self: &Arc<Self>,
        client: &matrix_sdk::Client,
        generation: u64,
    ) {
        let session_start = MilliSecondsSinceUnixEpoch::now();
        let (sender, mut pending) = tokio::sync::mpsc::unbounded_channel();
        let Some(account_id) = self
            .session
            .read()
            .await
            .as_ref()
            .map(|session| session.account_id.clone())
        else {
            return;
        };
        let mut routes = self.notification_routes.lock().await;
        let route = if let Some(route) = routes.get(&account_id) {
            route.clone()
        } else {
            // `Room` is not `Send` on wasm, whose runtime is single-threaded; the
            // alias stays `Arc` because the native target shares it across threads.
            #[allow(clippy::arc_with_non_send_sync)]
            let route: NotificationRoute = Arc::new(std::sync::Mutex::new(None));
            let handler_route = route.clone();
            client
                .register_notification_handler(move |notification, room, _| {
                    if let Some(sender) = handler_route
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner)
                        .as_ref()
                    {
                        let _ = sender.send((notification, room));
                    }
                    async {}
                })
                .await;
            routes.insert(account_id, route.clone());
            route
        };
        *route
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(sender.clone());
        let route_guard = NotificationWorkerRoute { route, sender };
        drop(routes);

        let core = self.clone();
        let client = client.clone();
        self.track_session_task(
            spawn(async move {
                let _route_guard = route_guard;
                let Ok(sync_service) = core.sync_service().await else {
                    return;
                };
                let setup = NotificationProcessSetup::SingleProcess { sync_service };
                let Ok(notifications_client) = NotificationClient::new(client.clone(), setup).await
                else {
                    return;
                };
                let mut alerted_invites: std::collections::HashSet<_> = client
                    .invited_rooms()
                    .into_iter()
                    .map(|room| room.room_id().to_owned())
                    .collect();
                while let Some((notification, room)) = pending.recv().await {
                    let Notification { event, actions } = notification;
                    if !notifications::notifies(&actions) || core.is_read_room(room.room_id()) {
                        continue;
                    }
                    let notification = match event {
                        RawAnySyncOrStrippedTimelineEvent::Sync(raw) => {
                            let Ok(event) = raw.deserialize() else {
                                continue;
                            };
                            if Some(event.sender()) == client.user_id()
                                || notifications::is_backfill(
                                    session_start,
                                    event.origin_server_ts(),
                                )
                                || notifications::is_read(&room)
                            {
                                continue;
                            }
                            notifications::foreground_notification(
                                &notifications_client,
                                &room,
                                event.event_id(),
                            )
                            .await
                        }
                        RawAnySyncOrStrippedTimelineEvent::Stripped(raw) => {
                            let Ok(AnyStrippedStateEvent::RoomMember(event)) = raw.deserialize()
                            else {
                                continue;
                            };
                            if event.state_key != room.own_user_id()
                                || event.content.membership != MembershipState::Invite
                                || !alerted_invites.insert(room.room_id().to_owned())
                            {
                                continue;
                            }
                            notifications::invite_notification(&room, &actions).await
                        }
                    };
                    if let Some(notification) = notification
                        && !core.is_read_room(room.room_id())
                        && (notification.event_id.is_none() || !notifications::is_read(&room))
                    {
                        core.emit_if_current(generation, CoreEvent::Notification { notification });
                    }
                }
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
                while let Ok(()) | Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) =
                    changes.recv().await
                {
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

    pub(crate) fn watch_devices(self: &Arc<Self>, client: &matrix_sdk::Client, generation: u64) {
        let core = self.clone();
        let watched = client.clone();
        self.track_session_task(
            spawn(async move {
                let Ok(devices) = watched.encryption().devices_stream().await else {
                    return;
                };
                pin_mut!(devices);
                while devices.next().await.is_some() {
                    core.emit_devices(generation, &watched).await;
                }
            })
            .abort_on_drop(),
        );

        let core = self.clone();
        let watched = client.clone();
        self.track_session_task(
            spawn(async move {
                let Ok(identities) = watched.encryption().user_identities_stream().await else {
                    return;
                };
                pin_mut!(identities);
                while identities.next().await.is_some() {
                    core.emit_devices(generation, &watched).await;
                }
            })
            .abort_on_drop(),
        );
    }

    async fn emit_devices(&self, generation: u64, client: &matrix_sdk::Client) {
        self.emit_if_current(
            generation,
            CoreEvent::DevicesChanged {
                devices: crate::verification::own_devices(client).await,
            },
        );
    }

    pub(crate) fn watch_space_sidebar(
        self: &Arc<Self>,
        client: &matrix_sdk::Client,
        generation: u64,
    ) {
        let handle = client.add_event_handler({
            let core = self.clone();
            move |event: SidebarSpacesEvent| {
                let core = core.clone();

                async move {
                    core.emit_if_current(
                        generation,
                        CoreEvent::SpaceSidebarChanged {
                            items: spaces::items(&event.content),
                        },
                    );
                }
            }
        });
        self.track_session_handler(client, handle);
    }

    /// Ordinary sync events, so one handler each covers every room. Per-room
    /// registration would mean tracking what the UI looks at, and a room list
    /// row needs typing for rooms that are shut.
    pub(crate) fn watch_ephemeral(self: &Arc<Self>, client: &matrix_sdk::Client, generation: u64) {
        let own_user_id = client.user_id().map(ToOwned::to_owned);

        let handle = client.add_event_handler({
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
        self.track_session_handler(client, handle);

        let handle = client.add_event_handler({
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
        self.track_session_handler(client, handle);
    }
}

pub(crate) fn sync_status(state: SyncState) -> SyncStatus {
    match state {
        SyncState::Offline => SyncStatus::Offline,
        SyncState::Idle | SyncState::Terminated => SyncStatus::Syncing,
        SyncState::Running => SyncStatus::Live,
        SyncState::Error(error) => SyncStatus::Error {
            message: error.to_string(),
        },
    }
}
