//! A room's timeline as the app shows it: what the core loaded, which of it
//! the reader sees, and how history reaches. Each key is its own timeline, so a
//! room and a thread of it can be open together.
//!
//! The core keeps the Matrix timeline; this slice follows its subscription and
//! turns the items into the rows a UI draws.

mod doc;
mod identity;
mod receipts;
mod rows;
mod state;
mod unread;
mod view;

use sable_protocol::{CoreEvent, CoreEventKind};
use sable_runtime::{Cmd, Cx, Interest, Lifetime, Slice};
use serde_json::Value;

pub use doc::TimelineDoc;
pub use sable_protocol::PaginationDirection as TimelineDirectionView;
pub use sable_protocol::TimelineKey;
pub use state::{Input, LOAD_FAILED, State};
pub use view::{
    PaginationStateView, TimelineAction, TimelineFiltersView, TimelineMemberCategoryView,
    TimelineModeView, TimelinePaginated, TimelineReceiptsView, TimelineSegmentView, TimelineStatus,
    TimelineSubjectView,
};
#[cfg(feature = "typegen")]
pub use view::{TimelineDocView, TimelineRowView};

pub struct Timeline;

impl Slice for Timeline {
    const NAME: &'static str = "timeline";
    const LIFETIME: Lifetime = crate::KEPT;
    const INTEREST: Interest = Interest::of(&[
        CoreEventKind::TimelineDiff,
        CoreEventKind::TimelinePagination,
        CoreEventKind::TimelineAggregations,
    ]);

    type Key = TimelineKey;
    type State = State;
    type View = TimelineDoc;
    type Action = TimelineAction;
    type Input = Input;

    fn init(key: &TimelineKey, _: Option<Value>) -> (State, Cmd<Input>) {
        (State::new(key.clone()), Cmd::none())
    }

    fn event_key(event: &CoreEvent) -> Option<TimelineKey> {
        match event {
            CoreEvent::TimelineDiff { key, .. } => key.clone(),
            _ => None,
        }
    }

    fn core_input(state: &State, event: &CoreEvent) -> Option<Input> {
        match event {
            CoreEvent::TimelineDiff {
                subscription,
                key,
                diffs,
            } if state.listening(key.as_ref(), *subscription) => Some(Input::Diff {
                subscription: *subscription,
                diffs: diffs.clone(),
            }),
            CoreEvent::TimelinePagination {
                subscription,
                loading,
                reached_start,
            } if state.follows(*subscription) => Some(Input::Pagination {
                loading: *loading,
                reached_start: *reached_start,
            }),
            CoreEvent::TimelineAggregations {
                subscription,
                items,
            } if state.follows(*subscription) => Some(Input::Aggregations {
                items: items.clone(),
            }),
            _ => None,
        }
    }

    fn view(state: &mut State) -> &mut TimelineDoc {
        state.refresh();
        &mut state.doc
    }

    fn reduce(_: &TimelineKey, state: &mut State, input: Input, cx: &Cx) -> Cmd<Input> {
        state.reduce(input, cx.req())
    }

    fn dispose(_: &TimelineKey, state: &mut State) -> Cmd<Input> {
        state.dispose()
    }
}

#[cfg(test)]
mod tests;
