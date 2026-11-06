#[cfg(not(target_family = "wasm"))]
mod browser;

use std::collections::{HashSet, VecDeque};

use super::super::{History, STANDARD_NO_PAD};
use super::*;
use crate::search::tests::document;

#[test]
fn unanswered_probe_sessions_expire() {
    let sharing = SearchSharing::default();
    sharing
        .peers
        .lock()
        .insert("session".into(), Peer::new("DEVICE".into(), true, 100));
    sharing.remove_expired(100 + SESSION_MS - 1);
    assert!(sharing.peers.lock().contains_key("session"));
    sharing.remove_expired(100 + SESSION_MS);
    assert!(sharing.peers.lock().is_empty());
}

#[test]
fn discovery_rotates_between_devices_after_probes_expire() {
    let sharing = SearchSharing::default();
    let mut attempted = HashSet::new();
    for _ in 0..3 {
        let mut candidates = ["A", "B", "C"];
        sharing.rotate_probe_candidates(&mut candidates);
        attempted.extend(candidates.into_iter().take(MAX_PEERS));
    }
    assert_eq!(attempted, HashSet::from(["A", "B", "C"]));
}

#[tokio::test]
async fn discovery_is_rate_limited_in_the_core() {
    let (core, _) = Core::new(
        "peer-rate-limit",
        Box::new(crate::store::MemorySessionStore::default()),
    );
    core.search_sharing.enabled.store(true, Ordering::Relaxed);
    core.set_search_network_unmetered(true);
    let now = now_ms();
    core.search_sharing.last_start.store(now, Ordering::Relaxed);
    core.start_search_peers().await.unwrap();
    core.search_sharing
        .last_start
        .store(now.saturating_sub(RETRY_MS), Ordering::Relaxed);
    assert!(matches!(
        core.start_search_peers().await,
        Err(RpcError::NotLoggedIn)
    ));
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

#[tokio::test]
async fn discovery_keeps_active_transfers_and_metered_policy_closes_them() {
    let (core, mut events) = Core::new(
        "peer-policy",
        Box::new(crate::store::MemorySessionStore::default()),
    );
    let peers = &core.search_sharing;
    peers.enabled.store(true, Ordering::Relaxed);
    peers
        .peers
        .lock()
        .insert("session".into(), Peer::new("DEVICE".into(), true, now_ms()));
    core.open_rtc(
        RtcPurpose::SearchSharing,
        "session".into(),
        "DEVICE".into(),
        true,
    );
    core.start_search_peers().await.unwrap();
    assert!(peers.peers.lock().contains_key("session"));
    core.set_search_network_unmetered(false);
    assert!(peers.peers.lock().is_empty());
    assert!(matches!(
        events.recv().await,
        Some(CoreEvent::Rtc {
            signal: RtcSignal::Close,
            ..
        })
    ));
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
    core.watch_search_peers(client, core.session_generation.load(Ordering::SeqCst));
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
        if frame.contains("\"kind\":\"part\"") && !frame.contains("\"data\":null") {
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
    let (writer, _writer_events) = live_core(&source, "peer-source").await;
    let (target, mut target_events) = live_core(&reader, "peer-reader").await;
    crawl_to_start(&writer, &source, &room).await;
    writer.start_search_peers().await.unwrap();
    target.start_search_peers().await.unwrap();
    for _ in 0..3 {
        for client in [&source, &reader] {
            client
                .sync_once(SyncSettings::default().timeout(Duration::from_millis(100)))
                .await
                .unwrap();
        }
    }
    let id = tokio::time::timeout(Duration::from_secs(5), async {
        while let Some(event) = target_events.recv().await {
            if let CoreEvent::Rtc {
                session_id,
                sender: true,
                signal: RtcSignal::Open,
            } = event
            {
                return session_id;
            }
        }
        panic!("event channel closed");
    })
    .await
    .unwrap();
    assert_eq!(needles(&target, &room).await, 0);
    assert!(exchange(&writer, &target, &id).await >= 2);
    assert_eq!(needles(&target, &room).await, 30);
    assert!(target.search_crawl.lock().await.cover_of(&room).is_some());
    assert_eq!(target.search_sharing.view().rooms_received, 1);
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
            .rooms
            .contains(&room)
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
    assert!(writer.search_sharing.peers.lock().is_empty());
    assert!(target.search_sharing.peers.lock().is_empty());
}
