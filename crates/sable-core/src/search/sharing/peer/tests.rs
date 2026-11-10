#[cfg(not(target_family = "wasm"))]
mod browser;

use std::collections::VecDeque;

use super::super::{History, STANDARD_NO_PAD};
use super::*;
use crate::search::tests::document;

fn state_with(devices: &[(&str, u64, u64, bool)]) -> State {
    let mut state = State::default();
    state.begin("query".into(), Instant::now());
    state.asked = devices
        .iter()
        .map(|(device, ..)| ((*device).into(), Some(format!("{device} name"))))
        .collect();
    for (device, documents, complete_rooms, busy) in devices {
        state.reply(
            <&DeviceId>::from(*device),
            "query",
            *documents,
            *complete_rooms,
            *busy,
        );
    }
    state
}

fn tried(next: Next) -> Option<OwnedDeviceId> {
    match next {
        Next::Try(device) => Some(device),
        Next::Ignore | Next::Wait | Next::Finished(_) => None,
    }
}

fn statuses(state: &State) -> Vec<SearchPeerCandidateStatus> {
    state
        .candidates
        .iter()
        .map(|candidate| candidate.status)
        .collect()
}

#[test]
fn only_asked_devices_answering_the_current_query_become_candidates() {
    let mut state = state_with(&[("A", 10, 0, false)]);
    state.reply(<&DeviceId>::from("A"), "query", 99, 0, false);
    state.reply(<&DeviceId>::from("B"), "query", 50, 0, false);
    state.reply(<&DeviceId>::from("A"), "other", 50, 0, false);
    assert_eq!(state.candidates.len(), 1);
    assert_eq!(state.candidates[0].documents, 10);
    assert_eq!(
        state.name_of(<&DeviceId>::from("A")).as_deref(),
        Some("A name")
    );
}

#[test]
fn deep_history_is_tried_first_and_failures_move_to_the_next_device() {
    let mut state = state_with(&[
        ("SMALL", 10, 5, false),
        ("EMPTY", 0, 0, false),
        ("DEEP", 500, 1, false),
        ("WIDE", 500, 3, false),
    ]);
    let now = Instant::now();
    assert_eq!(
        tried(state.next(None, "s1".into(), now)),
        Some("WIDE".into())
    );
    assert!(matches!(
        state.next(Some("stale"), "x".into(), now),
        Next::Ignore
    ));
    assert_eq!(
        tried(state.next(Some("s1"), "s2".into(), now)),
        Some("DEEP".into())
    );
    state.rooms = 2;
    assert_eq!(
        tried(state.next(Some("s2"), "s3".into(), now)),
        Some("SMALL".into())
    );
    assert!(tried(state.next(Some("s3"), "s4".into(), now)).is_none());
    assert!(matches!(state.phase, Phase::Idle));
    assert_eq!(state.outcome, Some(SearchPeerOutcome::Interrupted));
    assert_eq!(
        statuses(&state),
        [
            SearchPeerCandidateStatus::Failed,
            SearchPeerCandidateStatus::Failed,
            SearchPeerCandidateStatus::Failed,
            SearchPeerCandidateStatus::Waiting,
        ]
    );
}

#[test]
fn devices_ranked_below_this_one_are_not_copied_from() {
    let mut state = state_with(&[
        ("BUSY_SMALL", 40, 9, true),
        ("SMALL", 100, 1, false),
        ("SAME", 100, 2, false),
    ]);
    state.own = (100, 2);
    assert!(matches!(
        state.next(None, "s1".into(), Instant::now()),
        Next::Finished(SearchPeerOutcome::NothingToCopy)
    ));

    let mut state = state_with(&[("SMALL", 10, 0, false), ("BIG", 500, 0, false)]);
    state.own = (100, 0);
    let now = Instant::now();
    assert_eq!(
        tried(state.next(None, "s1".into(), now)),
        Some("BIG".into())
    );
    assert!(matches!(
        state.next(Some("s1"), "s2".into(), now),
        Next::Finished(SearchPeerOutcome::Failed)
    ));
}

#[test]
fn a_slow_connection_moves_on_to_the_next_device() {
    let mut state = state_with(&[("FAST", 10, 0, false), ("SLOW", 50, 0, false)]);
    let started = Instant::now();
    assert_eq!(state.overdue(started), None);
    assert_eq!(state.overdue(started + DISCOVERY), Some(Overdue::Discovery));
    assert_eq!(
        tried(state.next(None, "s1".into(), started)),
        Some("SLOW".into())
    );
    assert_eq!(state.overdue(started + CONNECT_TIMEOUT / 2), None);
    assert_eq!(
        state.overdue(started + CONNECT_TIMEOUT),
        Some(Overdue::Session {
            id: "s1".into(),
            sender: false
        })
    );
    assert_eq!(
        tried(state.next(Some("s1"), "s2".into(), started)),
        Some("FAST".into())
    );
}

#[test]
fn a_busy_best_device_is_waited_for_instead_of_a_worse_one() {
    let mut state = state_with(&[("BUSY", 50, 0, true), ("IDLE", 10, 0, false)]);
    let started = Instant::now();
    assert!(matches!(state.next(None, "s1".into(), started), Next::Wait));
    assert_eq!(state.overdue(started + BUSY_RETRY / 2), None);
    assert_eq!(state.overdue(started + BUSY_RETRY), Some(Overdue::Retry));
    assert!(state.begin("again".into(), started));
    assert_eq!(state.candidates.len(), 0);
}

#[test]
fn a_refused_request_waits_for_the_device_to_be_free() {
    let mut state = state_with(&[("BEST", 50, 0, false), ("OTHER", 10, 0, false)]);
    let now = Instant::now();
    assert_eq!(
        tried(state.next(None, "s1".into(), now)),
        Some("BEST".into())
    );
    assert!(!state.reply(<&DeviceId>::from("OTHER"), "s1", 10, 0, true));
    assert!(state.reply(<&DeviceId>::from("BEST"), "s1", 50, 0, true));
    assert!(matches!(
        state.next(Some("s1"), "s2".into(), now),
        Next::Wait
    ));
    assert_eq!(
        statuses(&state),
        [
            SearchPeerCandidateStatus::Busy,
            SearchPeerCandidateStatus::Waiting
        ]
    );
}

#[test]
fn sessions_expire_when_idle() {
    let mut state = State::default();
    let opened = Instant::now();
    state.phase = Phase::Sending(Session::new(
        "s".into(),
        "DEVICE".into(),
        Transfer::Sending(None),
        opened,
    ));
    assert_eq!(state.overdue(opened + SESSION_TIMEOUT / 2), None);
    assert_eq!(
        state.overdue(opened + SESSION_TIMEOUT),
        Some(Overdue::Session {
            id: "s".into(),
            sender: true
        })
    );
}

#[test]
fn discovery_reports_why_nothing_was_copied() {
    let finished = |state: &mut State, failed| match state.next(failed, "t".into(), Instant::now())
    {
        Next::Finished(outcome) => Some(outcome),
        _ => None,
    };
    let mut silent = state_with(&[]);
    assert_eq!(
        finished(&mut silent, None),
        Some(SearchPeerOutcome::NoAnswer)
    );
    assert_eq!(silent.outcome, Some(SearchPeerOutcome::NoAnswer));

    let mut empty = state_with(&[("A", 0, 0, false)]);
    assert_eq!(
        finished(&mut empty, None),
        Some(SearchPeerOutcome::NothingToCopy)
    );

    let mut unreachable = state_with(&[("A", 5, 0, false)]);
    unreachable.next(None, "s".into(), Instant::now());
    assert_eq!(
        finished(&mut unreachable, Some("s")),
        Some(SearchPeerOutcome::Failed)
    );
}

#[test]
fn discovery_events_use_the_documented_fields() {
    let mut content = ToDeviceSearchPeerEventContent::new(
        "s".into(),
        Discovery::Info {
            documents: 2,
            complete_rooms: 3,
            busy: false,
        },
    );
    content.timestamp = 1;
    assert_eq!(
        serde_json::to_value(&content).unwrap(),
        serde_json::json!({
            "version": 4,
            "session": "s",
            "timestamp": 1,
            "kind": "info",
            "documents": 2,
            "complete_rooms": 3,
            "busy": false,
        })
    );
    let request: ToDeviceSearchPeerEventContent = serde_json::from_value(
        serde_json::json!({"version": 4, "session": "s", "timestamp": 1, "kind": "request"}),
    )
    .unwrap();
    assert_eq!(request.kind, Discovery::Request);
    serde_json::from_value::<ToDeviceSearchPeerEventContent>(serde_json::json!({
        "session": "s",
        "timestamp": 1,
        "kind": "request",
    }))
    .unwrap_err();
}

fn rtc_signals(
    events: &mut tokio::sync::mpsc::UnboundedReceiver<CoreEvent>,
) -> Vec<(String, RtcSignal)> {
    let mut signals = Vec::new();
    while let Ok(event) = events.try_recv() {
        if let CoreEvent::Rtc {
            session_id, signal, ..
        } = event
        {
            signals.push((session_id, signal));
        }
    }
    signals
}

fn sending_to(core: &Core) -> Option<(String, OwnedDeviceId)> {
    match &core.search_sharing.state.lock().phase {
        Phase::Sending(session) => Some((session.id.clone(), session.device.clone())),
        _ => None,
    }
}

#[tokio::test]
async fn one_device_is_served_at_a_time() {
    let (core, mut events) = Core::new(
        "peer-serve",
        Box::new(crate::store::MemorySessionStore::default()),
    );
    let client = Client::builder()
        .homeserver_url("http://localhost")
        .build()
        .await
        .unwrap();
    let generation = core.lifecycle.current();
    core.serve_search_peer(&client, generation, "a1".into(), "A".into())
        .await;
    core.serve_search_peer(&client, generation, "a2".into(), "A".into())
        .await;
    core.serve_search_peer(&client, generation, "b1".into(), "B".into())
        .await;
    assert_eq!(sending_to(&core), Some(("a2".into(), "A".into())));
    assert_eq!(
        rtc_signals(&mut events),
        [
            ("a1".into(), RtcSignal::Open),
            ("a1".into(), RtcSignal::Close),
            ("a2".into(), RtcSignal::Open),
        ]
    );
    core.close_search_peer(&client, "a2").await;
    core.serve_search_peer(&client, generation, "b2".into(), "B".into())
        .await;
    assert_eq!(sending_to(&core), Some(("b2".into(), "B".into())));
}

#[tokio::test]
async fn sharing_changes_are_pushed_as_events() {
    let (core, mut events) = Core::new(
        "peer-events",
        Box::new(crate::store::MemorySessionStore::default()),
    );
    core.search_sharing.enabled.store(true, Ordering::Relaxed);
    core.update_sharing(|state| state.begin("query".into(), Instant::now()));
    core.update_sharing(|state| state.available = true);
    let states: Vec<_> = std::iter::from_fn(|| events.try_recv().ok())
        .filter_map(|event| match event {
            CoreEvent::SearchSharing { sharing } => Some(sharing.state),
            _ => None,
        })
        .collect();
    assert_eq!(states, [SearchPeerState::Discovering]);
}

#[test]
fn history_parts_do_not_split_events_with_the_same_timestamp() {
    let history = History::new(
        (0..8)
            .map(|n| {
                document(
                    &format!("m{n}"),
                    "hello",
                    "@kris:localhost",
                    n / 2,
                    None,
                    Vec::new(),
                )
            })
            .collect(),
        Vec::new(),
        HashMap::new(),
        Vec::new(),
    );
    let spans = history.pack(0, 4, 1);
    assert_eq!(spans, [(0, 1), (1, 2), (2, 3), (3, 4)]);
    for (start, end) in spans {
        assert_eq!(history.slice(start, end).documents.len(), 2);
    }
}

#[test]
fn shared_coverage_keeps_gaps_and_local_crawl_progress() {
    use crate::search::persist::Cover;
    let local = Cover {
        from: 10,
        until: 20,
        resume: Some("local".into()),
        stops: true,
        ..Default::default()
    };
    assert_eq!(
        super::super::merged_cover(Some(&local), 30, 40, None, None, true),
        local
    );
    let joined = super::super::merged_cover(Some(&local), 5, 10, Some("peer"), None, true);
    assert_eq!((joined.from, joined.until), (5, 20));
    assert_eq!(joined.resume.as_deref(), Some("peer"));
    assert!(joined.stops);
    let partial = super::super::merged_cover(None, 5, 10, Some("peer"), None, true);
    assert!(!partial.stops);
}

#[tokio::test]
async fn a_stale_peer_does_not_replace_a_newer_local_edit() {
    use crate::search::{MessageIndex, tests::in_room};
    let room = matrix_sdk::ruma::room_id!("!peer:localhost").to_owned();
    let mut index = MessageIndex::new();
    let mut local = document("edited", "revised", "@kris:localhost", 10, None, Vec::new());
    local.edited_at = Some(30);
    index
        .import(&room, vec![local.clone()], Vec::new(), Vec::new())
        .await;
    local.body = "original".into();
    local.edited_at = Some(20);
    index
        .import(&room, vec![local], Vec::new(), Vec::new())
        .await;
    assert_eq!(in_room(&index, &room, "revised", 10, 0).len(), 1);
    assert!(in_room(&index, &room, "original", 10, 0).is_empty());
}

#[test]
fn a_copy_is_due_until_one_succeeds_and_again_after_a_week() {
    let mut saved: Saved = serde_json::from_str("{}").unwrap();
    assert!(saved.copy_due());
    saved = serde_json::from_value(serde_json::json!({ "synced_at": now_ms() })).unwrap();
    assert!(!saved.copy_due());
    saved = serde_json::from_value(
        serde_json::json!({ "synced_at": now_ms() - 8 * 24 * 60 * 60 * 1000 }),
    )
    .unwrap();
    assert!(saved.copy_due());
}

#[tokio::test]
async fn the_automatic_copy_runs_once_and_a_failed_start_does_not_count() {
    let (core, _events) = Core::new(
        "peer-auto",
        Box::new(crate::store::MemorySessionStore::default()),
    );
    core.search_sharing.enabled.store(true, Ordering::Relaxed);
    core.search_foreground.store(true, Ordering::Relaxed);
    core.update_network_conditions(true, true).await;
    core.start_search_peers().await.unwrap_err();
    core.start_search_peers().await.unwrap_err();
    core.search_sharing.state.lock().auto_tried = true;
    core.start_search_peers().await.unwrap();
    core.cancel_search_peers();
    core.start_search_peers().await.unwrap_err();
}

#[tokio::test]
async fn metered_policy_interrupts_a_copy_and_reports_the_pause() {
    let (core, mut events) = Core::new(
        "peer-policy",
        Box::new(crate::store::MemorySessionStore::default()),
    );
    let sharing = &core.search_sharing;
    sharing.enabled.store(true, Ordering::Relaxed);
    core.update_network_conditions(true, true).await;
    {
        let mut state = sharing.state.lock();
        *state = state_with(&[("DEVICE", 5, 0, false)]);
        state.next(None, "session".into(), Instant::now());
    }
    core.open_rtc(
        RtcPurpose::SearchSharing,
        "session".into(),
        "DEVICE".into(),
        false,
    );
    core.update_network_conditions(true, false).await;
    assert!(sharing.state.lock().phase.session().is_none());
    assert_eq!(
        rtc_signals(&mut events),
        [("session".into(), RtcSignal::Close)]
    );
    let view = core.search_sharing_view();
    assert_eq!(view.state, SearchPeerState::Idle);
    assert_eq!(view.pause, Some(SearchPeerPause::Metered));
    assert_eq!(view.outcome, Some(SearchPeerOutcome::Interrupted));
    core.exchange_search_peer("session", None)
        .await
        .unwrap_err();
}

fn shown_pauses(
    events: &mut tokio::sync::mpsc::UnboundedReceiver<CoreEvent>,
) -> Vec<Option<SearchPeerPause>> {
    std::iter::from_fn(|| events.try_recv().ok())
        .filter_map(|event| match event {
            CoreEvent::SearchSharing { sharing } => Some(sharing.pause),
            _ => None,
        })
        .collect()
}

#[tokio::test]
async fn returning_conditions_tell_the_page_that_peers_may_resume() {
    let (core, mut events) = Core::new(
        "peer-resume",
        Box::new(crate::store::MemorySessionStore::default()),
    );
    core.search_sharing.enabled.store(true, Ordering::Relaxed);

    core.update_network_conditions(false, true).await;
    core.update_network_conditions(true, true).await;
    assert_eq!(
        shown_pauses(&mut events),
        [Some(SearchPeerPause::Offline), None]
    );

    core.update_app_in_foreground(false);
    core.update_app_in_foreground(true);
    assert_eq!(
        shown_pauses(&mut events),
        [Some(SearchPeerPause::Background), None]
    );
}

async fn live_core(
    client: &Client,
    name: &str,
) -> (Arc<Core>, tokio::sync::mpsc::UnboundedReceiver<CoreEvent>) {
    let (core, events) = Core::new(name, Box::new(crate::store::MemorySessionStore::default()));
    core.search_sharing.enabled.store(true, Ordering::Relaxed);
    core.search_foreground.store(true, Ordering::Relaxed);
    *core.session.write().await = Some(crate::session::Session {
        account_id: name.into(),
        client: client.clone(),
        sync_service: Arc::new(
            matrix_sdk_ui::sync_service::SyncService::builder(client.clone())
                .build()
                .await
                .unwrap(),
        ),
        homeserver: client.homeserver().to_string(),
        oauth: false,
    });
    let generation = core.lifecycle.current();
    core.watch_search_peers(client, generation);
    core.watch_rtc(client, generation);
    (core, events)
}

#[tokio::test]
async fn a_session_ending_during_a_copy_does_not_deadlock() {
    let server = matrix_sdk::test_utils::mocks::MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    let (core, _events) = live_core(&client, "peer-teardown").await;
    let flushing = core.search_flush.lock().await;
    let copying = core.copying_session().await.unwrap();
    let ending = core.take_session();
    tokio::pin!(ending);
    assert!(futures_util::poll!(ending.as_mut()).is_pending());
    drop(flushing);

    let saving = core.save_rooms(&client, Vec::new());
    tokio::pin!(saving);
    tokio::time::timeout(std::time::Duration::from_secs(5), saving)
        .await
        .expect("a copy must be able to save while a session is ending");
    drop(copying);
    assert!(ending.await.is_some());
}

#[tokio::test]
async fn a_peer_message_handled_while_a_session_ends_does_not_deadlock() {
    let server = matrix_sdk::test_utils::mocks::MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    let (core, _events) = live_core(&client, "peer-reentry").await;
    let handling = core.session.read().await;
    let ending = core.take_session();
    tokio::pin!(ending);
    assert!(futures_util::poll!(ending.as_mut()).is_pending());

    tokio::time::timeout(
        std::time::Duration::from_secs(5),
        core.next_search_peer(&client, None),
    )
    .await
    .expect("handling a peer message must not wait for the session it holds");
    drop(handling);
    assert!(ending.await.is_some());
}

async fn trust(client: &Client, other: &Client) {
    let user = client.user_id().unwrap();
    client
        .encryption()
        .request_user_identity(user)
        .await
        .unwrap();
    client
        .encryption()
        .get_device(user, other.device_id().unwrap())
        .await
        .unwrap()
        .unwrap()
        .set_local_trust(matrix_sdk_base::crypto::LocalTrust::Verified)
        .await
        .unwrap();
}

/// Gives both cores a fresh session as if the target asked the source again.
fn reopen(source: &Core, target: &Core, id: &str, devices: [&Client; 2]) {
    let [source_device, target_device] =
        devices.map(|client| client.device_id().unwrap().to_owned());
    let now = Instant::now();
    source.search_sharing.state.lock().phase = Phase::Sending(Session::new(
        id.into(),
        target_device,
        Transfer::Sending(None),
        now,
    ));
    target.search_sharing.state.lock().phase = Phase::Receiving(Session::new(
        id.into(),
        source_device,
        Transfer::Receiving(Download::default()),
        now,
    ));
}

async fn exchange(source: &Core, target: &Core, id: &str) -> usize {
    let mut frames = VecDeque::from([(
        false,
        target
            .exchange_search_peer(id, None)
            .await
            .unwrap()
            .unwrap(),
    )]);
    let mut payloads = 0;
    while let Some((to_target, frame)) = frames.pop_front() {
        if matches!(
            rmp_serde::from_slice(&frame),
            Ok(transfer::Message::Data { .. })
        ) {
            payloads += 1;
        }
        let receiver = if to_target { target } else { source };
        if let Some(reply) = receiver
            .exchange_search_peer(id, Some(frame))
            .await
            .unwrap()
        {
            frames.push_back((!to_target, reply));
        }
    }
    payloads
}

#[tokio::test]
#[ignore = "needs SABLE_TEST_HOMESERVER"]
#[expect(clippy::too_many_lines, reason = "one sequential live flow")]
async fn verified_devices_copy_history_and_changes() {
    use super::super::live::{crawl_to_start, crawled_room, login, needles};
    use matrix_sdk::config::SyncSettings;
    use std::time::Duration;

    let base = std::env::var("SABLE_TEST_HOMESERVER").unwrap();
    let account = crate::live_member_tests::register(
        &reqwest::Client::new(),
        &base,
        &format!("peer{}", now_ms()),
    )
    .await;
    let (source, room) = crawled_room(&base, &account.user_id).await;
    let reader = login(&base, &account.user_id).await;
    reader.sync_once(SyncSettings::default()).await.unwrap();
    trust(&source, &reader).await;
    trust(&reader, &source).await;
    let (writer, mut writer_events) = live_core(&source, "peer-source").await;
    let (target, _target_events) = live_core(&reader, "peer-reader").await;
    crawl_to_start(&writer, &source, &room).await;
    writer.start_search_peers().await.unwrap();
    target.find_search_peers().await.unwrap();
    let id = tokio::time::timeout(Duration::from_secs(40), async {
        loop {
            for client in [&source, &reader] {
                client
                    .sync_once(SyncSettings::default().timeout(Duration::from_millis(100)))
                    .await
                    .unwrap();
            }
            while let Ok(event) = writer_events.try_recv() {
                if let CoreEvent::Rtc {
                    session_id,
                    purpose: RtcPurpose::SearchSharing,
                    sender: true,
                    signal: RtcSignal::Open,
                } = event
                {
                    return session_id;
                }
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
    })
    .await
    .unwrap();
    let view = target.search_sharing_view();
    assert_eq!(view.state, SearchPeerState::Connecting);
    assert_eq!(view.candidates.len(), 1);
    assert_eq!(needles(&target, &room).await, 0);
    assert!(exchange(&writer, &target, &id).await >= 2);
    assert_eq!(needles(&target, &room).await, 30);
    assert!(target.search_crawl.lock().await.cover_of(&room).is_some());
    let view = target.search_sharing_view();
    assert_eq!(view.rooms_copied, 1);
    assert_eq!(view.state, SearchPeerState::Idle);
    assert_eq!(view.outcome, Some(SearchPeerOutcome::Completed));
    assert_eq!(view.last_copy.map(|copy| copy.rooms), Some(1));
    target.exchange_search_peer(&id, None).await.unwrap_err();
    reopen(&writer, &target, &id, [&source, &reader]);
    assert_eq!(exchange(&writer, &target, &id).await, 0);

    let event_id = super::super::settled_history(&source, &room)
        .await
        .unwrap()
        .documents
        .into_iter()
        .find(|document| document.body.starts_with("needle number "))
        .unwrap()
        .event_id;
    let source_room = source.get_room(&room).unwrap();
    let edit = source_room
        .make_edit_event(
            &event_id,
            matrix_sdk::room::edit::EditedContent::RoomMessage(
                matrix_sdk::ruma::events::room::message::RoomMessageEventContentWithoutRelation::text_plain(
                    "needle revised",
                ),
            ),
        )
        .await
        .unwrap();
    source_room.send(edit).await.unwrap();
    source.sync_once(SyncSettings::default()).await.unwrap();
    crawl_to_start(&writer, &source, &room).await;
    reopen(&writer, &target, &id, [&source, &reader]);
    assert!(exchange(&writer, &target, &id).await > 0);
    assert_eq!(
        crate::search::tests::in_room(&*target.search_index.lock().await, &room, "revised", 10, 0)
            .len(),
        1,
    );

    source_room.redact(&event_id, None, None).await.unwrap();
    source.sync_once(SyncSettings::default()).await.unwrap();
    crawl_to_start(&writer, &source, &room).await;
    reopen(&writer, &target, &id, [&source, &reader]);
    assert!(exchange(&writer, &target, &id).await > 0);
    assert_eq!(needles(&target, &room).await, 29);
    reopen(&writer, &target, &id, [&source, &reader]);
    assert_eq!(exchange(&writer, &target, &id).await, 0);
    assert!(!target.known_parts(&room).is_empty());
    reopen(&writer, &target, &id, [&source, &reader]);
    reader
        .encryption()
        .get_device(reader.user_id().unwrap(), source.device_id().unwrap())
        .await
        .unwrap()
        .unwrap()
        .set_local_trust(matrix_sdk_base::crypto::LocalTrust::BlackListed)
        .await
        .unwrap();
    target.exchange_search_peer(&id, None).await.unwrap_err();

    target.forget_search_sharing(&reader).await;
    let view = target.search_sharing_view();
    assert_eq!(view.rooms_copied, 0);
    assert!(view.last_copy.is_none());
    assert!(view.automatic);
    target.search_sharing.state.lock().saved = None;
    target.load_saved(&reader).await;
    assert!(target.known_parts(&room).is_empty());
}

#[cfg(not(target_family = "wasm"))]
#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs SABLE_TEST_HOMESERVER and installed Playwright browsers"]
async fn browsers_transfer_verified_search_history() {
    use super::super::live::{crawl_to_start, crawled_room, login, needles};
    use matrix_sdk::config::SyncSettings;

    let base = std::env::var("SABLE_TEST_HOMESERVER").unwrap();
    let account = crate::live_member_tests::register(
        &reqwest::Client::new(),
        &base,
        &format!("browserpeer{}", now_ms()),
    )
    .await;
    let (source, room) = crawled_room(&base, &account.user_id).await;
    for n in 0..30 {
        let mut noise = [0_u8; 4096];
        getrandom::fill(&mut noise).unwrap();
        source
            .get_room(&room)
            .unwrap()
            .send(
                matrix_sdk::ruma::events::room::message::RoomMessageEventContent::text_plain(
                    format!("needle extra {n} {}", STANDARD_NO_PAD.encode(noise)),
                ),
            )
            .await
            .unwrap();
    }
    source.sync_once(SyncSettings::default()).await.unwrap();
    let reader = login(&base, &account.user_id).await;
    reader.sync_once(SyncSettings::default()).await.unwrap();
    trust(&source, &reader).await;
    trust(&reader, &source).await;
    let (writer, writer_events) = live_core(&source, "browser-peer-source").await;
    let (target, target_events) = live_core(&reader, "browser-peer-reader").await;
    crawl_to_start(&writer, &source, &room).await;
    assert_eq!(needles(&target, &room).await, 0);
    browser::exchange(
        [&writer, &target],
        [&source, &reader],
        [writer_events, target_events],
    )
    .await;
    assert_eq!(needles(&target, &room).await, 60);
    assert!(target.search_crawl.lock().await.cover_of(&room).is_some());
    assert!(writer.search_sharing.state.lock().phase.session().is_none());
    assert!(target.search_sharing.state.lock().phase.session().is_none());
}
