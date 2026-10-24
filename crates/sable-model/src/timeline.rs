//! Timeline coordinates and grouping shared by live rows and standalone previews.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
pub struct TimelineKey {
    pub room_id: String,
    pub view: String,
}

/// How a timeline row is drawn: a message carries a sender, a hover menu and
/// reactions; an event is a one-line notice; an annotation is a divider.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
#[serde(rename_all = "snake_case")]
pub enum TimelineRowKind {
    Message,
    Event,
    Annotation,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
#[serde(rename_all = "snake_case")]
pub enum TimelineReplyStyleView {
    #[default]
    Connected,
    Compact,
    Expanded,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
pub struct TimelineGroupProfile {
    pub id: Option<String>,
    pub display_name: Option<String>,
    pub avatar_url: Option<String>,
}

/// Only the facts a preview needs; message bodies and media stay in the shell.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
pub struct TimelineGroupInput {
    pub row: TimelineRowKind,
    pub sender: Option<String>,
    #[cfg_attr(feature = "typegen", specta(type = Option<specta_typescript::Number>))]
    pub timestamp: Option<u64>,
    pub reply: bool,
    pub profile: Option<TimelineGroupProfile>,
}

#[derive(Debug, Clone, Copy, Default)]
pub struct GroupProfile<'a> {
    pub id: Option<&'a str>,
    pub display_name: Option<&'a str>,
    pub avatar_url: Option<&'a str>,
}

#[derive(Debug, Clone, Copy)]
pub struct GroupItem<'a> {
    pub row: TimelineRowKind,
    pub sender: Option<&'a str>,
    pub timestamp: Option<u64>,
    pub reply: bool,
    pub profile: Option<GroupProfile<'a>>,
}

impl TimelineGroupInput {
    /// Whether this row continues the visual group of `previous`.
    #[must_use]
    pub fn collapsed_after(&self, previous: &Self, style: TimelineReplyStyleView) -> bool {
        collapsed(previous.facts(), self.facts(), style)
    }

    fn facts(&self) -> GroupItem<'_> {
        GroupItem {
            row: self.row,
            sender: self.sender.as_deref(),
            timestamp: self.timestamp,
            reply: self.reply,
            profile: self.profile.as_ref().map(|profile| GroupProfile {
                id: profile.id.as_deref(),
                display_name: profile.display_name.as_deref(),
                avatar_url: profile.avatar_url.as_deref(),
            }),
        }
    }
}

fn persona_key(profile: Option<GroupProfile<'_>>) -> impl Iterator<Item = u8> + '_ {
    let profile = profile.unwrap_or_default();
    profile
        .id
        .or(profile.display_name)
        .unwrap_or_default()
        .bytes()
        .chain(profile.avatar_url.unwrap_or_default().bytes())
}

/// Whether the current row continues the previous row's visual group.
#[must_use]
pub fn collapsed(
    previous: GroupItem<'_>,
    current: GroupItem<'_>,
    style: TimelineReplyStyleView,
) -> bool {
    if current.row == TimelineRowKind::Event && previous.row == TimelineRowKind::Event {
        return true;
    }
    if style == TimelineReplyStyleView::Connected && current.reply {
        return false;
    }
    current.row == TimelineRowKind::Message
        && previous.row == TimelineRowKind::Message
        && current.sender.is_some()
        && current.sender == previous.sender
        && persona_key(current.profile).eq(persona_key(previous.profile))
        && current
            .timestamp
            .zip(previous.timestamp)
            .is_some_and(|(now, before)| now.abs_diff(before) < 120_000)
}

/// The confirmed event before the selected message, skipping virtual rows and echoes.
#[must_use]
pub fn event_before(events: &[Option<String>], target: &str) -> Option<String> {
    let index = events
        .iter()
        .position(|event| event.as_deref() == Some(target))?;
    events
        .get(..index)?
        .iter()
        .rev()
        .flatten()
        .find(|event| !event.is_empty())
        .cloned()
}

#[cfg(test)]
mod tests {
    use super::{
        GroupItem, GroupProfile, TimelineReplyStyleView, TimelineRowKind, collapsed, event_before,
    };

    fn message() -> GroupItem<'static> {
        GroupItem {
            row: TimelineRowKind::Message,
            sender: Some("@a:x"),
            timestamp: Some(0),
            reply: false,
            profile: None,
        }
    }

    #[test]
    fn media_and_text_share_the_message_row_grouping_rule() {
        let first = message();
        let second = GroupItem {
            timestamp: Some(1_000),
            ..first
        };
        let third = GroupItem {
            timestamp: Some(2_000),
            ..first
        };
        for (before, current) in [(first, second), (second, third), (first, third)] {
            assert!(collapsed(
                before,
                current,
                TimelineReplyStyleView::Connected
            ));
        }
    }

    #[test]
    fn event_rows_stack_but_annotations_and_missing_senders_do_not() {
        let event = GroupItem {
            row: TimelineRowKind::Event,
            sender: None,
            timestamp: None,
            reply: true,
            ..message()
        };
        let annotation = GroupItem {
            row: TimelineRowKind::Annotation,
            ..event
        };
        for style in [
            TimelineReplyStyleView::Connected,
            TimelineReplyStyleView::Compact,
            TimelineReplyStyleView::Expanded,
        ] {
            assert!(collapsed(event, event, style));
            assert!(!collapsed(event, message(), style));
            assert!(!collapsed(message(), event, style));
            assert!(!collapsed(annotation, event, style));
            assert!(!collapsed(
                GroupItem {
                    sender: None,
                    ..message()
                },
                GroupItem {
                    sender: None,
                    ..message()
                },
                style
            ));
        }
    }

    #[test]
    fn connected_replies_break_groups_and_the_time_boundary_is_exclusive() {
        let first = message();
        let reply = GroupItem {
            reply: true,
            timestamp: Some(1_000),
            ..first
        };
        assert!(!collapsed(first, reply, TimelineReplyStyleView::Connected));
        for style in [
            TimelineReplyStyleView::Compact,
            TimelineReplyStyleView::Expanded,
        ] {
            assert!(collapsed(first, reply, style));
        }
        for distance in [0, 119_999, 120_000, 120_001] {
            let later = GroupItem {
                timestamp: Some(distance),
                ..first
            };
            assert_eq!(
                collapsed(first, later, TimelineReplyStyleView::Connected),
                distance < 120_000
            );
            assert_eq!(
                collapsed(later, first, TimelineReplyStyleView::Connected),
                distance < 120_000
            );
        }
        assert!(!collapsed(
            first,
            GroupItem {
                timestamp: None,
                ..first
            },
            TimelineReplyStyleView::Compact
        ));
        assert!(!collapsed(
            first,
            GroupItem {
                sender: Some("@other:x"),
                ..first
            },
            TimelineReplyStyleView::Compact
        ));
    }

    #[test]
    fn persona_ids_names_and_alternate_avatars_preserve_group_boundaries() {
        let account = message();
        let named = GroupItem {
            profile: Some(GroupProfile {
                id: Some("persona"),
                ..GroupProfile::default()
            }),
            ..account
        };
        assert!(!collapsed(
            account,
            named,
            TimelineReplyStyleView::Connected
        ));
        assert!(collapsed(
            named,
            GroupItem {
                profile: Some(GroupProfile {
                    id: None,
                    display_name: Some("persona"),
                    avatar_url: None
                }),
                ..account
            },
            TimelineReplyStyleView::Connected
        ));
        let alternate = GroupItem {
            profile: Some(GroupProfile {
                avatar_url: Some("mxc://server/other"),
                ..named.profile.unwrap()
            }),
            ..named
        };
        assert!(!collapsed(
            named,
            alternate,
            TimelineReplyStyleView::Connected
        ));
        let empty_id = GroupItem {
            profile: Some(GroupProfile {
                id: Some(""),
                display_name: Some("ignored"),
                avatar_url: None,
            }),
            ..account
        };
        assert!(collapsed(
            account,
            empty_id,
            TimelineReplyStyleView::Connected
        ));
    }

    #[test]
    fn profile_identity_keeps_the_original_concatenated_key_semantics() {
        let first = GroupItem {
            profile: Some(GroupProfile {
                id: Some("ab"),
                display_name: None,
                avatar_url: Some("c"),
            }),
            ..message()
        };
        let second = GroupItem {
            profile: Some(GroupProfile {
                id: Some("a"),
                display_name: None,
                avatar_url: Some("bc"),
            }),
            ..message()
        };
        assert!(collapsed(first, second, TimelineReplyStyleView::Connected));
    }

    fn events(ids: &[Option<&str>]) -> Vec<Option<String>> {
        ids.iter().map(|id| id.map(str::to_owned)).collect()
    }

    #[test]
    fn finds_the_previous_confirmed_event() {
        let ids = events(&[Some("$above"), None, Some("$first-held")]);
        assert_eq!(event_before(&ids, "$first-held").as_deref(), Some("$above"));
        assert_eq!(event_before(&ids, "$above"), None);
        assert_eq!(event_before(&ids, "$missing"), None);
    }

    #[test]
    fn empty_timelines_and_unconfirmed_prefixes_have_no_predecessor() {
        assert_eq!(event_before(&[], "$target"), None);
        assert_eq!(
            event_before(&events(&[None, None, Some("$target")]), "$target"),
            None
        );
    }

    #[test]
    fn duplicate_targets_keep_the_first_position_and_empty_ids_are_skipped() {
        let ids = events(&[
            Some("$first"),
            None,
            Some(""),
            Some("$target"),
            Some("$later"),
            Some("$target"),
        ]);
        assert_eq!(event_before(&ids, "$target").as_deref(), Some("$first"));
        assert_eq!(event_before(&ids, "$later").as_deref(), Some("$target"));
    }
}
