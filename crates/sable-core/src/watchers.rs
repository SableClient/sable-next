use sable_model::text::visible_name;

use std::sync::Arc;

use futures_util::{StreamExt, pin_mut};
use matrix_sdk::deserialized_responses::TimelineEvent;
use matrix_sdk::event_cache::RedecryptorReport;
use matrix_sdk::executor::{JoinHandleExt, spawn};
use matrix_sdk::ruma::events::room::member::{MembershipState, OriginalSyncRoomMemberEvent};
use matrix_sdk::ruma::events::room::redaction::SyncRoomRedactionEvent;
use matrix_sdk::ruma::events::typing::SyncTypingEvent;
use matrix_sdk::ruma::events::{
    AnyGlobalAccountDataEvent, AnyStrippedStateEvent, AnySyncTimelineEvent,
};
use matrix_sdk::ruma::push::Action;
use matrix_sdk::ruma::serde::Raw;
use matrix_sdk::ruma::{EventId, MilliSecondsSinceUnixEpoch, OwnedEventId};
use matrix_sdk_ui::sync_service::State as SyncState;

use crate::protocol::{CoreEvent, RpcError, SyncStatus};
use matrix_sdk_base::deserialized_responses::RawAnySyncOrStrippedTimelineEvent;
use matrix_sdk_base::sync::Notification;
use matrix_sdk_ui::notification_client::{NotificationClient, NotificationProcessSetup};

use crate::Core;
use crate::notifications;
use crate::search::ignored_user_ids;
use crate::spaces::{self, SidebarSpacesEvent};

type NotificationSender = tokio::sync::mpsc::UnboundedSender<(Notification, matrix_sdk::Room)>;
pub(crate) type NotificationRoute = Arc<parking_lot::Mutex<Option<NotificationSender>>>;

struct NotificationWorkerRoute {
    route: NotificationRoute,
    sender: NotificationSender,
}

impl Drop for NotificationWorkerRoute {
    fn drop(&mut self) {
        let mut route = self.route.lock();
        if route
            .as_ref()
            .is_some_and(|sender| sender.same_channel(&self.sender))
        {
            route.take();
        }
    }
}

fn redecrypted_notification(
    event: &TimelineEvent,
    actions: Vec<Action>,
    now: MilliSecondsSinceUnixEpoch,
) -> Option<Notification> {
    if event.kind.is_utd()
        || !notifications::notifies(&actions)
        || event
            .timestamp()
            .is_none_or(|sent| notifications::is_backfill(now, sent))
    {
        return None;
    }
    Some(Notification {
        event: RawAnySyncOrStrippedTimelineEvent::Sync(event.raw().clone()),
        actions,
    })
}

impl Core {
    /// Restarts a stalled sync with backoff and reports each state change.
    pub(crate) fn watch_sync_state(
        self: &Arc<Self>,
        client: &matrix_sdk::Client,
        sync_service: &Arc<matrix_sdk_ui::sync_service::SyncService>,
        generation: u64,
    ) {
        let core = self.clone();
        let mut states = sync_service.state();
        let restarted = sync_service.clone();
        let support_client = client.clone();
        // `Subscriber::next` yields only on *change*, so emit the first by hand.
        core.emit_if_current(generation, CoreEvent::SyncStatus(sync_status(states.get())));
        self.track_session_task(
            spawn(async move {
                let mut failures = 0u32;
                loop {
                    let next = if matches!(states.get(), SyncState::Offline) {
                        matrix_sdk::timeout::timeout(states.next(), OFFLINE_RECHECK).await
                    } else {
                        Ok(states.next().await)
                    };
                    let Ok(next) = next else {
                        if server_reachable(&support_client).await && !core.sync_paused() {
                            restarted.start().await;
                        }
                        continue;
                    };
                    let Some(state) = next else {
                        break;
                    };
                    if core.sync_paused() {
                        continue;
                    }
                    let stalled = matches!(
                        state,
                        SyncState::Error(_) | SyncState::Terminated | SyncState::Idle
                    );
                    let running = matches!(state, SyncState::Running);
                    core.emit_if_current(generation, CoreEvent::SyncStatus(sync_status(state)));
                    if running {
                        core.resubscribe_timeline_rooms().await;
                        core.reconcile_memberships().await;
                        core.fill_own_members().await;
                        core.align_notification_rules().await;
                    }

                    if stalled {
                        if core.detect_account_lock(&support_client, generation).await {
                            continue;
                        }
                        if matches!(
                            core.require_sliding_sync(&support_client).await,
                            Err(RpcError::SlidingSyncUnsupported)
                        ) {
                            restarted.stop().await;
                            core.emit_if_current(
                                generation,
                                CoreEvent::SyncStatus(crate::protocol::SyncStatus::Error {
                                    message: "This homeserver does not support Sliding Sync."
                                        .to_owned(),
                                }),
                            );
                            return;
                        }
                        failures = failures.saturating_add(1);
                        crate::watchers::retry_backoff(failures).await;
                        if !core.sync_paused() {
                            restarted.start().await;
                        }
                    } else {
                        failures = 0;
                    }
                }
            })
            .abort_on_drop(),
        );
    }

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
                        if matches!(event, AnyGlobalAccountDataEvent::Direct(_)) {
                            let aligning = core.clone();
                            core.track_session_task(
                                spawn(async move { aligning.align_notification_rules().await })
                                    .abort_on_drop(),
                            );
                        }
                        core.remember_account_data_type(event_type.clone()).await;
                        if crate::personas::is_persona_event(&event_type) {
                            core.emit(CoreEvent::PersonasChanged);
                        }
                        core.emit(CoreEvent::AccountDataChanged { event_type });
                    }
                }
            }
        });
        self.track_session_handler(client, handle);
    }

    pub(crate) fn watch_send_queue(self: &Arc<Self>, client: &matrix_sdk::Client) {
        use matrix_sdk::send_queue::RoomSendQueueUpdate;
        use tokio::sync::broadcast::error::RecvError;

        let queue = client.send_queue();
        let mut errors = queue.subscribe_errors();
        let mut updates = queue.subscribe();

        self.track_session_task(
            spawn(async move {
                let mut failures = 0u32;
                loop {
                    let recoverable = tokio::select! {
                        update = updates.recv() => match update {
                            Ok(update) => {
                                if matches!(update.update, RoomSendQueueUpdate::SentEvent { .. }) {
                                    failures = 0;
                                }
                                continue;
                            }
                            Err(RecvError::Lagged(_)) => continue,
                            Err(RecvError::Closed) => break,
                        },
                        error = errors.recv() => match error {
                            Ok(error) => error.is_recoverable,
                            Err(RecvError::Lagged(_)) => true,
                            Err(RecvError::Closed) => break,
                        },
                    };

                    if !recoverable {
                        continue;
                    }

                    while errors.try_recv().is_ok() {}

                    failures = failures.saturating_add(1);
                    retry_backoff(failures).await;
                    queue.set_enabled(true).await;
                }
            })
            .abort_on_drop(),
        );
    }

    #[expect(
        clippy::too_many_lines,
        reason = "keep registration and its worker lifetime together"
    )]
    pub(crate) async fn watch_notifications(
        self: &Arc<Self>,
        client: &matrix_sdk::Client,
        generation: u64,
    ) {
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
            #[cfg_attr(
                target_family = "wasm",
                expect(
                    clippy::arc_with_non_send_sync,
                    reason = "the WASM core is single-threaded"
                )
            )]
            let route: NotificationRoute = Arc::new(parking_lot::Mutex::new(None));
            let handler_route = route.clone();
            client
                .register_notification_handler(move |notification, room, _| {
                    if let Some(sender) = handler_route.lock().as_ref() {
                        let _ = sender.send((notification, room));
                    }
                    async {}
                })
                .await;
            routes.insert(account_id, route.clone());
            route
        };
        *route.lock() = Some(sender.clone());
        let redecrypted = sender.clone();
        let route_guard = NotificationWorkerRoute { route, sender };
        drop(routes);
        self.watch_redecrypted_notifications(client, redecrypted, generation);

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
                let mut alerted_events = std::collections::HashMap::new();
                while let Some((notification, room)) = pending.recv().await {
                    let Notification { event, actions } = notification;
                    let every_encrypted = core.every_encrypted_event_pushed().await;
                    if let RawAnySyncOrStrippedTimelineEvent::Sync(raw) = &event
                        && !(every_encrypted && notifications::raw_is_encrypted(raw))
                    {
                        core.record_live_inbox(&room, raw, &actions, generation)
                            .await;
                    }
                    if !notifications::notifies(&actions) || core.is_read_room(room.room_id()) {
                        continue;
                    }
                    let mut sent = None;
                    let notification = match event {
                        RawAnySyncOrStrippedTimelineEvent::Sync(raw) => {
                            if crate::calls::is_call_event_type(&raw)
                                || crate::calls::is_call_membership_event_type(&raw)
                            {
                                continue;
                            }
                            let Ok(event) = raw.deserialize() else {
                                continue;
                            };
                            let now = MilliSecondsSinceUnixEpoch::now();
                            if Some(event.sender()) == client.user_id()
                                || notifications::is_backfill(now, event.origin_server_ts())
                                || notifications::is_read(&room, event.origin_server_ts()).await
                                || !first_alert(
                                    &mut alerted_events,
                                    now,
                                    event.event_id(),
                                    event.origin_server_ts(),
                                )
                            {
                                continue;
                            }
                            sent = Some(event.origin_server_ts());
                            notifications::foreground_notification(
                                &notifications_client,
                                &room,
                                event.event_id(),
                                every_encrypted,
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
                    let read = match sent {
                        Some(sent) => notifications::is_read(&room, sent).await,
                        None => false,
                    };
                    if let Some(notification) = notification
                        && !core.is_read_room(room.room_id())
                        && !read
                    {
                        core.emit_if_current(generation, CoreEvent::Notification { notification });
                    }
                }
            })
            .abort_on_drop(),
        );
    }

    fn watch_redecrypted_notifications(
        self: &Arc<Self>,
        client: &matrix_sdk::Client,
        notifications: NotificationSender,
        generation: u64,
    ) {
        let Some(event_cache) = client.event_cache() else {
            return;
        };
        let mut reports = event_cache.subscribe_to_decryption_reports();
        let core = self.clone();
        let client = client.clone();
        self.track_session_task(
            spawn(async move {
                while let Some(report) = reports.next().await {
                    let Ok(RedecryptorReport::ResolvedUtds { room_id, events }) = report else {
                        continue;
                    };
                    let Some(room) = client.get_room(&room_id) else {
                        continue;
                    };
                    let Some(event_cache) = client.event_cache() else {
                        return;
                    };
                    let Ok((cache, _drop_handles)) = event_cache.room(&room_id).await else {
                        continue;
                    };
                    for event_id in events {
                        let Ok(Some(event)) = cache.find_event(&event_id).await else {
                            continue;
                        };
                        let actions = match event.push_actions() {
                            Some(actions) => actions.to_vec(),
                            None => room
                                .event_push_actions(event.raw())
                                .await
                                .ok()
                                .flatten()
                                .unwrap_or_default(),
                        };
                        core.refresh_undecryptable_inbox_entry(&room, &event, &actions, generation)
                            .await;
                        if let Some(notification) = redecrypted_notification(
                            &event,
                            actions,
                            MilliSecondsSinceUnixEpoch::now(),
                        ) && notifications.send((notification, room.clone())).is_err()
                        {
                            return;
                        }
                    }
                }
            })
            .abort_on_drop(),
        );
    }

    pub(crate) fn watch_notification_settings(self: &Arc<Self>, generation: u64) {
        let core = self.clone();
        self.track_session_task(
            spawn(async move {
                let Ok(rules) = core.push_rules().await else {
                    return;
                };
                let mut changes = rules.subscribe();
                while let Ok(()) | Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) =
                    changes.recv().await
                {
                    core.emit_if_current(generation, CoreEvent::NotificationSettingsChanged);
                }
            })
            .abort_on_drop(),
        );
    }

    /// Re-read the full status when verification, recovery, or backup changes.
    pub(crate) fn watch_encryption(self: &Arc<Self>, client: &matrix_sdk::Client, generation: u64) {
        let mut verification = client.encryption().verification_state();
        let recovery = client.encryption().recovery().state_stream();
        let backups = client.encryption().backups().state_stream();

        let core = self.clone();
        let watched = client.clone();
        self.track_session_task(
            spawn(async move {
                core.emit_if_current(
                    generation,
                    CoreEvent::EncryptionStatus {
                        status: crate::verification::encryption_status(&watched).await,
                    },
                );
            })
            .abort_on_drop(),
        );

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

        let core = self.clone();
        let watched = client.clone();
        self.track_session_task(
            spawn(async move {
                pin_mut!(backups);
                while backups.next().await.is_some() {
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
                let Ok(updates) = watched.encryption().devices_stream().await else {
                    return;
                };
                pin_mut!(updates);
                let mut known = crate::verification::local_own_devices(&watched).await;
                while updates.next().await.is_some() {
                    let devices = crate::verification::local_own_devices(&watched).await;
                    if devices != known {
                        known.clone_from(&devices);
                        core.emit_if_current(
                            generation,
                            CoreEvent::EncryptionStatus {
                                status: crate::verification::encryption_status(&watched).await,
                            },
                        );
                        core.emit_if_current(generation, CoreEvent::DevicesChanged { devices });
                    }
                }
            })
            .abort_on_drop(),
        );
    }

    pub(crate) async fn emit_devices(&self, generation: u64, client: &matrix_sdk::Client) {
        self.emit_if_current(
            generation,
            CoreEvent::DevicesChanged {
                devices: crate::verification::own_devices(client).await,
            },
        );
    }

    pub(crate) fn watch_joined_invites(self: &Arc<Self>, client: &matrix_sdk::Client) {
        self.track_session_task(
            spawn(crate::rooms::reconcile_joined_invites(client.clone())).abort_on_drop(),
        );
        self.track_session_task(
            spawn(crate::rooms::poll_memberships(self.clone(), client.clone())).abort_on_drop(),
        );
    }

    pub(crate) fn watch_profile_changes(
        self: &Arc<Self>,
        client: &matrix_sdk::Client,
        generation: u64,
    ) {
        let handle = client.add_event_handler({
            let core = self.clone();
            move |event: OriginalSyncRoomMemberEvent, room: matrix_sdk::Room| {
                let core = core.clone();
                async move {
                    let Some(previous) = event.prev_content() else {
                        return;
                    };
                    if previous.membership == MembershipState::Join
                        && event.content.displayname == previous.displayname
                        && event.content.avatar_url == previous.avatar_url
                    {
                        return;
                    }
                    core.emit_profile_changed(generation, &room, &event).await;
                }
            }
        });
        self.track_session_handler(client, handle);

        let handle = client.add_event_handler({
            let core = self.clone();
            move |_: OriginalSyncRoomMemberEvent, room: matrix_sdk::Room| {
                let core = core.clone();
                async move {
                    // Sliding sync reads state from `required_state` only, so a member event
                    // in the timeline leaves the stored member list stale.
                    room.mark_members_missing();
                    core.forget_members_loaded(room.room_id());
                    core.emit_if_current(
                        generation,
                        CoreEvent::MembersChanged {
                            room_id: room.room_id().to_owned(),
                        },
                    );
                }
            }
        });
        self.track_session_handler(client, handle);

        let handle = client.add_event_handler({
            let core = self.clone();
            move |raw: Raw<AnySyncTimelineEvent>, room: matrix_sdk::Room| {
                let core = core.clone();
                async move {
                    if raw.get_field::<String>("type").ok().flatten().as_deref()
                        != Some("m.room.member")
                    {
                        return;
                    }
                    let Ok(event) = raw.deserialize_as_unchecked::<OriginalSyncRoomMemberEvent>()
                    else {
                        return;
                    };
                    if event.prev_content().is_none() {
                        core.emit_profile_changed(generation, &room, &event).await;
                    }
                }
            }
        });
        self.track_session_handler(client, handle);
    }

    async fn emit_profile_changed(
        &self,
        generation: u64,
        room: &matrix_sdk::Room,
        event: &OriginalSyncRoomMemberEvent,
    ) {
        if event.content.membership != MembershipState::Join {
            return;
        }
        let Ok(user_id) = matrix_sdk::ruma::OwnedUserId::try_from(event.state_key.as_str()) else {
            return;
        };
        let display_name = event.content.displayname.clone().and_then(visible_name);
        let avatar_url = event.content.avatar_url.as_ref().map(ToString::to_string);
        self.overlay_profile(
            room.room_id(),
            &user_id,
            display_name.clone(),
            avatar_url.clone(),
        )
        .await;
        self.emit_if_current(
            generation,
            CoreEvent::ProfileChanged {
                room_id: room.room_id().to_owned(),
                user_id,
                display_name,
                avatar_url,
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

    /// The SDK drops a redaction's reason from an item it redacts live, so the reason is
    /// read off the redaction event and laid over the open timelines.
    pub(crate) fn watch_redactions(self: &Arc<Self>, client: &matrix_sdk::Client) {
        let handle = client.add_event_handler({
            let core = self.clone();
            move |event: SyncRoomRedactionEvent, room: matrix_sdk::Room| {
                let core = core.clone();
                async move {
                    let SyncRoomRedactionEvent::Original(event) = event else {
                        return;
                    };
                    let Some(reason) = event
                        .content
                        .reason
                        .as_deref()
                        .filter(|reason| !reason.trim().is_empty())
                    else {
                        return;
                    };
                    let rules = room.clone_info().room_version_rules_or_default();
                    core.overlay_redaction(room.room_id(), event.redacts(&rules.redaction), reason)
                        .await;
                }
            }
        });
        self.track_session_handler(client, handle);
    }

    /// Ordinary sync events: one handler covers every room, including ones the UI has shut.
    pub(crate) fn watch_ephemeral(self: &Arc<Self>, client: &matrix_sdk::Client, generation: u64) {
        let own_user_id = client.user_id().map(ToOwned::to_owned);

        let handle = client.add_event_handler({
            let core = self.clone();
            move |event: SyncTypingEvent, room: matrix_sdk::Room| {
                let core = core.clone();
                let own_user_id = own_user_id.clone();

                async move {
                    let ignored = ignored_user_ids(&room.client()).await;
                    // Unlike `Room::subscribe_to_typing_notifications`, a raw handler does not filter our own user.
                    let user_ids = event
                        .content
                        .user_ids
                        .into_iter()
                        .filter(|id| Some(id) != own_user_id.as_ref() && !ignored.contains(id))
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

pub(crate) const OFFLINE_RECHECK: std::time::Duration = std::time::Duration::from_secs(10);

pub(crate) async fn server_reachable(client: &matrix_sdk::Client) -> bool {
    matches!(
        matrix_sdk::timeout::timeout(client.fetch_server_versions(None), OFFLINE_RECHECK).await,
        Ok(Ok(_))
    )
}

pub(crate) async fn retry_backoff(failures: u32) {
    matrix_sdk::sleep::sleep(std::time::Duration::from_secs(
        2u64.saturating_pow(failures.min(5)),
    ))
    .await;
}

/// Backfill is rejected before this check, so ids older than the backfill
/// window can never repeat and are dropped.
fn first_alert(
    alerted: &mut std::collections::HashMap<OwnedEventId, MilliSecondsSinceUnixEpoch>,
    now: MilliSecondsSinceUnixEpoch,
    event_id: &EventId,
    sent: MilliSecondsSinceUnixEpoch,
) -> bool {
    alerted.retain(|_, sent| !notifications::is_backfill(now, *sent));
    alerted.insert(event_id.to_owned(), sent).is_none()
}

#[cfg(test)]
mod tests {
    use matrix_sdk::deserialized_responses::{
        TimelineEvent, UnableToDecryptInfo, UnableToDecryptReason,
    };
    use matrix_sdk::ruma::MilliSecondsSinceUnixEpoch;
    use matrix_sdk::ruma::push::Action;
    use matrix_sdk::ruma::serde::Raw;
    use matrix_sdk::ruma::{room_id, user_id};
    use matrix_sdk::test_utils::mocks::MatrixMockServer;
    use matrix_sdk_test::{JoinedRoomBuilder, event_factory::EventFactory};
    use serde_json::{Value, json};
    use tokio::sync::mpsc::UnboundedReceiver;

    use crate::Core;
    use crate::protocol::CoreEvent;
    use crate::store::MemorySessionStore;

    const ALICE: &str = "@alice:example.org";

    #[test]
    fn an_alerted_event_is_alerted_once_and_forgotten_after_the_backfill_window() {
        let at = |ms: u64| MilliSecondsSinceUnixEpoch(ms.try_into().expect("timestamp"));
        let event_id = matrix_sdk::ruma::event_id!("$event");
        let mut alerted = std::collections::HashMap::new();

        assert!(super::first_alert(
            &mut alerted,
            at(100_000),
            event_id,
            at(100_000)
        ));
        assert!(!super::first_alert(
            &mut alerted,
            at(100_500),
            event_id,
            at(100_000)
        ));

        let other = matrix_sdk::ruma::event_id!("$other");
        assert!(super::first_alert(
            &mut alerted,
            at(500_000),
            other,
            at(500_000)
        ));
        assert!(!alerted.contains_key(event_id));
    }

    #[test]
    fn a_fresh_redecrypted_event_that_notifies_is_forwarded_once_and_stale_ones_are_not() {
        let raw: Raw<matrix_sdk::ruma::events::AnySyncTimelineEvent> =
            serde_json::from_value(json!({
                "type": "m.room.message",
                "event_id": "$late",
                "sender": ALICE,
                "origin_server_ts": 100_000,
                "content": { "msgtype": "m.text", "body": "hi @bob" }
            }))
            .expect("event");
        let event = TimelineEvent::from_plaintext(raw.clone());
        let at = |ms: u64| MilliSecondsSinceUnixEpoch(ms.try_into().expect("timestamp"));

        assert!(
            super::redecrypted_notification(&event, vec![Action::Notify], at(110_000)).is_some()
        );
        assert!(
            super::redecrypted_notification(&event, vec![Action::Notify], at(500_000)).is_none()
        );
        assert!(super::redecrypted_notification(&event, Vec::new(), at(110_000)).is_none());

        let utd = TimelineEvent::from_utd(
            raw,
            UnableToDecryptInfo {
                session_id: None,
                reason: UnableToDecryptReason::Unknown,
            },
        );
        assert!(super::redecrypted_notification(&utd, vec![Action::Notify], at(110_000)).is_none());
    }

    fn member<T>(
        event_id: &str,
        user_id: &str,
        content: &Value,
        previous: Option<&Value>,
    ) -> Raw<T> {
        let mut event = json!({
            "type": "m.room.member",
            "state_key": user_id,
            "sender": user_id,
            "event_id": event_id,
            "origin_server_ts": 1,
            "content": content,
        });
        if let Some(previous) = previous {
            event["unsigned"] = json!({ "prev_content": previous });
        }
        Raw::new(&event).unwrap().cast_unchecked()
    }

    fn changes(
        events: &mut UnboundedReceiver<CoreEvent>,
    ) -> Vec<(String, String, Option<String>, Option<String>)> {
        std::iter::from_fn(|| events.try_recv().ok())
            .filter_map(|event| match event {
                CoreEvent::ProfileChanged {
                    room_id,
                    user_id,
                    display_name,
                    avatar_url,
                } => Some((
                    room_id.to_string(),
                    user_id.to_string(),
                    display_name,
                    avatar_url,
                )),
                _ => None,
            })
            .collect()
    }

    #[tokio::test]
    async fn a_rename_carries_the_room_and_the_new_profile() {
        let server = MatrixMockServer::new().await;
        let room_id = room_id!("!room:example.org");
        let client = server.client_builder().build().await;
        let (core, mut events) = Core::new("watchers", Box::new(MemorySessionStore::default()));
        core.watch_profile_changes(&client, 1);
        let old = json!({ "membership": "join", "displayname": "Alice" });
        let new = json!({
            "membership": "join",
            "displayname": "Alicia",
            "avatar_url": "mxc://example.org/alicia"
        });
        let recoloured = json!({
            "membership": "join",
            "displayname": "Alicia",
            "avatar_url": "mxc://example.org/alicia",
            "eu.she-a.color": { "on_light": "#123456" }
        });

        server
            .sync_room(
                &client,
                JoinedRoomBuilder::new(room_id)
                    .add_timeline_event(member("$renamed", ALICE, &new, Some(&old)))
                    .add_timeline_event(member("$recoloured", ALICE, &recoloured, Some(&new))),
            )
            .await;

        assert_eq!(
            changes(&mut events),
            [(
                room_id.to_string(),
                ALICE.to_owned(),
                Some("Alicia".to_owned()),
                Some("mxc://example.org/alicia".to_owned()),
            )]
        );
    }

    #[tokio::test]
    async fn accepting_an_invite_announces_the_new_member() {
        let server = MatrixMockServer::new().await;
        let room_id = room_id!("!room:example.org");
        let client = server.client_builder().build().await;
        let (core, mut events) = Core::new("watchers", Box::new(MemorySessionStore::default()));
        core.watch_profile_changes(&client, 1);
        let invited = json!({ "membership": "invite", "displayname": "Alice" });
        let joined = json!({ "membership": "join", "displayname": "Alice" });
        let left = json!({ "membership": "leave", "displayname": "Alice" });

        server
            .sync_room(
                &client,
                JoinedRoomBuilder::new(room_id)
                    .add_timeline_event(member("$joined", ALICE, &joined, Some(&invited)))
                    .add_timeline_event(member("$left", ALICE, &left, Some(&joined)))
                    .add_timeline_event(member("$rejoined", ALICE, &joined, Some(&left))),
            )
            .await;

        let alice = (
            room_id.to_string(),
            ALICE.to_owned(),
            Some("Alice".to_owned()),
            None,
        );
        assert_eq!(changes(&mut events), [alice.clone(), alice]);
    }

    #[tokio::test]
    async fn every_membership_transition_announces_a_member_change() {
        let server = MatrixMockServer::new().await;
        let room_id = room_id!("!room:example.org");
        let client = server.client_builder().build().await;
        let (core, mut events) = Core::new("watchers", Box::new(MemorySessionStore::default()));
        core.watch_profile_changes(&client, 1);
        let state = |membership: &str| json!({ "membership": membership });
        let (invite, join, leave, ban) =
            (state("invite"), state("join"), state("leave"), state("ban"));

        server
            .sync_room(
                &client,
                JoinedRoomBuilder::new(room_id)
                    .add_state_event(member("$state", "@bob:example.org", &join, None))
                    .add_timeline_event(member("$invited", ALICE, &invite, None))
                    .add_timeline_event(member("$joined", ALICE, &join, Some(&invite)))
                    .add_timeline_event(member("$kicked", ALICE, &leave, Some(&join)))
                    .add_timeline_event(member("$banned", ALICE, &ban, Some(&leave)))
                    .add_timeline_event(member("$unbanned", ALICE, &leave, Some(&ban)))
                    .add_timeline_event(member("$rejoined", ALICE, &join, Some(&leave))),
            )
            .await;

        let announced = std::iter::from_fn(|| events.try_recv().ok())
            .filter(
                |event| matches!(event, CoreEvent::MembersChanged { room_id: id } if id == room_id),
            )
            .count();
        assert_eq!(announced, 7);
    }

    #[tokio::test]
    async fn a_timeline_rename_without_prev_content_still_counts() {
        let server = MatrixMockServer::new().await;
        let room_id = room_id!("!room:example.org");
        let client = server.client_builder().build().await;
        let (core, mut events) = Core::new("watchers", Box::new(MemorySessionStore::default()));
        core.watch_profile_changes(&client, 1);
        let bob = json!({ "membership": "join", "displayname": "Bob" });
        let alicia = json!({ "membership": "join", "displayname": "Alicia" });

        server
            .sync_room(
                &client,
                JoinedRoomBuilder::new(room_id)
                    .add_state_event(member("$state", "@bob:example.org", &bob, None))
                    .add_timeline_event(member("$renamed", ALICE, &alicia, None)),
            )
            .await;

        assert_eq!(
            changes(&mut events),
            [(
                room_id.to_string(),
                ALICE.to_owned(),
                Some("Alicia".to_owned()),
                None
            )]
        );
    }

    #[tokio::test]
    async fn an_ignored_user_is_not_reported_as_typing() {
        let server = MatrixMockServer::new().await;
        let room_id = room_id!("!room:example.org");
        let client = server.client_builder().build().await;
        let (core, mut events) = Core::new("watchers", Box::new(MemorySessionStore::default()));
        core.watch_ephemeral(&client, 1);
        let factory = EventFactory::new();
        let troll = user_id!("@troll:example.org");
        let bob = user_id!("@bob:example.org");

        server
            .mock_sync()
            .ok_and_run(&client, |sync| {
                sync.add_global_account_data(factory.ignored_user_list([troll.to_owned()]));
                sync.add_joined_room(
                    JoinedRoomBuilder::new(room_id).add_typing(factory.typing(vec![troll, bob])),
                );
            })
            .await;

        let typing: Vec<_> = std::iter::from_fn(|| events.try_recv().ok())
            .filter_map(|event| match event {
                CoreEvent::Typing { user_ids, .. } => Some(user_ids),
                _ => None,
            })
            .collect();
        assert_eq!(typing, [vec![bob.to_owned()]]);
    }
}
