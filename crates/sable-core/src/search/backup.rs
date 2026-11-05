use std::collections::{HashMap, HashSet};
use std::io::Cursor;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::time::Duration;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD_NO_PAD;
use matrix_sdk::executor::{JoinHandleExt, spawn};
use matrix_sdk::media::{MediaFormat, MediaRequestParameters};
use matrix_sdk::ruma::api::client::config::get_room_account_data;
use matrix_sdk::ruma::api::error::ErrorKind;
use matrix_sdk::ruma::events::room::{EncryptedFile, MediaSource};
use matrix_sdk::ruma::{
    DeviceId, OwnedDeviceId, OwnedEventId, OwnedRoomId, OwnedServerName, RoomId,
};
use matrix_sdk::{Client, Room};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tracing::{info, warn};

use super::document::Document;
use super::now_ms;
use super::persist::{self, Cover};
use crate::Core;
use crate::protocol::{
    SearchBackupActivity, SearchBackupProgress, SearchBackupState, SearchBackupView,
};
use crate::sealed_account_data::{AccountDataKey, cached_key};

const BACKUP_EVENT: &str = "moe.sable.search_backup";
const BACKUP_VERSION: u32 = 1;
const BACKUP_START_DELAY: Duration = Duration::from_mins(2);
const BACKUP_INTERVAL: Duration = Duration::from_mins(10);
const DAY_MS: u64 = 24 * 60 * 60 * 1000;
const SETTLE_MS: u64 = DAY_MS;
const REPUBLISH_MS: u64 = DAY_MS;
const RECENT_MS: u64 = 30 * DAY_MS;
const TAIL_MAX_AGE_MS: u64 = 7 * DAY_MS;
const RECENT_SEGMENT_JSON: usize = 128 * 1024;
const OLD_SEGMENT_JSON: usize = 1024 * 1024;
const MAX_SEGMENTS: usize = 256;
const AGED_RUN: usize = 4;
const CLASSIFIED_JSON: usize = 24;

#[derive(Serialize, Deserialize)]
struct BackupManifest {
    version: u32,
    room_id: OwnedRoomId,
    device_id: OwnedDeviceId,
    schema: u32,
    derivation: u32,
    from: u64,
    covered: u64,
    resume: Option<String>,
    published_ms: u64,
    segments: Vec<Segment>,
}

impl BackupManifest {
    const fn compatible(&self) -> bool {
        self.schema == persist::SCHEMA && self.derivation == persist::DERIVATION
    }

    fn contiguous(&self) -> bool {
        let mut cursor = self.from;
        for segment in &self.segments {
            if segment.start != cursor || segment.end <= segment.start {
                return false;
            }
            cursor = segment.end;
        }
        !self.segments.is_empty() && cursor == self.covered
    }

    fn bytes(&self) -> u64 {
        self.segments.iter().map(|segment| segment.bytes).sum()
    }
}

#[derive(Clone, Serialize, Deserialize)]
struct Segment {
    start: u64,
    end: u64,
    bytes: u64,
    sha256: String,
    file: EncryptedFile,
}

#[derive(Serialize, Deserialize)]
struct SegmentPayload {
    documents: Vec<Document>,
    classified: Vec<(OwnedEventId, u64)>,
    edits: Vec<(OwnedEventId, OwnedEventId)>,
}

impl SegmentPayload {
    fn json(&self) -> Option<Vec<u8>> {
        serde_json::to_vec(self).ok()
    }
}

fn sha256(json: &[u8]) -> String {
    STANDARD_NO_PAD.encode(Sha256::digest(json))
}

struct History {
    documents: Vec<Document>,
    classified: Vec<(OwnedEventId, u64)>,
    edits: HashMap<OwnedEventId, OwnedEventId>,
    weights: Vec<(u64, usize)>,
}

impl History {
    fn new(
        mut documents: Vec<Document>,
        mut classified: Vec<(OwnedEventId, u64)>,
        edits: HashMap<OwnedEventId, OwnedEventId>,
    ) -> Self {
        documents.sort_by(|left, right| {
            (left.origin_server_ts, &left.event_id).cmp(&(right.origin_server_ts, &right.event_id))
        });
        classified.sort_by(|left, right| (left.1, &left.0).cmp(&(right.1, &right.0)));
        classified.dedup();
        let mut weights: Vec<(u64, usize)> = documents
            .iter()
            .map(|document| {
                (
                    document.origin_server_ts,
                    serde_json::to_vec(document).map_or(0, |json| json.len()),
                )
            })
            .chain(
                classified
                    .iter()
                    .map(|(event_id, ts)| (*ts, event_id.as_str().len() + CLASSIFIED_JSON)),
            )
            .collect();
        weights.sort_unstable();
        Self {
            documents,
            classified,
            edits,
            weights,
        }
    }

    fn weight(&self, start: u64, end: u64) -> usize {
        self.weights
            .iter()
            .filter(|(ts, _)| (start..end).contains(ts))
            .map(|(_, weight)| weight)
            .sum()
    }

    fn slice(&self, start: u64, end: u64) -> SegmentPayload {
        let documents: Vec<Document> = self
            .documents
            .iter()
            .filter(|document| (start..end).contains(&document.origin_server_ts))
            .cloned()
            .collect();
        let ids: HashSet<&OwnedEventId> = documents
            .iter()
            .map(|document| &document.event_id)
            .collect();
        let mut edits: Vec<(OwnedEventId, OwnedEventId)> = self
            .edits
            .iter()
            .filter(|(_, target)| ids.contains(target))
            .map(|(edit, target)| (edit.clone(), target.clone()))
            .collect();
        edits.sort();
        SegmentPayload {
            classified: self
                .classified
                .iter()
                .filter(|(_, ts)| (start..end).contains(ts))
                .cloned()
                .collect(),
            documents,
            edits,
        }
    }

    fn hash(&self, start: u64, end: u64) -> Option<String> {
        self.slice(start, end).json().map(|json| sha256(&json))
    }

    fn pack(&self, start: u64, end: u64, target: impl Fn(u64) -> usize) -> Vec<(u64, u64)> {
        let mut cuts = vec![start];
        let mut held = 0;
        let in_range: Vec<&(u64, usize)> = self
            .weights
            .iter()
            .filter(|(ts, _)| (start..end).contains(ts))
            .collect();
        for pair in in_range.windows(2) {
            let [current, following] = pair else {
                continue;
            };
            let (ts, weight) = **current;
            let next = following.0;
            held += weight;
            if held >= target(*cuts.last().unwrap_or(&start)) && next > ts {
                cuts.push(next);
                held = 0;
            }
        }
        let ends = cuts.iter().skip(1).copied().chain(std::iter::once(end));
        cuts.iter().copied().zip(ends).collect()
    }
}

enum Planned {
    Keep(Segment),
    Upload { start: u64, end: u64 },
}

struct Plan {
    segments: Vec<Planned>,
    replaced: Vec<Segment>,
}

impl Plan {
    fn changes(&self, previous_covered: u64) -> bool {
        !self.replaced.is_empty()
            || self.covered() != previous_covered
            || self
                .segments
                .iter()
                .any(|planned| matches!(planned, Planned::Upload { .. }))
    }

    fn covered(&self) -> u64 {
        self.segments.last().map_or(0, |planned| span(planned).1)
    }
}

const fn span(planned: &Planned) -> (u64, u64) {
    match planned {
        Planned::Keep(segment) => (segment.start, segment.end),
        Planned::Upload { start, end } => (*start, *end),
    }
}

fn segment_target(start: u64, now: u64, ceiling: usize) -> usize {
    let tier = if start.saturating_add(RECENT_MS) < now {
        OLD_SEGMENT_JSON
    } else {
        RECENT_SEGMENT_JSON
    };
    tier.min(ceiling).max(1)
}

fn plan(
    history: &History,
    mut previous: Vec<Segment>,
    from: u64,
    now: u64,
    ceiling: usize,
    merge_aged: bool,
) -> Plan {
    let cutoff = now.saturating_sub(SETTLE_MS);
    let target = |start: u64| segment_target(start, now, ceiling);
    previous.sort_by_key(|segment| segment.start);

    let mut segments = Vec::new();
    let mut replaced = Vec::new();
    let mut cursor = from;
    let mut previous = previous.into_iter().peekable();
    match previous.peek().map(|segment| segment.start) {
        Some(start) if start > from => {
            for (start, end) in history.pack(from, start, target) {
                segments.push(Planned::Upload { start, end });
            }
            cursor = start;
        }
        Some(start) if start < from => replaced.extend(previous.by_ref()),
        _ => {}
    }
    for segment in previous.by_ref() {
        if segment.start != cursor || segment.end <= segment.start || segment.end > cutoff {
            replaced.push(segment);
            break;
        }
        cursor = segment.end;
        if history.hash(segment.start, segment.end).as_ref() == Some(&segment.sha256) {
            segments.push(Planned::Keep(segment));
        } else {
            for (start, end) in history.pack(segment.start, segment.end, target) {
                segments.push(Planned::Upload { start, end });
            }
            replaced.push(segment);
        }
    }
    replaced.extend(previous);

    if cutoff > cursor {
        let weight = history.weight(cursor, cutoff);
        if weight == 0 {
            if let Some(Planned::Keep(last)) = segments.last_mut() {
                last.end = cutoff;
            }
        } else if segments.is_empty()
            || weight >= target(cursor)
            || cutoff - cursor >= TAIL_MAX_AGE_MS
        {
            for (start, end) in history.pack(cursor, cutoff, target) {
                segments.push(Planned::Upload { start, end });
            }
        }
    }

    let limit = OLD_SEGMENT_JSON.min(ceiling);
    let old = |&(_, end): &(u64, u64)| end.saturating_add(RECENT_MS) < now;
    while merge_aged && let Some(run) = mergeable_run(history, &segments, limit, AGED_RUN, old) {
        merge(&mut segments, &mut replaced, run);
    }
    while segments.len() > MAX_SEGMENTS {
        let Some(run) = mergeable_run(history, &segments, limit, 2, |_| true) else {
            break;
        };
        merge(&mut segments, &mut replaced, run);
    }
    Plan { segments, replaced }
}

fn mergeable_run(
    history: &History,
    segments: &[Planned],
    limit: usize,
    length: usize,
    eligible: impl Fn(&(u64, u64)) -> bool,
) -> Option<(usize, usize)> {
    let spans: Vec<(u64, u64)> = segments.iter().map(span).collect();
    spans.iter().enumerate().find_map(|(first, span)| {
        if !eligible(span) {
            return None;
        }
        let count = spans
            .iter()
            .skip(first)
            .take_while(|next| eligible(next) && history.weight(span.0, next.1) <= limit)
            .count();
        (count >= length).then(|| (first, first + count - 1))
    })
}

fn merge(segments: &mut Vec<Planned>, replaced: &mut Vec<Segment>, (first, last): (usize, usize)) {
    let (Some((start, _)), Some((_, end))) =
        (segments.get(first).map(span), segments.get(last).map(span))
    else {
        return;
    };
    for planned in segments.drain(first..=last) {
        if let Planned::Keep(segment) = planned {
            replaced.push(segment);
        }
    }
    segments.insert(first, Planned::Upload { start, end });
}

fn open_manifest(
    key: &AccountDataKey,
    room_id: &RoomId,
    content: &serde_json::Value,
) -> Option<BackupManifest> {
    let manifest: BackupManifest = serde_json::from_value(key.open(BACKUP_EVENT, content)?).ok()?;
    (manifest.version == BACKUP_VERSION && manifest.room_id == room_id && manifest.contiguous())
        .then_some(manifest)
}

async fn synced_manifest(room: &Room, key: &AccountDataKey) -> Option<BackupManifest> {
    let raw = room.account_data(BACKUP_EVENT.into()).await.ok()??;
    let content: serde_json::Value = raw.get_field("content").ok()??;
    open_manifest(key, room.room_id(), &content)
}

async fn fetch_manifest(
    client: &Client,
    room_id: &OwnedRoomId,
    key: &AccountDataKey,
) -> matrix_sdk::Result<Option<BackupManifest>> {
    let user_id = client
        .user_id()
        .ok_or(matrix_sdk::Error::AuthenticationRequired)?;
    let request = get_room_account_data::v3::Request::new(
        user_id.to_owned(),
        room_id.clone(),
        BACKUP_EVENT.into(),
    );
    match client.send(request).await {
        Ok(response) => Ok(response
            .account_data
            .deserialize_as::<serde_json::Value>()
            .ok()
            .and_then(|content| open_manifest(key, room_id, &content))),
        Err(error)
            if error
                .client_api_error_kind()
                .is_some_and(|kind| matches!(kind, ErrorKind::NotFound)) =>
        {
            Ok(None)
        }
        Err(error) => Err(error.into()),
    }
}

async fn put_manifest(room: &Room, content: &serde_json::Value) -> matrix_sdk::Result<()> {
    let raw = matrix_sdk::ruma::serde::Raw::new(content)?.cast_unchecked();
    room.set_account_data_raw(BACKUP_EVENT.into(), raw)
        .await
        .map(drop)
}

async fn write_manifest(room: &Room, key: &AccountDataKey, manifest: &BackupManifest) -> bool {
    let Some(sealed) = serde_json::to_value(manifest)
        .ok()
        .and_then(|content| key.seal(BACKUP_EVENT, &content).ok())
    else {
        return false;
    };
    match put_manifest(room, &sealed).await {
        Ok(()) => true,
        Err(error) => {
            warn!(room_id = %room.room_id(), "writing the search backup manifest failed: {error}");
            false
        }
    }
}

async fn settled_history(client: &Client, room_id: &OwnedRoomId) -> Option<History> {
    let manifest = persist::read_manifest(client, room_id).await?;
    let mut documents = Vec::new();
    let mut classified = Vec::new();
    for entry in &manifest.chunks {
        let persist::ChunkRead::Found(stored) =
            persist::load_chunk(client, room_id, entry.id).await
        else {
            return None;
        };
        documents.extend(stored.documents);
        classified.extend(stored.classified);
    }
    Some(History::new(
        documents,
        classified,
        manifest.edits.into_iter().collect(),
    ))
}

async fn device_exists(client: &Client, device_id: &DeviceId) -> bool {
    let Some(user_id) = client.user_id() else {
        return true;
    };
    client
        .encryption()
        .get_user_devices(user_id)
        .await
        .ok()
        .is_none_or(|devices| {
            devices
                .get(device_id)
                .is_some_and(|device| !device.is_deleted())
        })
}

fn upload_failed(error: &matrix_sdk::Error) -> Published {
    let Some(api) = error.as_client_api_error() else {
        return Published::Skipped;
    };
    match api.error_kind() {
        Some(ErrorKind::TooLarge | ErrorKind::ResourceLimitExceeded(_)) => {
            Published::Halt(SearchBackupState::Refused)
        }
        Some(ErrorKind::LimitExceeded(_)) => Published::StopPass,
        _ if api.status_code.as_u16() == 413 => Published::Halt(SearchBackupState::Refused),
        _ if api.status_code.as_u16() == 429 => Published::StopPass,
        _ => Published::Skipped,
    }
}

mod redact_media {
    use matrix_sdk::ruma::OwnedServerName;
    use ruma::api::{auth_scheme::AccessToken, request, response};
    use ruma::metadata;

    metadata! {
        method: POST,
        rate_limited: true,
        authentication: AccessToken,
        history: {
            unstable("uk.timedout.msc4322") => "/_matrix/client/unstable/uk.timedout.msc4322/media/redact/{server_name}/{media_id}",
        }
    }

    #[request]
    pub(super) struct Request {
        #[ruma_api(path)]
        pub server_name: OwnedServerName,
        #[ruma_api(path)]
        pub media_id: String,
    }

    #[response]
    pub(super) struct Response {}
}

#[derive(Default)]
pub(crate) struct SearchBackup {
    pub(crate) enabled: AtomicBool,
    pub(crate) limit_mb: AtomicU32,
    status: std::sync::Mutex<SearchBackupView>,
}

impl SearchBackup {
    fn limit_bytes(&self) -> u64 {
        u64::from(self.limit_mb.load(Ordering::Relaxed)) * 1024 * 1024
    }

    fn set_state(&self, state: SearchBackupState) {
        if let Ok(mut status) = self.status.lock() {
            status.state = if state == SearchBackupState::Idle && status.failures > 0 {
                SearchBackupState::Failed
            } else {
                state
            };
            if state != SearchBackupState::Working {
                status.progress = None;
            }
        }
    }

    fn schedule(&self, delay: Duration) {
        if let Ok(mut status) = self.status.lock() {
            status.next_run_ms =
                Some(now_ms().saturating_add(u64::try_from(delay.as_millis()).unwrap_or(u64::MAX)));
        }
    }

    fn activity(&self, activity: SearchBackupActivity, room: Option<&Room>) {
        if let Ok(mut status) = self.status.lock() {
            status.progress = Some(SearchBackupProgress {
                activity,
                room: room.map(|room| {
                    room.cached_display_name()
                        .map_or_else(|| room.room_id().to_string(), |name| name.to_string())
                }),
                parts_done: 0,
                parts_total: 0,
                transferred_bytes: 0,
                total_bytes: None,
            });
        }
    }

    fn transfer(&self, parts_total: usize, total_bytes: Option<u64>) {
        if let Ok(mut status) = self.status.lock()
            && let Some(progress) = &mut status.progress
        {
            progress.parts_total = parts_total;
            progress.total_bytes = total_bytes;
        }
    }

    fn transferred(&self, bytes: u64) {
        if let Ok(mut status) = self.status.lock()
            && let Some(progress) = &mut status.progress
        {
            progress.parts_done += 1;
            progress.transferred_bytes = progress.transferred_bytes.saturating_add(bytes);
        }
    }

    fn fail(&self) {
        if let Ok(mut status) = self.status.lock() {
            status.failures += 1;
        }
    }

    pub(crate) fn view(&self, rooms_imported: usize) -> SearchBackupView {
        let mut view = self
            .status
            .lock()
            .map(|status| status.clone())
            .unwrap_or_default();
        if !self.enabled.load(Ordering::Relaxed) {
            view.state = SearchBackupState::Off;
            view.progress = None;
            view.next_run_ms = None;
        } else if view.state == SearchBackupState::Off {
            view.state = SearchBackupState::Scheduled;
        }
        view.limit_bytes = self.limit_bytes();
        view.rooms_imported = rooms_imported;
        view
    }
}

#[derive(Default)]
struct BackupSession {
    refused: bool,
    media_redaction: Option<bool>,
    retracted: HashSet<OwnedRoomId>,
    evaluated: HashMap<OwnedRoomId, (u64, u64)>,
}

impl BackupSession {
    async fn redact(&mut self, client: &Client, segments: &[Segment]) {
        for segment in segments {
            if self.media_redaction == Some(false) {
                return;
            }
            let (Ok(server_name), Ok(media_id)) =
                (segment.file.url.server_name(), segment.file.url.media_id())
            else {
                continue;
            };
            let request = redact_media::Request {
                server_name: OwnedServerName::from(server_name),
                media_id: media_id.to_owned(),
            };
            match client.send(request).await {
                Ok(_) => self.media_redaction = Some(true),
                Err(error) => {
                    let unsupported = error.as_client_api_error().is_some_and(|api| {
                        matches!(api.status_code.as_u16(), 400 | 404 | 405)
                            || matches!(api.error_kind(), Some(ErrorKind::Unrecognized))
                    });
                    if unsupported {
                        self.media_redaction = Some(false);
                    } else {
                        warn!("redacting a replaced search backup segment failed: {error}");
                    }
                }
            }
        }
    }

    fn evaluated_recently(&self, room_id: &RoomId, revision: u64, now: u64) -> bool {
        self.evaluated
            .get(room_id)
            .is_some_and(|&(seen, at)| seen == revision && now.saturating_sub(at) < REPUBLISH_MS)
    }
}

struct Previous {
    segments: Vec<Segment>,
    stale: Vec<Segment>,
    covered: u64,
}

async fn previous_backup(
    client: &Client,
    previous: Option<BackupManifest>,
    own: &OwnedDeviceId,
    now: u64,
) -> Option<Previous> {
    let Some(manifest) = previous else {
        return Some(Previous {
            segments: Vec::new(),
            stale: Vec::new(),
            covered: 0,
        });
    };
    if manifest.device_id == *own {
        if now.saturating_sub(manifest.published_ms) < REPUBLISH_MS {
            return None;
        }
    } else if device_exists(client, &manifest.device_id).await {
        return None;
    }
    Some(if manifest.compatible() {
        Previous {
            covered: manifest.covered,
            segments: manifest.segments,
            stale: Vec::new(),
        }
    } else {
        Previous {
            segments: Vec::new(),
            stale: manifest.segments,
            covered: 0,
        }
    })
}

fn imported_cover(local: Option<&Cover>, manifest: &BackupManifest, crawled: bool) -> Cover {
    local.map_or_else(
        || Cover {
            from: manifest.from,
            until: manifest.covered,
            resume: manifest.resume.clone(),
            stops: manifest.from == 0 || !crawled,
        },
        |local| Cover {
            from: local.from.min(manifest.from),
            until: local.until.max(manifest.covered),
            resume: if local.stops && manifest.from < local.from {
                manifest.resume.clone()
            } else {
                local.resume.clone()
            },
            stops: local.stops,
        },
    )
}

enum Published {
    Done,
    Skipped,
    Halt(SearchBackupState),
    StopPass,
}

impl Core {
    pub(crate) fn watch_search_backup(self: &Arc<Self>, client: &Client) {
        let core = self.clone();
        let client = client.clone();

        self.search_backup.schedule(BACKUP_START_DELAY);
        self.track_session_task(
            spawn(async move {
                let mut session = BackupSession::default();
                matrix_sdk::sleep::sleep(BACKUP_START_DELAY).await;
                loop {
                    core.backup_pass(&client, &mut session, now_ms()).await;
                    core.search_backup.schedule(BACKUP_INTERVAL);
                    matrix_sdk::sleep::sleep(BACKUP_INTERVAL).await;
                }
            })
            .abort_on_drop(),
        );
    }

    async fn backup_pass(&self, client: &Client, session: &mut BackupSession, now: u64) {
        let backup = &self.search_backup;
        if !backup.enabled.load(Ordering::Relaxed) {
            return;
        }
        if !self.search_network.allows_backup() {
            backup.set_state(SearchBackupState::WaitingForWifi);
            return;
        }
        let Some(key) = cached_key(client).await else {
            backup.set_state(SearchBackupState::Locked);
            return;
        };
        backup.set_state(SearchBackupState::Working);
        if let Ok(mut status) = backup.status.lock() {
            status.failures = 0;
            status.next_run_ms = None;
        }
        backup.activity(SearchBackupActivity::Checking, None);
        if !self.import_backups(client, &key).await {
            backup.set_state(SearchBackupState::WaitingForWifi);
            return;
        }
        let state = if session.refused {
            SearchBackupState::Refused
        } else {
            self.publish_backups(client, &key, session, now).await
        };
        backup.set_state(state);
    }

    async fn import_backups(&self, client: &Client, key: &AccountDataKey) -> bool {
        let own = client.device_id().map(ToOwned::to_owned);
        for room in client.joined_rooms() {
            if !room.encryption_state().is_encrypted() {
                continue;
            }
            let room_id = room.room_id().to_owned();
            let (local, crawled) = {
                let progress = self.search_crawl.lock().await;
                if progress.exhausted(&room_id) {
                    continue;
                }
                (
                    progress.cover_of(&room_id).cloned(),
                    progress.has_token(&room_id),
                )
            };
            self.search_backup
                .activity(SearchBackupActivity::Checking, Some(&room));
            let Some(manifest) = synced_manifest(&room, key).await else {
                continue;
            };
            let stale = local.as_ref().is_some_and(|local| {
                manifest.covered <= local.until && manifest.from >= local.from
            });
            if Some(&manifest.device_id) == own.as_ref() || !manifest.compatible() || stale {
                continue;
            }
            if self.search_index.lock().await.is_full() {
                break;
            }
            self.search_backup
                .activity(SearchBackupActivity::Downloading, Some(&room));
            if !self
                .import_room(client, &room_id, &manifest, local.as_ref(), crawled)
                .await
            {
                return false;
            }
        }
        true
    }

    async fn import_room(
        &self,
        client: &Client,
        room_id: &OwnedRoomId,
        manifest: &BackupManifest,
        local: Option<&Cover>,
        crawled: bool,
    ) -> bool {
        let pending: Vec<_> = manifest
            .segments
            .iter()
            .filter(|segment| {
                !local
                    .is_some_and(|local| segment.start >= local.from && segment.end <= local.until)
            })
            .collect();
        self.search_backup.transfer(
            pending.len(),
            Some(pending.iter().map(|segment| segment.bytes).sum()),
        );
        for segment in pending {
            if let Ok(mut status) = self.search_backup.status.lock()
                && let Some(progress) = &mut status.progress
            {
                progress.activity = SearchBackupActivity::Downloading;
            }
            let request = MediaRequestParameters {
                source: MediaSource::Encrypted(Box::new(segment.file.clone())),
                format: MediaFormat::File,
            };
            let Some(downloaded) = self
                .search_network
                .run_unmetered(client.media().get_media_content(&request, false))
                .await
            else {
                return false;
            };
            let bytes = match downloaded {
                Ok(bytes) => bytes,
                Err(error) => {
                    self.search_backup.fail();
                    warn!(%room_id, "downloading a search backup segment failed: {error}");
                    return true;
                }
            };
            self.search_backup.transferred(bytes.len() as u64);
            if let Ok(mut status) = self.search_backup.status.lock()
                && let Some(progress) = &mut status.progress
            {
                progress.activity = SearchBackupActivity::Importing;
            }
            let Some(payload) = persist::decode(bytes)
                .ok()
                .and_then(|json| serde_json::from_slice::<SegmentPayload>(&json).ok())
            else {
                self.search_backup.fail();
                warn!(%room_id, "a search backup segment did not decode");
                return true;
            };
            self.search_index
                .lock()
                .await
                .import(
                    room_id,
                    payload.documents,
                    payload.classified,
                    payload.edits,
                )
                .await;
        }
        let cover = imported_cover(local, manifest, crawled);
        let revision = self.search_index.lock().await.revision(room_id);
        self.search_crawl
            .lock()
            .await
            .cover(room_id, cover, revision);
        info!(%room_id, from = manifest.from, covered = manifest.covered, "imported the search backup");
        true
    }

    async fn publish_backups(
        &self,
        client: &Client,
        key: &AccountDataKey,
        session: &mut BackupSession,
        now: u64,
    ) -> SearchBackupState {
        let Some(own) = client.device_id().map(ToOwned::to_owned) else {
            return SearchBackupState::Idle;
        };
        let ceiling = client
            .load_or_fetch_max_upload_size()
            .await
            .ok()
            .and_then(|size| usize::try_from(u64::from(size) / 2).ok())
            .unwrap_or(OLD_SEGMENT_JSON);

        self.search_backup
            .activity(SearchBackupActivity::Cleaning, None);
        self.retract_left_rooms(client, key, &own, session).await;
        self.search_backup
            .activity(SearchBackupActivity::Checking, None);

        let mut owned = HashMap::new();
        for room in client.joined_rooms() {
            if let Some(manifest) = synced_manifest(&room, key).await
                && manifest.device_id == own
            {
                owned.insert(room.room_id().to_owned(), manifest);
            }
        }
        let mut used: u64 = owned.values().map(BackupManifest::bytes).sum();
        let mut published: HashSet<OwnedRoomId> = owned.keys().cloned().collect();
        let mut state = SearchBackupState::Idle;
        if let Ok(mut status) = self.search_backup.status.lock() {
            status.published_bytes = used;
            status.rooms_published = published.len();
        }

        for room in client.joined_rooms() {
            let room_id = room.room_id().to_owned();
            let synced = owned.get(&room_id);
            if !room.encryption_state().is_encrypted()
                || synced.is_some_and(|manifest| {
                    now.saturating_sub(manifest.published_ms) < REPUBLISH_MS
                })
            {
                continue;
            }
            let (from, resume) = {
                let progress = self.search_crawl.lock().await;
                if progress.exhausted(&room_id) {
                    (Some(0), None)
                } else {
                    (None, progress.saved_token(&room_id))
                }
            };
            if from.is_none() && resume.is_none() {
                continue;
            }
            match self
                .publish_room(
                    client,
                    &room,
                    key,
                    &own,
                    (from, resume),
                    ceiling,
                    &mut used,
                    session,
                    now,
                )
                .await
            {
                Published::Done => {
                    published.insert(room_id);
                    if let Ok(mut status) = self.search_backup.status.lock() {
                        status.published_bytes = used;
                        status.rooms_published = published.len();
                    }
                }
                Published::Skipped => {}
                Published::StopPass => {
                    state = if self.search_network.allows_backup() {
                        SearchBackupState::Failed
                    } else {
                        SearchBackupState::WaitingForWifi
                    };
                    break;
                }
                Published::Halt(halt) => {
                    session.refused = halt == SearchBackupState::Refused;
                    state = halt;
                    break;
                }
            }
        }

        state
    }

    #[expect(
        clippy::too_many_arguments,
        reason = "one publish pass threads its state through"
    )]
    async fn publish_room(
        &self,
        client: &Client,
        room: &Room,
        key: &AccountDataKey,
        own: &OwnedDeviceId,
        (from, resume): (Option<u64>, Option<String>),
        ceiling: usize,
        used: &mut u64,
        session: &mut BackupSession,
        now: u64,
    ) -> Published {
        let room_id = room.room_id().to_owned();
        let revision = {
            let index = self.search_index.lock().await;
            if !index.settled(&room_id) {
                return Published::Skipped;
            }
            index.revision(&room_id)
        };
        if session.evaluated_recently(&room_id, revision, now) {
            return Published::Skipped;
        }

        self.search_backup
            .activity(SearchBackupActivity::Preparing, Some(room));
        let Some(history) = settled_history(client, &room_id).await else {
            return Published::Skipped;
        };
        if self.search_index.lock().await.revision(&room_id) != revision {
            return Published::Skipped;
        }
        let Some(from) = from.or_else(|| history.weights.first().map(|&(ts, _)| ts)) else {
            return Published::Skipped;
        };
        session.evaluated.insert(room_id.clone(), (revision, now));

        let previous = match fetch_manifest(client, &room_id, key).await {
            Ok(previous) => previous,
            Err(error) => {
                self.search_backup.fail();
                warn!(%room_id, "reading the search backup manifest failed: {error}");
                return Published::Skipped;
            }
        };
        let Some(Previous {
            segments: previous_segments,
            mut stale,
            covered: previous_covered,
        }) = previous_backup(client, previous, own, now).await
        else {
            return Published::Skipped;
        };

        let plan = plan(
            &history,
            previous_segments,
            from,
            now,
            ceiling,
            session.media_redaction == Some(true),
        );
        if !plan.changes(previous_covered) && stale.is_empty() {
            return Published::Skipped;
        }
        let covered = plan.covered();
        stale.extend(plan.replaced);
        let freed: u64 = stale.iter().map(|segment| segment.bytes).sum();

        let (segments, added) = match self
            .upload_plan(client, room, &history, plan.segments, *used, freed)
            .await
        {
            Ok(uploaded) => uploaded,
            Err(outcome) => return outcome,
        };

        let manifest = BackupManifest {
            version: BACKUP_VERSION,
            room_id: room_id.clone(),
            device_id: own.clone(),
            schema: persist::SCHEMA,
            derivation: persist::DERIVATION,
            from,
            covered,
            resume: (from > 0).then_some(resume).flatten(),
            published_ms: now,
            segments,
        };
        self.search_backup
            .activity(SearchBackupActivity::Publishing, Some(room));
        if !write_manifest(room, key, &manifest).await {
            self.search_backup.fail();
            return Published::Skipped;
        }
        *used = used.saturating_add(added).saturating_sub(freed);
        self.search_backup
            .activity(SearchBackupActivity::Cleaning, Some(room));
        session.redact(client, &stale).await;
        info!(%room_id, from, covered, "published the search backup");
        Published::Done
    }

    async fn upload_plan(
        &self,
        client: &Client,
        room: &Room,
        history: &History,
        planned: Vec<Planned>,
        used: u64,
        freed: u64,
    ) -> Result<(Vec<Segment>, u64), Published> {
        self.search_backup
            .activity(SearchBackupActivity::Uploading, Some(room));
        self.search_backup.transfer(
            planned
                .iter()
                .filter(|segment| matches!(segment, Planned::Upload { .. }))
                .count(),
            None,
        );
        let room_id = room.room_id().to_owned();
        let mut segments = Vec::with_capacity(planned.len());
        let mut added = 0;
        for planned in planned {
            let segment = match planned {
                Planned::Keep(segment) => segment,
                Planned::Upload { start, end } => {
                    let budget = self
                        .search_backup
                        .limit_bytes()
                        .saturating_add(freed)
                        .saturating_sub(used.saturating_add(added));
                    let segment = self
                        .upload_segment(client, &room_id, history, (start, end), budget)
                        .await?;
                    added += segment.bytes;
                    segment
                }
            };
            segments.push(segment);
        }
        Ok((segments, added))
    }

    async fn upload_segment(
        &self,
        client: &Client,
        room_id: &OwnedRoomId,
        history: &History,
        (start, end): (u64, u64),
        budget: u64,
    ) -> Result<Segment, Published> {
        let json = history.slice(start, end).json().ok_or(Published::Skipped)?;
        let compressed = persist::encode(&json);
        let bytes = compressed.len() as u64;
        if bytes > budget {
            return Err(Published::Halt(SearchBackupState::LimitReached));
        }
        let mut reader = Cursor::new(compressed);
        let uploaded = self
            .search_network
            .run_unmetered(client.upload_encrypted_file(&mut reader).into_future())
            .await
            .ok_or(Published::StopPass)?;
        let file = uploaded.map_err(|error| {
            self.search_backup.fail();
            warn!(%room_id, "uploading a search backup segment failed: {error}");
            upload_failed(&error)
        })?;
        self.search_backup.transferred(bytes);
        Ok(Segment {
            start,
            end,
            bytes,
            sha256: sha256(&json),
            file,
        })
    }

    async fn retract_left_rooms(
        &self,
        client: &Client,
        key: &AccountDataKey,
        own: &OwnedDeviceId,
        session: &mut BackupSession,
    ) {
        for room in client.left_rooms() {
            let room_id = room.room_id().to_owned();
            if session.retracted.contains(&room_id) {
                continue;
            }
            let Some(manifest) = synced_manifest(&room, key).await else {
                continue;
            };
            if manifest.device_id != *own {
                continue;
            }
            session.retracted.insert(room_id);
            if let Err(error) = put_manifest(&room, &serde_json::json!({})).await {
                warn!(room_id = %room.room_id(), "clearing a left room's search backup failed: {error}");
            }
            session.redact(client, &manifest.segments).await;
        }
    }
}

#[cfg(test)]
mod live;
#[cfg(test)]
mod tests;
