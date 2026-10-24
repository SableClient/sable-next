//! Where the reader stopped reading: the first message they have not seen,
//! and whether they have reached it.

use std::collections::HashSet;

use sable_protocol::TimelineItemContentView;

use super::{
    rows::{is_unread_message, unread_count_from},
    view::{Shared, TimelineUnreadView},
};

#[derive(Debug, Default)]
#[expect(
    clippy::struct_excessive_bools,
    reason = "the tracker's states are independent of each other"
)]
pub struct Unread {
    initialized: bool,
    loading: bool,
    active: bool,
    reached: bool,
    background: bool,
    first_event_id: Option<String>,
    read_event_id: Option<String>,
    failed: bool,
    loading_marker: bool,
    #[expect(
        clippy::option_option,
        reason = "the outer option distinguishes no observation from an empty timeline"
    )]
    last_event: Option<Option<String>>,
}

/// What the reader's window shows, as the UI last reported it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Viewing {
    pub focused: bool,
    /// The newest row the window shows, as the reader sees it.
    pub newest: Option<String>,
}

fn event_id_of(item: &Shared) -> Option<&str> {
    item.event_id.as_ref().map(|id| id.as_str())
}

impl Unread {
    #[must_use]
    pub const fn blocking(&self) -> bool {
        !self.initialized || self.loading || (self.active && !self.reached)
    }

    #[must_use]
    pub const fn active(&self) -> bool {
        self.active
    }

    #[must_use]
    pub const fn initialized(&self) -> bool {
        self.initialized
    }

    #[must_use]
    pub const fn loading_marker(&self) -> bool {
        self.loading_marker
    }

    #[must_use]
    pub fn first_event_id(&self) -> Option<&str> {
        self.first_event_id.as_deref()
    }

    pub fn initialize(
        &mut self,
        items: &[Shared],
        has_unread: bool,
        visible: &[Shared],
        read_event_id: Option<&str>,
    ) -> bool {
        if self.loading_marker {
            return false;
        }
        if self.initialized && !self.failed {
            return false;
        }
        if !self.initialized {
            self.active = has_unread
                || items
                    .iter()
                    .any(|item| matches!(item.content, TimelineItemContentView::ReadMarker));
            if self.read_event_id.is_none() {
                self.read_event_id = read_event_id.map(ToOwned::to_owned);
            }
        }
        self.initialized = true;
        self.failed = false;
        self.resolve(items, false, visible);
        if !self.active || self.first_event_id.is_some() {
            return false;
        }
        self.loading = true;
        self.loading_marker = true;
        true
    }

    /// The read marker the server holds, or that it could not be fetched.
    pub fn loaded(&mut self, marker: Result<Option<String>, ()>) {
        match marker {
            Ok(event_id) => self.read_event_id = event_id,
            Err(()) => self.failed = true,
        }
        self.loading = false;
        self.loading_marker = false;
    }

    pub const fn interrupt_load(&mut self) {
        if self.loading_marker {
            self.loading_marker = false;
            self.loading = false;
            self.failed = true;
        }
    }

    /// Only arrivals after the last observed event can create a background boundary.
    pub fn track_background(&mut self, visible: &[Shared], focused: bool) {
        let latest = super::rows::latest_event_id(visible);
        let previous = self.last_event.replace(latest.clone());
        let Some(previous) = previous else {
            return;
        };
        if focused || previous == latest {
            return;
        }
        let after = match previous.as_deref() {
            Some(id) => {
                let Some(index) = visible
                    .iter()
                    .position(|item| event_id_of(item) == Some(id))
                else {
                    return;
                };
                index + 1
            }
            None => 0,
        };
        let first = visible
            .iter()
            .skip(after)
            .find(|item| is_unread_message(item));
        let Some(first) = first.and_then(|item| event_id_of(item)) else {
            return;
        };
        if !self.active {
            self.read_event_id = previous;
            self.first_event_id = Some(first.to_owned());
        }
        self.active = true;
        self.reached = false;
        self.background = true;
    }

    /// Arrivals while the window is unfocused start a boundary, and a focused
    /// window that shows the newest message has reached the end of the unread ones.
    pub fn attend(&mut self, viewing: &Viewing, latest: Option<&str>, visible: &[Shared]) {
        self.track_background(visible, viewing.focused);
        if viewing.focused
            && !self.background
            && latest.is_some()
            && viewing.newest.as_deref() == latest
        {
            self.reach_latest();
        }
    }

    /// A read receipt was sent up to `event_id`.
    pub fn read(&mut self, event_id: &str, latest: Option<&str>) {
        if latest == Some(event_id) {
            self.dismiss();
        }
    }

    pub fn resolve(&mut self, items: &[Shared], oldest_loaded: bool, visible: &[Shared]) {
        if !self.active || self.loading || self.failed {
            return;
        }
        let unseen: HashSet<&str> = visible
            .iter()
            .filter(|item| is_unread_message(item))
            .filter_map(|item| event_id_of(item))
            .collect();
        let holds = |item: &Shared| event_id_of(item).is_some_and(|id| unseen.contains(id));

        if let Some(first) = self.first_event_id.as_deref() {
            if unseen.contains(first) {
                return;
            }
            let Some(index) = items
                .iter()
                .position(|item| event_id_of(item) == Some(first))
            else {
                return;
            };
            let next = items
                .iter()
                .skip(index + 1)
                .find(|item| holds(item))
                .and_then(|item| event_id_of(item).map(ToOwned::to_owned));
            if next.is_some() {
                self.first_event_id = next;
            }
            return;
        }

        let marker = items
            .iter()
            .position(|item| matches!(item.content, TimelineItemContentView::ReadMarker));
        let read = self.read_event_id.as_deref().and_then(|read| {
            items
                .iter()
                .position(|item| event_id_of(item) == Some(read))
        });
        let boundary = marker.or(read);
        if boundary.is_none() && !oldest_loaded {
            return;
        }
        let after = boundary.map_or(0, |at| at + 1);
        let first = items
            .iter()
            .skip(after)
            .find(|item| holds(item))
            .and_then(|item| event_id_of(item).map(ToOwned::to_owned));
        if first.is_some() {
            self.first_event_id = first;
        } else if boundary.is_some() || oldest_loaded {
            self.dismiss();
        }
    }

    /// The unread messages the reader can see, from the first one on.
    #[must_use]
    pub fn count(&self, visible: &[Shared]) -> u32 {
        self.first_event_id
            .as_deref()
            .and_then(|first| {
                visible
                    .iter()
                    .position(|item| event_id_of(item) == Some(first))
            })
            .map_or(0, |index| unread_count_from(visible, index))
    }

    pub fn observe(&mut self, first_visible: Option<&str>) {
        if self.active && first_visible.is_some() && first_visible == self.first_event_id.as_deref()
        {
            self.reached = true;
            self.background = false;
        }
    }

    pub const fn reach_latest(&mut self) {
        if self.active {
            self.reached = true;
            self.background = false;
        }
    }

    pub const fn dismiss(&mut self) {
        self.active = false;
        self.reached = true;
        self.background = false;
    }

    pub fn clear(&mut self) {
        self.dismiss();
        self.first_event_id = None;
    }

    #[must_use]
    pub fn view(&self, visible: &[Shared]) -> TimelineUnreadView {
        TimelineUnreadView {
            initialized: self.initialized,
            loading: self.loading,
            active: self.active,
            first_event_id: self.first_event_id.clone(),
            read_event_id: self.read_event_id.clone(),
            failed: self.failed,
            count: self.count(visible),
            blocking: self.blocking(),
        }
    }
}
