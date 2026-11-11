use crate::api::timeline::TimelineFocusView;
use std::collections::BTreeSet;
use std::future::Future;
use std::sync::Arc;

use matrix_sdk::Room;
use matrix_sdk::executor::spawn;
use matrix_sdk::ruma::{
    EventId, OwnedEventId, OwnedRoomId, UserId,
    events::room::message::Relation,
    events::{
        AnyMessageLikeEventContent, AnySyncMessageLikeEvent, AnySyncTimelineEvent,
        MessageLikeEventType, poll::unstable_start::UnstablePollStartEventContent,
    },
    room_version_rules::RoomVersionRules,
    serde::Raw,
};
use matrix_sdk_ui::timeline::{
    EncryptedMessage, RoomExt, Timeline, TimelineEventFocusThreadMode, TimelineFocus,
    default_event_filter,
};

use matrix_sdk_base::event_cache::Event;
use matrix_sdk_common::serde_helpers::{extract_relation, extract_thread_root};

use crate::ResultExt;
use crate::protocol::{RpcCode, RpcError, SubscriptionId, TimelineItemView};
use crate::view::{CUTE_EVENT_MSGTYPE, aggregation_item};

use crate::{CachedTimeline, Core, SubscriptionKind, ThreadKey};

const MAX_CACHED_INACTIVE_TIMELINES: usize = 4;
pub(crate) const MAX_CACHED_THREAD_TIMELINES: usize = 4;
const MAX_RELATION_DEPTH: usize = 4;

/// The events an aggregation row may be built from, so a reaction on a thread
/// reply neither reaches the main timeline nor another thread.
pub(crate) enum AggregationScope {
    Room,
    Main,
    Thread(OwnedEventId),
}

impl AggregationScope {
    pub(crate) fn of(focus: &TimelineFocusView) -> Self {
        match focus {
            TimelineFocusView::Live => Self::Main,
            TimelineFocusView::Event { .. } => Self::Room,
            TimelineFocusView::Thread { root_event_id } => Self::Thread(root_event_id.clone()),
        }
    }

    pub(crate) async fn retain<Found: Future<Output = Option<Event>>>(
        &self,
        events: Vec<Event>,
        lookup: impl Fn(OwnedEventId) -> Found,
    ) -> Vec<Event> {
        if matches!(self, Self::Room) {
            return events;
        }
        let mut kept = Vec::with_capacity(events.len());
        for event in events {
            if self.admits(event.raw(), &lookup).await {
                kept.push(event);
            }
        }
        kept
    }

    async fn admits<Found: Future<Output = Option<Event>>>(
        &self,
        event: &Raw<AnySyncTimelineEvent>,
        lookup: &impl Fn(OwnedEventId) -> Found,
    ) -> bool {
        let thread = thread_root_of(event, lookup).await;
        match self {
            Self::Room => true,
            Self::Main => thread.is_none(),
            Self::Thread(root) => belongs_to_thread(event, thread.as_ref(), root),
        }
    }
}

/// The root and what decorates it are in its thread, though only the replies
/// carry the `m.thread` relation.
fn belongs_to_thread(
    event: &Raw<AnySyncTimelineEvent>,
    thread: Option<&OwnedEventId>,
    root: &EventId,
) -> bool {
    thread.is_some_and(|thread| thread == root)
        || event
            .get_field::<OwnedEventId>("event_id")
            .ok()
            .flatten()
            .is_some_and(|id| id == root)
        || extract_relation(event).is_some_and(|(_, target)| target == root)
}

/// The thread a receipt for `event_id` has to name, which is the event's own and
/// not the view's: the server rejects a receipt for an event outside its thread.
pub(crate) async fn receipt_thread_root(
    room: &Room,
    event_id: &EventId,
    viewed: Option<OwnedEventId>,
) -> Option<OwnedEventId> {
    let Ok(event) = room.load_or_fetch_event(event_id, None).await else {
        return viewed;
    };
    let thread = thread_root_of(event.raw(), |id: OwnedEventId| async move {
        room.load_or_fetch_event(&id, None).await.ok()
    })
    .await;
    match viewed {
        Some(viewed) if belongs_to_thread(event.raw(), thread.as_ref(), &viewed) => Some(viewed),
        _ => thread,
    }
}

/// Follows the relations of an aggregation to the event it decorates, since
/// only that one carries the `m.thread` relation. `None` for the main timeline
/// and for a target that cannot be found.
pub(crate) async fn thread_root_of<Found: Future<Output = Option<Event>>>(
    event: &Raw<AnySyncTimelineEvent>,
    lookup: impl Fn(OwnedEventId) -> Found,
) -> Option<OwnedEventId> {
    let mut raw = event.clone();
    for _ in 0..MAX_RELATION_DEPTH {
        if let Some(root) = extract_thread_root(&raw) {
            return Some(root);
        }
        let (_, target) = extract_relation(&raw)?;
        raw = lookup(target).await?.into_raw();
    }
    None
}

impl Core {
    /// Cached: a second subscriber would give the UI two streams for one room.
    pub(crate) async fn timeline(&self, room_id: &OwnedRoomId) -> Result<Arc<Timeline>, RpcError> {
        {
            let session = self.session.read().await;
            session.as_ref().ok_or(RpcCode::NotLoggedIn)?;
            if let Some(cached) = self.timelines.lock().await.get(room_id) {
                return Ok(cached.timeline.clone());
            }
        }
        self.live_timeline(room_id, false).await
    }

    /// The cache holds one live timeline per room, so a `hidden_events` that no
    /// longer matches replaces it rather than sitting alongside it.
    #[cfg_attr(
        target_family = "wasm",
        expect(
            clippy::arc_with_non_send_sync,
            reason = "matrix timelines are single-threaded on WASM"
        )
    )]
    pub(crate) async fn live_timeline(
        &self,
        room_id: &OwnedRoomId,
        hidden_events: bool,
    ) -> Result<Arc<Timeline>, RpcError> {
        tracing::info!(%room_id, "live_timeline: waiting for session");
        let session = self.session.read().await;
        let room = session
            .as_ref()
            .ok_or(RpcCode::NotLoggedIn)?
            .client
            .get_room(room_id)
            .ok_or(RpcCode::UnknownRoom)?;
        {
            let mut timelines = self.timelines.lock().await;
            if let Some(cached) = timelines.get(room_id)
                && cached.hidden_events == hidden_events
            {
                let timeline = cached.timeline.clone();
                timelines.to_back(room_id);
                return Ok(timeline);
            }
        }

        tracing::info!(%room_id, "live_timeline: building");
        let timeline = Arc::new(
            build_room_timeline(&room, &TimelineFocusView::Live, hidden_events)
                .await
                .or_failed(self, "build_timeline")?,
        );
        tracing::info!(%room_id, "live_timeline: built");

        let subscribed_room_ids = self
            .subscriptions
            .lock()
            .await
            .values()
            .filter_map(|subscription| match &subscription.kind {
                SubscriptionKind::LiveTimeline(room_id) => Some(room_id.clone()),
                SubscriptionKind::Other | SubscriptionKind::FocusedTimeline(_) => None,
            })
            .collect::<std::collections::HashSet<_>>();
        let mut timelines = self.timelines.lock().await;
        match timelines.get(room_id) {
            Some(cached) if cached.hidden_events == hidden_events => {
                let timeline = cached.timeline.clone();
                timelines.to_back(room_id);
                Ok(timeline)
            }
            _ => {
                let inactive = timelines
                    .keys()
                    .filter(|id| !subscribed_room_ids.contains(*id))
                    .count();
                if inactive >= MAX_CACHED_INACTIVE_TIMELINES
                    && let Some(evicted) = timelines
                        .iter()
                        .find(|(id, _)| !subscribed_room_ids.contains(*id))
                        .map(|(id, _)| id.clone())
                {
                    timelines.remove(&evicted);
                }
                timelines.insert(
                    room_id.clone(),
                    CachedTimeline {
                        timeline: timeline.clone(),
                        hidden_events,
                    },
                );
                Ok(timeline)
            }
        }
    }
}

impl Core {
    /// The redecryptor misses keys a push client stored while the app was in the background.
    pub(crate) async fn retry_cached_decryption(&self) {
        let mut timelines: Vec<Arc<Timeline>> = self
            .timelines
            .lock()
            .await
            .values()
            .map(|cached| cached.timeline.clone())
            .collect();
        timelines.extend(
            self.thread_timelines
                .lock()
                .await
                .iter()
                .map(|(_, cached)| cached.timeline.clone()),
        );
        for timeline in timelines {
            let sessions: BTreeSet<String> = timeline
                .items()
                .await
                .iter()
                .filter_map(
                    |item| match item.as_event()?.content().as_unable_to_decrypt()? {
                        EncryptedMessage::MegolmV1AesSha2 { session_id, .. } => {
                            Some(session_id.clone())
                        }
                        _ => None,
                    },
                )
                .collect();
            if !sessions.is_empty() {
                timeline.retry_decryption(sessions).await;
            }
        }
        self.refresh_encrypted_replies(None, |_| true).await;
    }

    pub(crate) async fn timeline_for(
        &self,
        room_id: &OwnedRoomId,
        thread_root: Option<&OwnedEventId>,
    ) -> Result<Arc<Timeline>, RpcError> {
        match thread_root {
            Some(root) => self.thread_timeline(room_id, root).await,
            None => self.timeline(room_id).await,
        }
    }

    pub(crate) async fn subscribed_timeline(
        &self,
        room_id: &OwnedRoomId,
        thread_root: Option<&OwnedEventId>,
        subscription: Option<SubscriptionId>,
    ) -> Result<Arc<Timeline>, RpcError> {
        let Some(subscription) = subscription else {
            return self.timeline_for(room_id, thread_root).await;
        };
        let (timeline, subscribed_root) = self
            .subscriptions
            .lock()
            .await
            .get(&subscription)
            .and_then(|subscription| {
                subscription
                    .timeline
                    .clone()
                    .map(|timeline| (timeline, subscription.thread_root.clone()))
            })
            .ok_or(RpcCode::UnknownSubscription)?;
        if timeline.room().room_id() != room_id {
            return Err(RpcCode::UnknownSubscription.into());
        }
        if subscribed_root.as_ref() == thread_root {
            return Ok(timeline);
        }
        if subscribed_root.is_some() || !timeline.is_threaded() {
            return Err(RpcCode::UnknownSubscription.into());
        }
        let root = thread_root.ok_or(RpcCode::UnknownSubscription)?;
        // Event-focused timelines infer their thread from the target event.
        let belongs = timeline
            .items()
            .await
            .iter()
            .filter_map(|item| item.as_event())
            .any(|event| {
                event.event_id() == Some(root.as_ref())
                    || event
                        .content()
                        .as_msglike()
                        .and_then(|message| message.thread_root.as_ref())
                        == Some(root)
            });
        if !belongs {
            return Err(RpcCode::UnknownSubscription.into());
        }
        Ok(timeline)
    }

    #[cfg_attr(
        target_family = "wasm",
        expect(
            clippy::arc_with_non_send_sync,
            reason = "matrix timelines are single-threaded on WASM"
        )
    )]
    pub(crate) async fn thread_timeline(
        &self,
        room_id: &OwnedRoomId,
        root_event_id: &OwnedEventId,
    ) -> Result<Arc<Timeline>, RpcError> {
        let session = self.session.read().await;
        let room = session
            .as_ref()
            .ok_or(RpcCode::NotLoggedIn)?
            .client
            .get_room(room_id)
            .ok_or(RpcCode::UnknownRoom)?;
        let key: ThreadKey = (room_id.clone(), root_event_id.clone());
        {
            let mut threads = self.thread_timelines.lock().await;
            if let Some(cached) = threads.get_mut(&key) {
                return Ok(cached.timeline.clone());
            }
        }

        let focus = TimelineFocusView::Thread {
            root_event_id: root_event_id.clone(),
        };
        let timeline = Arc::new(
            build_room_timeline(&room, &focus, false)
                .await
                .or_failed(self, "build_thread_timeline")?,
        );

        let mut threads = self.thread_timelines.lock().await;
        if let Some(cached) = threads.get_mut(&key) {
            return Ok(cached.timeline.clone());
        }

        threads.insert(
            key,
            CachedTimeline {
                timeline: timeline.clone(),
                hidden_events: false,
            },
        );
        Ok(timeline)
    }
}

pub(crate) fn fill_sender_profiles(room: &matrix_sdk::Room, timeline: &Arc<Timeline>) {
    if room.are_members_synced() {
        return;
    }

    let timeline = timeline.clone();
    drop(spawn(async move {
        timeline.fetch_members().await;
    }));
}

fn is_aggregation(event: &AnySyncTimelineEvent, rules: &RoomVersionRules) -> bool {
    let AnySyncTimelineEvent::MessageLike(message) = event else {
        return false;
    };

    if let AnySyncMessageLikeEvent::RoomRedaction(redaction) = message {
        return redaction.redacts(&rules.redaction).is_some();
    }

    let Some(content) = message.original_content() else {
        return message.event_type() == MessageLikeEventType::Reaction;
    };

    match content {
        // The SDK reads a thread only from the types it parses, so a custom
        // event's thread is known to the raw event alone.
        AnyMessageLikeEventContent::Reaction(_)
        | AnyMessageLikeEventContent::_Custom(_)
        | AnyMessageLikeEventContent::Beacon(_)
        | AnyMessageLikeEventContent::RtcDecline(_)
        | AnyMessageLikeEventContent::UnstablePollResponse(_)
        | AnyMessageLikeEventContent::UnstablePollEnd(_) => true,
        AnyMessageLikeEventContent::UnstablePollStart(poll) => {
            matches!(poll, UnstablePollStartEventContent::Replacement(_))
        }
        AnyMessageLikeEventContent::RoomMessage(message) => {
            matches!(message.relates_to, Some(Relation::Replacement(_)))
        }
        _ => false,
    }
}

pub(crate) fn hidden_event_filter(event: &AnySyncTimelineEvent, rules: &RoomVersionRules) -> bool {
    default_event_filter(event, rules) || !is_aggregation(event, rules)
}

pub(crate) fn aggregation_items(
    events: impl IntoIterator<Item = Event>,
    rules: &RoomVersionRules,
    own_user_id: Option<&UserId>,
) -> Vec<TimelineItemView> {
    events
        .into_iter()
        .filter_map(|event| {
            let parsed = event.raw().deserialize().ok()?;
            if !is_aggregation(&parsed, rules) {
                return None;
            }
            let content = event.raw().get_field::<serde_json::Value>("content").ok()?;
            let redacts = match &parsed {
                AnySyncTimelineEvent::MessageLike(AnySyncMessageLikeEvent::RoomRedaction(
                    redaction,
                )) => redaction.redacts(&rules.redaction).map(ToOwned::to_owned),
                _ => None,
            };
            Some(aggregation_item(&parsed, content, redacts, own_user_id))
        })
        .collect()
}

fn timeline_event_filter(event: &AnySyncTimelineEvent, rules: &RoomVersionRules) -> bool {
    !is_signaling_event(event) && (default_event_filter(event, rules) || is_cute_event(event))
}

fn is_cute_event(event: &AnySyncTimelineEvent) -> bool {
    let AnySyncTimelineEvent::MessageLike(AnySyncMessageLikeEvent::RoomMessage(message)) = event
    else {
        return false;
    };
    message.as_original().is_some_and(|message| {
        message.content.msgtype.msgtype() == CUTE_EVENT_MSGTYPE
            && !matches!(message.content.relates_to, Some(Relation::Replacement(_)))
    })
}

fn is_signaling_event(event: &AnySyncTimelineEvent) -> bool {
    let event_type = event.event_type().to_string();
    matches!(
        event_type.as_str(),
        "m.rtc.member"
            | "org.matrix.msc4143.rtc.member"
            | "io.element.call.encryption_keys"
            | "org.matrix.msc4075.rtc.notification"
            | "org.matrix.msc4310.rtc.decline"
    )
}

pub(crate) async fn build_room_timeline(
    room: &matrix_sdk::Room,
    focus: &TimelineFocusView,
    hidden_events: bool,
) -> Result<Timeline, matrix_sdk_ui::timeline::Error> {
    let builder = room
        .timeline_builder()
        .with_unable_to_decrypt_hook(crate::utd::hook(room))
        .with_focus(match focus {
            TimelineFocusView::Live => TimelineFocus::Live {
                hide_threaded_events: true,
            },
            TimelineFocusView::Event { event_id } => TimelineFocus::Event {
                target: event_id.clone(),
                num_context_events: 50,
                thread_mode: TimelineEventFocusThreadMode::Automatic {
                    hide_threaded_events: false,
                },
            },
            TimelineFocusView::Thread { root_event_id } => TimelineFocus::Thread {
                thread_id: root_event_id.clone(),
            },
        });
    let builder = if hidden_events {
        builder.event_filter(hidden_event_filter)
    } else {
        builder.event_filter(timeline_event_filter)
    };
    builder.build().await
}

#[cfg(test)]
mod tests {
    use matrix_sdk::ruma::{event_id, serde::Raw};

    use super::TimelineFocusView;

    #[test]
    fn a_live_focus_is_what_an_absent_one_means() {
        let parsed: TimelineFocusView = serde_json::from_str(r#"{"kind":"live"}"#).unwrap();

        assert_eq!(parsed, TimelineFocusView::Live);
        assert_eq!(TimelineFocusView::default(), TimelineFocusView::Live);
    }

    #[test]
    fn a_thread_focus_carries_its_root() {
        let parsed: TimelineFocusView =
            serde_json::from_str(r#"{"kind":"thread","root_event_id":"$root"}"#).unwrap();

        assert_eq!(
            parsed,
            TimelineFocusView::Thread {
                root_event_id: event_id!("$root").to_owned(),
            }
        );
    }

    #[test]
    fn an_event_focus_carries_its_target() {
        let parsed: TimelineFocusView =
            serde_json::from_str(r#"{"kind":"event","event_id":"$target"}"#).unwrap();

        assert_eq!(
            parsed,
            TimelineFocusView::Event {
                event_id: event_id!("$target").to_owned(),
            }
        );
    }

    #[test]
    fn signaling_events_are_filtered_unless_hidden_events_are_on() {
        let rules = matrix_sdk::ruma::room_version_rules::RoomVersionRules::V11;
        let event_json = [
            ("m.rtc.member", "{}", true),
            ("org.matrix.msc4143.rtc.member", "{}", true),
            ("io.element.call.encryption_keys", "{}", false),
            (
                "org.matrix.msc4075.rtc.notification",
                r#"{"m.mentions":{"room":true,"user_ids":[]},"notification_type":"ring","m.relates_to":{"rel_type":"m.reference","event_id":"$root"},"sender_ts":1,"lifetime":30000,"m.text":[]}"#,
                true,
            ),
            (
                "org.matrix.msc4310.rtc.decline",
                r#"{"m.relates_to":{"rel_type":"m.reference","event_id":"$root"}}"#,
                false,
            ),
        ];
        for (event_type, content, hidden) in event_json {
            let state_key = if event_type.ends_with("rtc.member") {
                r#","state_key":"@alice:example.org_DEVICE""#
            } else {
                ""
            };
            let event = Raw::<matrix_sdk::ruma::events::AnySyncTimelineEvent>::from_json_string(
                format!(
                    r#"{{"type":"{event_type}","event_id":"$signal","sender":"@alice:example.org","origin_server_ts":1,"content":{content},"unsigned":{{}}{state_key}}}"#
                ),
            )
            .unwrap()
            .deserialize()
            .unwrap();

            assert!(!super::timeline_event_filter(&event, &rules));
            assert_eq!(super::hidden_event_filter(&event, &rules), hidden);
        }

        let ordinary = Raw::<matrix_sdk::ruma::events::AnySyncTimelineEvent>::from_json_string(
            r#"{"type":"com.example.signal","event_id":"$ordinary","sender":"@alice:example.org","origin_server_ts":1,"content":{},"unsigned":{}}"#.to_owned(),
        )
        .unwrap()
        .deserialize()
        .unwrap();
        assert!(super::is_aggregation(&ordinary, &rules));
        assert!(!super::hidden_event_filter(&ordinary, &rules));
    }

    #[test]
    fn fluffychat_cute_events_reach_the_timeline() {
        let rules = matrix_sdk::ruma::room_version_rules::RoomVersionRules::V11;
        let event = |content: &str| {
            Raw::<matrix_sdk::ruma::events::AnySyncTimelineEvent>::from_json_string(format!(
                r#"{{"type":"m.room.message","event_id":"$cute","sender":"@alice:example.org","origin_server_ts":1,"content":{content},"unsigned":{{}}}}"#
            ))
            .unwrap()
            .deserialize()
            .unwrap()
        };

        let hug = event(r#"{"msgtype":"im.fluffychat.cute_event","cute_type":"hug","body":"🤗"}"#);
        assert!(super::timeline_event_filter(&hug, &rules));

        let other = event(r#"{"msgtype":"com.example.custom","body":"x"}"#);
        assert!(!super::timeline_event_filter(&other, &rules));
    }

    #[test]
    fn aggregations_become_hidden_rows() {
        use matrix_sdk_base::deserialized_responses::TimelineEvent;

        let rules = matrix_sdk::ruma::room_version_rules::RoomVersionRules::V11;
        let event = |json: &str| {
            TimelineEvent::from_plaintext(
                Raw::<matrix_sdk::ruma::events::AnySyncTimelineEvent>::from_json_string(
                    json.to_owned(),
                )
                .unwrap()
                .cast_unchecked(),
            )
        };
        let reaction = event(
            r#"{"type":"m.reaction","event_id":"$reaction","sender":"@alice:example.org","origin_server_ts":7,"content":{"m.relates_to":{"rel_type":"m.annotation","event_id":"$target","key":"👍"}},"unsigned":{}}"#,
        );
        let message = event(
            r#"{"type":"m.room.message","event_id":"$message","sender":"@alice:example.org","origin_server_ts":8,"content":{"msgtype":"m.text","body":"hi"},"unsigned":{}}"#,
        );

        let items = super::aggregation_items([reaction, message], &rules, None);

        assert_eq!(items.len(), 1);
        assert_eq!(items[0].timestamp, 7);
        assert!(matches!(
            &items[0].content,
            crate::protocol::TimelineItemContentView::HiddenEvent { event_type, .. }
                if event_type == "m.reaction"
        ));
    }

    fn cached(json: &str) -> matrix_sdk_base::event_cache::Event {
        matrix_sdk_base::deserialized_responses::TimelineEvent::from_plaintext(
            Raw::<matrix_sdk::ruma::events::AnySyncTimelineEvent>::from_json_string(
                json.to_owned(),
            )
            .unwrap()
            .cast_unchecked(),
        )
    }

    const REPLY: &str = r#"{"type":"m.room.message","event_id":"$reply","sender":"@a:example.org","origin_server_ts":1,"content":{"msgtype":"m.text","body":"x","m.relates_to":{"rel_type":"m.thread","event_id":"$root"}}}"#;
    const ROOT: &str = r#"{"type":"m.room.message","event_id":"$root","sender":"@a:example.org","origin_server_ts":0,"content":{"msgtype":"m.text","body":"x"}}"#;
    const REACTION_ON_REPLY: &str = r#"{"type":"m.reaction","event_id":"$r1","sender":"@a:example.org","origin_server_ts":2,"content":{"m.relates_to":{"rel_type":"m.annotation","event_id":"$reply","key":"x"}}}"#;
    const REACTION_ON_ROOT: &str = r#"{"type":"m.reaction","event_id":"$r2","sender":"@a:example.org","origin_server_ts":3,"content":{"m.relates_to":{"rel_type":"m.annotation","event_id":"$root","key":"x"}}}"#;
    const REACTION_ON_MAIN: &str = r#"{"type":"m.reaction","event_id":"$r3","sender":"@a:example.org","origin_server_ts":4,"content":{"m.relates_to":{"rel_type":"m.annotation","event_id":"$main","key":"x"}}}"#;
    const REDACTION_OF_REPLY: &str = r#"{"type":"m.room.redaction","event_id":"$d1","sender":"@a:example.org","origin_server_ts":5,"redacts":"$reply","content":{"redacts":"$reply"}}"#;
    const REDACTION_OF_MAIN: &str = r#"{"type":"m.room.redaction","event_id":"$d2","sender":"@a:example.org","origin_server_ts":6,"redacts":"$main","content":{"redacts":"$main"}}"#;
    const CUSTOM_IN_THREAD: &str = r#"{"type":"com.example.custom","event_id":"$c1","sender":"@a:example.org","origin_server_ts":7,"content":{"m.relates_to":{"rel_type":"m.thread","event_id":"$root"}}}"#;
    const MAIN: &str = r#"{"type":"m.room.message","event_id":"$main","sender":"@a:example.org","origin_server_ts":0,"content":{"msgtype":"m.text","body":"x"}}"#;

    async fn kept_ids(scope: &super::AggregationScope) -> Vec<String> {
        let known = [REPLY, ROOT, MAIN].map(cached);
        let lookup = |id: matrix_sdk::ruma::OwnedEventId| {
            let found = known
                .iter()
                .find(|event| event.event_id() == Some(&*id))
                .cloned();
            async move { found }
        };
        let events = [
            REACTION_ON_REPLY,
            REACTION_ON_ROOT,
            REACTION_ON_MAIN,
            REDACTION_OF_REPLY,
            REDACTION_OF_MAIN,
            CUSTOM_IN_THREAD,
        ]
        .map(cached);
        scope
            .retain(events.to_vec(), lookup)
            .await
            .iter()
            .map(|event| event.event_id().unwrap().to_string())
            .collect()
    }

    #[tokio::test]
    async fn the_main_timeline_keeps_no_aggregation_of_a_thread_reply() {
        assert_eq!(
            kept_ids(&super::AggregationScope::Main).await,
            ["$r2", "$r3", "$d1", "$d2"]
        );
    }

    #[tokio::test]
    async fn a_thread_keeps_the_aggregations_of_its_replies_and_root() {
        let scope = super::AggregationScope::Thread(event_id!("$root").to_owned());
        assert_eq!(kept_ids(&scope).await, ["$r1", "$r2", "$c1"]);
    }

    #[tokio::test]
    async fn an_unrelated_thread_keeps_none() {
        let scope = super::AggregationScope::Thread(event_id!("$other").to_owned());
        assert_eq!(kept_ids(&scope).await, [] as [String; 0]);
    }

    #[tokio::test]
    async fn a_focused_event_keeps_every_aggregation() {
        assert_eq!(
            kept_ids(&super::AggregationScope::Room).await,
            ["$r1", "$r2", "$r3", "$d1", "$d2", "$c1"]
        );
    }
}
