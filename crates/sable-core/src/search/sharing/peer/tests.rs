#[cfg(not(target_family = "wasm"))]
mod browser;

use std::collections::VecDeque;

use super::super::{History, STANDARD_NO_PAD};
use super::*;
use crate::search::tests::document;

fn catchup_with(devices: &[(&str, u64, u64)]) -> Catchup {
    let mut catchup = Catchup::default();
    catchup.begin("query".into(), Instant::now());
    catchup.asked = devices
        .iter()
        .map(|(device, ..)| ((*device).into(), Some(format!("{device} name"))))
        .collect();
    for (device, documents, complete_rooms) in devices {
        catchup.reply(
            <&DeviceId>::from(*device),
            "query",
            *documents,
            *complete_rooms,
        );
    }
    catchup
}

fn tried(next: Next) -> Option<OwnedDeviceId> {
    match next {
        Next::Try(device) => Some(device),
        Next::Ignore | Next::Finished(_) => None,
    }
}

#[test]
fn unanswered_sessions_expire() {
    let opened = Instant::now();
    let mut slots = HashMap::from([(
        "session".into(),
        Slot::new(Role::Requester, "DEVICE".into(), opened),
    )]);
    SearchSharing::remove_expired(&mut slots, opened + SESSION_TIMEOUT / 2);
    assert!(slots.contains_key("session"));
    SearchSharing::remove_expired(&mut slots, opened + SESSION_TIMEOUT);
    assert!(slots.is_empty());
}

#[test]
fn only_asked_devices_answering_the_current_query_become_candidates() {
    let mut catchup = catchup_with(&[("A", 10, 0)]);
    catchup.reply(<&DeviceId>::from("A"), "query", 99, 0);
    catchup.reply(<&DeviceId>::from("B"), "query", 50, 0);
    catchup.reply(<&DeviceId>::from("A"), "other", 50, 0);
    assert_eq!(catchup.candidates.len(), 1);
    assert_eq!(catchup.candidates[0].documents, 10);
    assert_eq!(catchup.candidates[0].name.as_deref(), Some("A name"));
}

#[test]
fn deep_history_is_tried_first_and_failures_move_to_the_next_device() {
    let mut catchup = catchup_with(&[
        ("SMALL", 10, 5),
        ("EMPTY", 0, 0),
        ("DEEP", 500, 1),
        ("WIDE", 500, 3),
    ]);
    assert_eq!(
        tried(catchup.next(None, "s1".into(), Instant::now())),
        Some("WIDE".into())
    );
    assert!(matches!(
        catchup.next(Some("stale"), "x".into(), Instant::now()),
        Next::Ignore
    ));
    assert_eq!(
        tried(catchup.next(Some("s1"), "s2".into(), Instant::now())),
        Some("DEEP".into())
    );
    catchup.rooms = 2;
    assert_eq!(
        tried(catchup.next(Some("s2"), "s3".into(), Instant::now())),
        Some("SMALL".into())
    );
    assert!(tried(catchup.next(Some("s3"), "s4".into(), Instant::now())).is_none());
    assert_eq!(catchup.phase, Phase::Idle);
    assert_eq!(catchup.outcome, Some(SearchPeerOutcome::Interrupted));
    assert_eq!(
        catchup
            .candidates
            .iter()
            .map(|candidate| candidate.status)
            .collect::<Vec<_>>(),
        [
            SearchPeerCandidateStatus::Failed,
            SearchPeerCandidateStatus::Failed,
            SearchPeerCandidateStatus::Failed,
            SearchPeerCandidateStatus::Waiting,
        ]
    );
}

#[test]
fn a_slow_connection_moves_on_to_the_next_device() {
    let mut catchup = catchup_with(&[("FAST", 10, 0), ("SLOW", 50, 0)]);
    let started = Instant::now();
    assert_eq!(catchup.overdue(started), None);
    assert_eq!(
        catchup.overdue(started + DISCOVERY),
        Some(Overdue::Discovery)
    );
    assert_eq!(
        tried(catchup.next(None, "s1".into(), started)),
        Some("SLOW".into())
    );
    assert_eq!(catchup.overdue(started + CONNECT_TIMEOUT / 2), None);
    assert_eq!(
        catchup.overdue(started + CONNECT_TIMEOUT),
        Some(Overdue::Connection("s1".into()))
    );
    assert_eq!(
        tried(catchup.next(Some("s1"), "s2".into(), started)),
        Some("FAST".into())
    );
}

#[test]
fn discovery_reports_why_nothing_was_copied() {
    let finished =
        |catchup: &mut Catchup, failed| match catchup.next(failed, "t".into(), Instant::now()) {
            Next::Finished(outcome) => Some(outcome),
            _ => None,
        };
    let mut silent = catchup_with(&[]);
    assert_eq!(
        finished(&mut silent, None),
        Some(SearchPeerOutcome::NoAnswer)
    );
    assert_eq!(silent.outcome, Some(SearchPeerOutcome::NoAnswer));

    let mut empty = catchup_with(&[("A", 0, 0)]);
    assert_eq!(
        finished(&mut empty, None),
        Some(SearchPeerOutcome::NothingToCopy)
    );

    let mut unreachable = catchup_with(&[("A", 5, 0)]);
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
        },
    );
    content.timestamp = 1;
    assert_eq!(
        serde_json::to_value(&content).unwrap(),
        serde_json::json!({
            "version": 2,
            "session": "s",
            "timestamp": 1,
            "kind": "info",
            "documents": 2,
            "complete_rooms": 3,
        })
    );
    let request: ToDeviceSearchPeerEventContent = serde_json::from_value(
        serde_json::json!({"version": 2, "session": "s", "timestamp": 1, "kind": "request"}),
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

#[tokio::test]
async fn each_device_gets_one_served_session_and_the_rest_wait() {
    let (core, mut events) = Core::new(
        "peer-serve",
        Box::new(crate::store::MemorySessionStore::default()),
    );
    let generation = core.session_generation.load(Ordering::SeqCst);
    core.serve_search_peer(generation, "a1".into(), "A".into());
    core.serve_search_peer(generation, "a2".into(), "A".into());
    core.serve_search_peer(generation, "b1".into(), "B".into());
    core.serve_search_peer(generation, "c1".into(), "C".into());
    let mut slots: Vec<_> = core.search_sharing.slots.lock().keys().cloned().collect();
    slots.sort();
    assert_eq!(slots, ["a2", "b1"]);
    let mut signals = Vec::new();
    while let Ok(CoreEvent::Rtc {
        session_id, signal, ..
    }) = events.try_recv()
    {
        signals.push((session_id, signal));
    }
    assert_eq!(
        signals,
        [
            ("a1".into(), RtcSignal::Open),
            ("a1".into(), RtcSignal::Close),
            ("a2".into(), RtcSignal::Open),
            ("b1".into(), RtcSignal::Open),
        ]
    );
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
    let mut received = Received::default();
    assert!(received.copy_due());
    received.synced_at = Some(now_ms());
    assert!(!received.copy_due());
    received.synced_at = Some(now_ms() - 8 * 24 * 60 * 60 * 1000);
    assert!(received.copy_due());
}

#[tokio::test]
async fn the_automatic_copy_runs_once_and_a_failed_start_does_not_count() {
    let (core, _events) = Core::new(
        "peer-auto",
        Box::new(crate::store::MemorySessionStore::default()),
    );
    core.search_sharing.enabled.store(true, Ordering::Relaxed);
    core.search_foreground.store(true, Ordering::Relaxed);
    core.set_search_network_unmetered(true);
    core.start_search_peers().await.unwrap_err();
    core.start_search_peers().await.unwrap_err();
    core.search_sharing
        .auto_tried
        .store(true, Ordering::Relaxed);
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
    core.set_search_network_unmetered(true);
    sharing.slots.lock().insert(
        "session".into(),
        Slot::new(Role::Requester, "DEVICE".into(), Instant::now()),
    );
    *sharing.catchup.lock() = catchup_with(&[("DEVICE", 5, 0)]);
    sharing
        .catchup
        .lock()
        .next(None, "session".into(), Instant::now());
    core.open_rtc(
        RtcPurpose::SearchSharing,
        "session".into(),
        "DEVICE".into(),
        false,
    );
    core.set_search_network_unmetered(false);
    assert!(sharing.slots.lock().is_empty());
    assert!(matches!(
        events.recv().await,
        Some(CoreEvent::Rtc {
            signal: RtcSignal::Close,
            ..
        })
    ));
    let view = core.search_sharing_view().await;
    assert_eq!(view.state, SearchPeerState::Idle);
    assert_eq!(view.pause, Some(SearchPeerPause::Metered));
    assert_eq!(view.outcome, Some(SearchPeerOutcome::Interrupted));
    core.exchange_search_peer("session", None)
        .await
        .unwrap_err();
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
    let generation = core.session_generation.load(Ordering::SeqCst);
    core.watch_search_peers(client, generation);
    core.watch_rtc(client, generation);
    (core, events)
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
        if frame.contains("\"kind\":\"data\"") {
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
    let view = target.search_sharing_view().await;
    assert_eq!(view.state, SearchPeerState::Connecting);
    assert_eq!(view.candidates.len(), 1);
    assert_eq!(needles(&target, &room).await, 0);
    assert!(exchange(&writer, &target, &id).await >= 2);
    assert_eq!(needles(&target, &room).await, 30);
    assert!(target.search_crawl.lock().await.cover_of(&room).is_some());
    let view = target.search_sharing_view().await;
    assert_eq!(view.rooms_received, 1);
    assert_eq!(view.outcome, Some(SearchPeerOutcome::Completed));
    assert_eq!(view.last_copy.map(|copy| copy.rooms), Some(1));
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
    assert!(exchange(&writer, &target, &id).await > 0);
    assert_eq!(
        crate::search::tests::in_room(&*target.search_index.lock().await, &room, "revised", 10, 0)
            .len(),
        1,
    );

    source_room.redact(&event_id, None, None).await.unwrap();
    source.sync_once(SyncSettings::default()).await.unwrap();
    crawl_to_start(&writer, &source, &room).await;
    assert!(exchange(&writer, &target, &id).await > 0);
    assert_eq!(needles(&target, &room).await, 29);
    assert_eq!(exchange(&writer, &target, &id).await, 0);
    assert!(
        target
            .search_sharing
            .received
            .lock()
            .await
            .as_ref()
            .unwrap()
            .known
            .contains_key(&room)
    );
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
    let view = target.search_sharing_view().await;
    assert_eq!(view.rooms_received, 0);
    assert!(view.last_copy.is_none());
    assert!(view.automatic);
    target.search_sharing.received.lock().await.take();
    target.load_peer_receipts(&reader).await;
    let stored = target.search_sharing.received.lock().await;
    assert!(stored.as_ref().unwrap().known.is_empty());
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
    assert!(writer.search_sharing.slots.lock().is_empty());
    assert!(target.search_sharing.slots.lock().is_empty());
}
