use std::collections::{BTreeMap, HashMap};

use matrix_sdk::ruma::{OwnedRoomId, device_id, room_id};

use super::{
    BACKUP_EVENT, BACKUP_VERSION, BackupManifest, DAY_MS, History, MAX_SEGMENTS, Planned,
    RECENT_MS, Segment, open_manifest, plan,
};
use crate::sealed_account_data::AccountDataKey;
use crate::search::persist::{self, Cover, StoredCrawlRoom};
use crate::search::tests::document;
use crate::search::{CrawlProgress, MessageIndex};

const NOW: u64 = 400 * DAY_MS;

fn room() -> OwnedRoomId {
    room_id!("!backup:localhost").to_owned()
}

fn history(timestamps: impl IntoIterator<Item = u64>) -> History {
    let documents = timestamps
        .into_iter()
        .map(|ts| {
            document(
                &format!("m{ts}"),
                "x".repeat(400).as_str(),
                "@kris:localhost",
                ts,
                None,
                Vec::new(),
            )
        })
        .collect();
    History::new(documents, Vec::new(), HashMap::new())
}

fn file() -> matrix_sdk::ruma::events::room::EncryptedFile {
    serde_json::from_value(serde_json::json!({
        "url": "mxc://localhost/segment",
        "key": {
            "kty": "oct",
            "key_ops": ["encrypt", "decrypt"],
            "alg": "A256CTR",
            "k": "qcHVMSgYg-71CauWBezXI5qkaRb0LuIy-Wx5kIaHMIA",
            "ext": true
        },
        "iv": "X85+XgHN+HEAAAAAAAAAAA",
        "hashes": { "sha256": "5qG4fFnbbVdlAB1Q72JDKwCagV6Dbkx9uds4rSak37c" },
        "v": "v2"
    }))
    .expect("an encrypted file")
}

fn published(history: &History, from: u64, now: u64) -> Vec<Segment> {
    plan(history, Vec::new(), from, now, usize::MAX, true)
        .segments
        .into_iter()
        .map(|planned| {
            let Planned::Upload { start, end } = planned else {
                panic!("a first publish only uploads");
            };
            Segment {
                start,
                end,
                bytes: 1,
                sha256: history.hash(start, end).expect("a hash"),
                file: file(),
            }
        })
        .collect()
}

fn uploads(segments: &[Planned]) -> usize {
    segments
        .iter()
        .filter(|planned| matches!(planned, Planned::Upload { .. }))
        .count()
}

#[test]
fn test_a_first_publish_covers_settled_history_in_contiguous_segments() {
    let history = history((0..2_000).map(|n| NOW - 200 * DAY_MS + n * 8_000_000));
    let plan = plan(&history, Vec::new(), 0, NOW, usize::MAX, true);

    assert_eq!(plan.covered(), NOW - DAY_MS);
    let mut cursor = 0;
    for planned in &plan.segments {
        let Planned::Upload { start, end } = planned else {
            panic!("nothing to keep yet");
        };
        assert_eq!(*start, cursor);
        cursor = *end;
    }
    assert!(plan.segments.len() > 1);
}

#[test]
fn test_recent_history_is_cut_into_smaller_segments_than_old_history() {
    let old = history((0..2_000).map(|n| NOW - 300 * DAY_MS + n * 1_000));
    let recent = history((0..2_000).map(|n| NOW - 10 * DAY_MS + n * 1_000));

    let old_segments = plan(&old, Vec::new(), 0, NOW, usize::MAX, true)
        .segments
        .len();
    let recent_segments = plan(&recent, Vec::new(), 0, NOW, usize::MAX, true)
        .segments
        .len();

    assert!(recent_segments > old_segments);
}

#[test]
fn test_the_server_upload_limit_caps_the_segment_size() {
    let history = history((0..2_000).map(|n| NOW - 300 * DAY_MS + n * 1_000));

    let unlimited = plan(&history, Vec::new(), 0, NOW, usize::MAX, true)
        .segments
        .len();
    let limited = plan(&history, Vec::new(), 0, NOW, 64 * 1024, true)
        .segments
        .len();

    assert!(limited > unlimited);
}

#[test]
fn test_unchanged_history_republishes_nothing() {
    let history = history((0..500).map(|n| NOW - 100 * DAY_MS + n * 1_000));
    let previous = published(&history, 0, NOW);
    let covered = previous.last().expect("a segment").end;

    let next = plan(&history, previous, 0, NOW, usize::MAX, true);

    assert_eq!(uploads(&next.segments), 0);
    assert!(next.replaced.is_empty());
    assert!(next.covered() >= covered);
}

#[test]
fn test_a_changed_segment_is_the_only_one_uploaded_again() {
    let timestamps: Vec<u64> = (0..2_000).map(|n| NOW - 300 * DAY_MS + n * 1_000).collect();
    let before = history(timestamps.iter().copied());
    let previous = published(&before, 0, NOW);
    assert!(previous.len() > 1);

    let after = history(timestamps.iter().copied().skip(1));
    let next = plan(&after, previous, 0, NOW, usize::MAX, true);

    assert_eq!(next.replaced.len(), 1);
    assert_eq!(next.replaced[0].start, 0);
    assert!(uploads(&next.segments) >= 1);
    assert!(
        next.segments
            .iter()
            .skip(uploads(&next.segments))
            .all(|planned| matches!(planned, Planned::Keep(_)))
    );
}

#[test]
fn test_a_small_fresh_tail_waits_until_it_is_worth_a_segment() {
    let history = history((0..500).map(|n| NOW - 100 * DAY_MS + n * 1_000));
    let previous = published(&history, 0, NOW);
    let covered = previous.last().expect("a segment").end;

    let mut grown = history.documents;
    grown.push(document(
        "late",
        "late message",
        "@kris:localhost",
        covered + 1,
        None,
        Vec::new(),
    ));
    let grown = History::new(grown, Vec::new(), HashMap::new());

    let soon = plan(&grown, previous.clone(), 0, NOW + DAY_MS, usize::MAX, true);
    assert_eq!(uploads(&soon.segments), 0);
    assert_eq!(soon.covered(), covered);

    let later = plan(&grown, previous, 0, NOW + 8 * DAY_MS, usize::MAX, true);
    assert_eq!(uploads(&later.segments), 1);
}

#[test]
fn test_an_empty_stretch_extends_the_last_segment_without_an_upload() {
    let history = history((0..500).map(|n| NOW - 100 * DAY_MS + n * 1_000));
    let previous = published(&history, 0, NOW);

    let next = plan(&history, previous, 0, NOW + 30 * DAY_MS, usize::MAX, true);

    assert_eq!(uploads(&next.segments), 0);
    assert_eq!(next.covered(), NOW + 29 * DAY_MS);
}

#[test]
fn test_too_many_segments_are_merged_from_the_oldest() {
    let history = history((0..400).map(|n| n * DAY_MS / 2));
    let previous: Vec<Segment> = (0..400_u64)
        .map(|n| {
            let (start, end) = (
                if n == 0 { 0 } else { n * DAY_MS / 2 },
                (n + 1) * DAY_MS / 2,
            );
            Segment {
                start,
                end,
                bytes: 1,
                sha256: history.hash(start, end).expect("a hash"),
                file: file(),
            }
        })
        .collect();

    let next = plan(&history, previous, 0, NOW + RECENT_MS, usize::MAX, true);

    assert!(next.segments.len() <= MAX_SEGMENTS);
    assert!(!next.replaced.is_empty());
}

fn manifest(room_id: OwnedRoomId) -> BackupManifest {
    BackupManifest {
        version: BACKUP_VERSION,
        room_id,
        device_id: device_id!("PUBLISHER").to_owned(),
        schema: persist::SCHEMA,
        derivation: persist::DERIVATION,
        from: 0,
        covered: 10,
        resume: None,
        published_ms: NOW,
        segments: vec![Segment {
            start: 0,
            end: 10,
            bytes: 1,
            sha256: String::new(),
            file: file(),
        }],
    }
}

#[test]
fn test_a_manifest_opens_only_in_the_room_it_was_sealed_for() {
    let key = AccountDataKey::from_bytes([7; 32]);
    let sealed = key
        .seal(
            BACKUP_EVENT,
            &serde_json::to_value(manifest(room())).expect("json"),
        )
        .expect("sealed");

    assert!(open_manifest(&key, &room(), &sealed).is_some());
    assert!(open_manifest(&key, room_id!("!other:localhost"), &sealed).is_none());
    assert!(open_manifest(&AccountDataKey::from_bytes([8; 32]), &room(), &sealed).is_none());
}

#[test]
fn test_a_manifest_with_a_gap_is_rejected() {
    let key = AccountDataKey::from_bytes([7; 32]);
    let mut gapped = manifest(room());
    gapped.segments[0].start = 5;
    let sealed = key
        .seal(BACKUP_EVENT, &serde_json::to_value(gapped).expect("json"))
        .expect("sealed");

    assert!(open_manifest(&key, &room(), &sealed).is_none());
}

#[matrix_sdk_test::async_test]
async fn test_an_import_merges_without_undoing_a_newer_local_edit() {
    let room_id = room();
    let mut index = MessageIndex::new();
    let mut edited = document(
        "shared",
        "edited locally",
        "@kris:localhost",
        1_000,
        None,
        Vec::new(),
    );
    edited.edited_at = Some(5_000);
    index
        .import(&room_id, vec![edited], Vec::new(), Vec::new())
        .await;

    let mut stale = document(
        "shared",
        "original",
        "@kris:localhost",
        1_000,
        None,
        Vec::new(),
    );
    stale.edited_at = Some(2_000);
    let fresh = document(
        "fresh",
        "from the backup",
        "@kris:localhost",
        900,
        None,
        Vec::new(),
    );
    index
        .import(&room_id, vec![stale, fresh], Vec::new(), Vec::new())
        .await;

    assert_eq!(
        crate::search::tests::in_room(&index, &room_id, "edited", 10, 0).len(),
        1
    );
    assert!(crate::search::tests::in_room(&index, &room_id, "original", 10, 0).is_empty());
    assert_eq!(
        crate::search::tests::in_room(&index, &room_id, "backup", 10, 0).len(),
        1
    );
}

#[test]
fn test_a_cover_survives_a_checkpoint_round_trip() {
    let room_id = room();
    let cover = Cover {
        from: 7,
        until: 42,
        resume: Some("deeper".to_owned()),
        stops: true,
    };
    let mut progress = CrawlProgress::default();
    progress.cover(&room_id, cover.clone(), 0);

    let checkpoints = progress.checkpoints();
    assert_eq!(
        checkpoints
            .get(&room_id)
            .and_then(|room| room.cover.clone()),
        Some(cover.clone())
    );

    let mut restored = CrawlProgress::default();
    restored.restore(BTreeMap::from([(
        room_id.clone(),
        StoredCrawlRoom {
            token: None,
            reached_start: false,
            cover: Some(cover.clone()),
        },
    )]));
    assert_eq!(restored.cover_of(&room_id), Some(&cover));
}

#[test]
fn test_a_partial_backup_grows_downwards_without_touching_published_segments() {
    let history = history((0..500).map(|n| NOW - 100 * DAY_MS + n * 1_000));
    let from = NOW - 100 * DAY_MS + 250_000;
    let previous = published(&history, from, NOW);
    assert_eq!(previous.first().map(|segment| segment.start), Some(from));

    let deeper = NOW - 100 * DAY_MS;
    assert!(deeper < from);
    let next = plan(&history, previous, deeper, NOW, usize::MAX, true);
    assert!(matches!(
        next.segments.first(),
        Some(Planned::Upload { start, .. }) if *start == deeper
    ));
    assert!(
        next.segments
            .iter()
            .skip(uploads(&next.segments))
            .all(|planned| matches!(planned, Planned::Keep(_)))
    );
    assert!(next.replaced.is_empty());
}

#[test]
fn test_old_small_segments_are_merged_into_one() {
    let history = history((0..40).map(|n| n * DAY_MS));
    let previous: Vec<Segment> = (0..40_u64)
        .map(|n| {
            let (start, end) = (n * DAY_MS, (n + 1) * DAY_MS);
            Segment {
                start,
                end,
                bytes: 1,
                sha256: history.hash(start, end).expect("a hash"),
                file: file(),
            }
        })
        .collect();

    let next = plan(&history, previous, 0, NOW, usize::MAX, true);

    assert_eq!(next.segments.len(), 2);
    assert_eq!(next.replaced.len(), 39);
}

#[test]
fn test_old_segments_stay_put_on_a_server_that_cannot_delete_media() {
    let history = history((0..40).map(|n| n * DAY_MS));
    let previous: Vec<Segment> = (0..40_u64)
        .map(|n| {
            let (start, end) = (n * DAY_MS, (n + 1) * DAY_MS);
            Segment {
                start,
                end,
                bytes: 1,
                sha256: history.hash(start, end).expect("a hash"),
                file: file(),
            }
        })
        .collect();

    let next = plan(&history, previous, 0, NOW, usize::MAX, false);

    assert_eq!(uploads(&next.segments), 0);
    assert!(next.replaced.is_empty());
}

#[test]
fn test_a_partial_backup_stops_the_crawl_only_where_it_can_resume() {
    let mut partial = manifest(room());
    partial.from = 5;
    partial.segments[0].start = 5;
    partial.resume = Some("deeper".to_owned());

    let fresh = super::imported_cover(None, &partial, false);
    assert!(fresh.stops);
    assert_eq!(fresh.resume.as_deref(), Some("deeper"));

    let crawled = super::imported_cover(None, &partial, true);
    assert!(!crawled.stops);

    let complete = super::imported_cover(None, &manifest(room()), true);
    assert!(complete.stops);
}

#[test]
fn sharing_progress_tracks_completed_parts_and_clears_after_a_pass() {
    use crate::protocol::{SearchBackupActivity, SearchBackupState};
    use std::sync::atomic::Ordering;

    let backup = super::SearchBackup::default();
    backup.enabled.store(true, Ordering::Relaxed);
    backup.set_state(SearchBackupState::Working);
    backup.activity(SearchBackupActivity::Downloading, None);
    backup.transfer(4, Some(4096));
    backup.transferred(1024);
    backup.transferred(1024);
    let view = backup.view(3);
    let progress = view.progress.unwrap();
    assert_eq!(progress.parts_done, 2);
    assert_eq!(progress.parts_total, 4);
    assert_eq!(progress.transferred_bytes, 2048);
    assert_eq!(progress.total_bytes, Some(4096));
    assert_eq!(view.rooms_imported, 3);

    backup.set_state(SearchBackupState::Idle);
    assert!(backup.view(3).progress.is_none());
    backup.activity(SearchBackupActivity::Uploading, None);
    backup.transfer(2, None);
    let progress = backup.view(3).progress.unwrap();
    assert_eq!(progress.parts_done, 0);
    assert_eq!(progress.transferred_bytes, 0);
    assert_eq!(progress.total_bytes, None);
}

#[test]
fn sharing_reports_scheduling_failures_and_disabled_state() {
    use crate::protocol::{SearchBackupActivity, SearchBackupState};
    use std::sync::atomic::Ordering;

    let backup = super::SearchBackup::default();
    backup.enabled.store(true, Ordering::Relaxed);
    backup.schedule(super::BACKUP_START_DELAY);
    let view = backup.view(0);
    assert_eq!(view.state, SearchBackupState::Scheduled);
    assert!(view.next_run_ms.is_some_and(|at| at > super::now_ms()));

    backup.set_state(SearchBackupState::Working);
    backup.activity(SearchBackupActivity::Uploading, None);
    backup.fail();
    backup.set_state(SearchBackupState::Idle);
    let view = backup.view(0);
    assert_eq!(view.state, SearchBackupState::Failed);
    assert_eq!(view.failures, 1);
    assert!(view.progress.is_none());

    backup.activity(SearchBackupActivity::Uploading, None);
    backup.enabled.store(false, Ordering::Relaxed);
    let view = backup.view(0);
    assert_eq!(view.state, SearchBackupState::Off);
    assert!(view.progress.is_none());
    assert!(view.next_run_ms.is_none());
}
