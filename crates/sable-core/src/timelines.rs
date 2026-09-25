use std::sync::Arc;

use matrix_sdk::executor::spawn;
use matrix_sdk::ruma::{
    OwnedEventId, OwnedRoomId, UserId,
    events::room::message::Relation,
    events::{
        AnyMessageLikeEventContent, AnySyncMessageLikeEvent, AnySyncTimelineEvent,
        MessageLikeEventType, poll::unstable_start::UnstablePollStartEventContent,
    },
    room_version_rules::RoomVersionRules,
};
use matrix_sdk_ui::timeline::{
    RoomExt, Timeline, TimelineEventFocusThreadMode, TimelineFocus, default_event_filter,
};

use matrix_sdk_base::event_cache::Event;

use crate::protocol::{CommandErr, TimelineFocusView, TimelineItemView};
use crate::view::aggregation_item;

use crate::{CachedTimeline, Core, SubscriptionKind, ThreadKey};

const MAX_CACHED_INACTIVE_TIMELINES: usize = 4;
const MAX_CACHED_THREAD_TIMELINES: usize = 4;

impl Core {
    /// Cached: building one twice gives the UI two streams for one room. Takes
    /// whatever the subscriber built, since rebuilding here would orphan the
    /// timeline the UI reads and send its local echo to the copy.
    pub(crate) async fn timeline(
        &self,
        room_id: &OwnedRoomId,
    ) -> Result<Arc<Timeline>, CommandErr> {
        {
            let session = self.session.read().await;
            session.as_ref().ok_or(CommandErr::NotLoggedIn)?;
            if let Some(cached) = self.timelines.lock().await.get(room_id) {
                return Ok(cached.timeline.clone());
            }
        }
        self.live_timeline(room_id, false).await
    }

    /// The cache holds one live timeline per room, so a `hidden_events` that no
    /// longer matches replaces it rather than sitting alongside it.
    #[allow(clippy::arc_with_non_send_sync)] // Matrix timelines are single-threaded on WASM
    pub(crate) async fn live_timeline(
        &self,
        room_id: &OwnedRoomId,
        hidden_events: bool,
    ) -> Result<Arc<Timeline>, CommandErr> {
        let session = self.session.read().await;
        let room = session
            .as_ref()
            .ok_or(CommandErr::NotLoggedIn)?
            .client
            .get_room(room_id)
            .ok_or(CommandErr::UnknownRoom)?;
        {
            let mut timelines = self.timelines.lock().await;
            if let Some(cached) = timelines.get_mut(room_id)
                && cached.hidden_events == hidden_events
            {
                cached.last_access = self.next_timeline_access();
                return Ok(cached.timeline.clone());
            }
        }

        let timeline = Arc::new(
            build_room_timeline(&room, &TimelineFocusView::Live, hidden_events)
                .await
                .map_err(|error| self.failed("build timeline", error))?,
        );

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
        match timelines.get_mut(room_id) {
            Some(cached) if cached.hidden_events == hidden_events => {
                cached.last_access = self.next_timeline_access();
                Ok(cached.timeline.clone())
            }
            _ => {
                let inactive = timelines
                    .keys()
                    .filter(|id| !subscribed_room_ids.contains(*id))
                    .count();
                if inactive >= MAX_CACHED_INACTIVE_TIMELINES
                    && let Some(evicted) = timelines
                        .iter()
                        .filter(|(id, _)| !subscribed_room_ids.contains(*id))
                        .min_by_key(|(_, cached)| cached.last_access)
                        .map(|(id, _)| id.clone())
                {
                    timelines.remove(&evicted);
                }
                timelines.insert(
                    room_id.clone(),
                    CachedTimeline {
                        timeline: timeline.clone(),
                        hidden_events,
                        last_access: self.next_timeline_access(),
                    },
                );
                Ok(timeline)
            }
        }
    }
}

impl Core {
    pub(crate) async fn timeline_for(
        &self,
        room_id: &OwnedRoomId,
        thread_root: Option<&OwnedEventId>,
    ) -> Result<Arc<Timeline>, CommandErr> {
        match thread_root {
            Some(root) => self.thread_timeline(room_id, root).await,
            None => self.timeline(room_id).await,
        }
    }

    #[allow(clippy::arc_with_non_send_sync)] // Matrix timelines are single-threaded on WASM
    pub(crate) async fn thread_timeline(
        &self,
        room_id: &OwnedRoomId,
        root_event_id: &OwnedEventId,
    ) -> Result<Arc<Timeline>, CommandErr> {
        let session = self.session.read().await;
        let room = session
            .as_ref()
            .ok_or(CommandErr::NotLoggedIn)?
            .client
            .get_room(room_id)
            .ok_or(CommandErr::UnknownRoom)?;
        let key: ThreadKey = (room_id.clone(), root_event_id.clone());
        {
            let mut threads = self.thread_timelines.lock().await;
            if let Some(cached) = threads.get_mut(&key) {
                cached.last_access = self.next_timeline_access();
                return Ok(cached.timeline.clone());
            }
        }

        let focus = TimelineFocusView::Thread {
            root_event_id: root_event_id.clone(),
        };
        let timeline = Arc::new(
            build_room_timeline(&room, &focus, false)
                .await
                .map_err(|error| self.failed("build thread timeline", error))?,
        );

        let mut threads = self.thread_timelines.lock().await;
        if let Some(cached) = threads.get_mut(&key) {
            cached.last_access = self.next_timeline_access();
            return Ok(cached.timeline.clone());
        }

        if threads.len() >= MAX_CACHED_THREAD_TIMELINES
            && let Some(evicted) = threads
                .iter()
                .min_by_key(|(_, cached)| cached.last_access)
                .map(|(id, _)| id.clone())
        {
            threads.remove(&evicted);
        }
        threads.insert(
            key,
            CachedTimeline {
                timeline: timeline.clone(),
                hidden_events: false,
                last_access: self.next_timeline_access(),
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
        AnyMessageLikeEventContent::Reaction(_)
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
    !is_signaling_event(event) && default_event_filter(event, rules)
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
    let builder = room.timeline_builder().with_focus(match focus {
        TimelineFocusView::Live => TimelineFocus::Live {
            hide_threaded_events: true,
        },
        TimelineFocusView::Event { event_id } => TimelineFocus::Event {
            target: event_id.clone(),
            num_context_events: 20,
            thread_mode: TimelineEventFocusThreadMode::Automatic {
                hide_threaded_events: false,
            },
        },
        TimelineFocusView::Thread { root_event_id } => TimelineFocus::Thread {
            root_event_id: root_event_id.clone(),
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
            ("io.element.call.encryption_keys", "{}", true),
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
            let event = Raw::<matrix_sdk::ruma::events::AnySyncTimelineEvent>::from_json_string(
                format!(
                    r#"{{"type":"{event_type}","event_id":"$signal","sender":"@alice:example.org","origin_server_ts":1,"content":{content},"unsigned":{{}}}}"#
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
        assert!(super::hidden_event_filter(&ordinary, &rules));
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
}
