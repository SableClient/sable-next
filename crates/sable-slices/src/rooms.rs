use std::{collections::BTreeMap, collections::VecDeque, time::Duration};

use sable_model::unread::{
    BadgeDefaults, RoomBadge, RoomBadgesView, SpaceNode, UnreadCountView, room_badges,
};
use sable_protocol::{
    CoreEvent, CoreEventKind, RoomKind, RoomListItemView, RoomStateView, RpcError, SubscriptionId,
    VectorDiff,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::oneshot;

use crate::{
    backoff,
    rpc::timeline::{RoomListSubscribed, SubscribeRoomList, Unsubscribe, WarmRooms},
};
use sable_runtime::{
    AppError, Cmd, Cx, Doc, Interest, Lifetime, ListChanges, ListDoc, Name, Op, Render, Slice,
    Window,
};

const WARM_LIMIT: usize = 32;
const WARM_BATCH: Duration = Duration::from_millis(100);
const WARM_TIMER: Name = "warm";
const RETRY_TIMER: Name = "subscribe";

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
pub struct RoomsStatus {
    /// False until the rows come from the server rather than a saved copy.
    pub settled: bool,
    pub typing: BTreeMap<String, Vec<String>>,
    pub quiet_room_ids: Vec<String>,
    pub badge_defaults: BadgeDefaults,
    pub badges: BTreeMap<String, UnreadCountView>,
    pub space_unread: BTreeMap<String, UnreadCountView>,
}

#[derive(Debug, Serialize, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
pub struct RoomsView {
    #[cfg_attr(feature = "typegen", specta(type = specta_typescript::Number))]
    pub total: usize,
    pub items: Vec<RoomListItemView>,
    pub settled: bool,
    pub typing: BTreeMap<String, Vec<String>>,
    pub quiet_room_ids: Vec<String>,
    pub badge_defaults: BadgeDefaults,
    pub badges: BTreeMap<String, UnreadCountView>,
    pub space_unread: BTreeMap<String, UnreadCountView>,
}

#[derive(Debug, Clone, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum RoomsAction {
    SetPreferences {
        quiet_targets: Vec<String>,
        badge_defaults: BadgeDefaults,
    },
    Warm {
        room_id: String,
    },
}

pub enum Input {
    Action(RoomsAction),
    Subscribed(Result<RoomListSubscribed, RpcError>),
    Resubscribe,
    Diff {
        subscription: SubscriptionId,
        diffs: Vec<VectorDiff<RoomListItemView>>,
    },
    Typing {
        room_id: String,
        user_ids: Vec<String>,
    },
    WarmDue,
}

impl From<RoomsAction> for Input {
    fn from(action: RoomsAction) -> Self {
        Self::Action(action)
    }
}

pub struct RoomsDoc {
    rows: ListDoc<RoomListItemView>,
    status: Doc<RoomsStatus>,
}

impl Default for RoomsDoc {
    fn default() -> Self {
        Self {
            rows: ListDoc::new(Vec::new()),
            status: Doc::new(RoomsStatus::default()),
        }
    }
}

pub struct RoomsChanges {
    rows: Option<ListChanges<RoomListItemView>>,
    status: Option<Vec<Op>>,
}

impl Render for RoomsDoc {
    type Changes = RoomsChanges;

    fn snapshot(&self, window: Option<Window>) -> Result<Value, AppError> {
        let mut snapshot = self.rows.snapshot(window)?;
        if let Value::Object(fields) = &mut snapshot
            && let Value::Object(status) = self.status.snapshot(None)?
        {
            fields.extend(status);
        }
        Ok(snapshot)
    }

    fn drain(&mut self) -> Result<Option<RoomsChanges>, AppError> {
        let rows = self.rows.drain()?;
        let status = self.status.drain()?;
        Ok((rows.is_some() || status.is_some()).then_some(RoomsChanges { rows, status }))
    }

    fn clear(&mut self) {
        self.rows.clear();
        self.status.clear();
    }

    fn project(&self, changes: &RoomsChanges, window: Option<Window>) -> Result<Vec<Op>, AppError> {
        let mut ops = match &changes.rows {
            Some(rows) => self.rows.project(rows, window)?,
            None => Vec::new(),
        };
        ops.extend(changes.status.iter().flatten().cloned());
        Ok(ops)
    }
}

pub struct State {
    doc: RoomsDoc,
    subscription: Option<SubscriptionId>,
    /// Diffs that arrived before the core answered which subscription is ours.
    held: Vec<(SubscriptionId, Vec<VectorDiff<RoomListItemView>>)>,
    starting: Option<oneshot::Receiver<Option<SubscriptionId>>>,
    saved_rows: bool,
    quiet_targets: Vec<String>,
    badges_stale: bool,
    warmed: VecDeque<String>,
    pending_warm: Vec<String>,
    failures: u32,
}

impl State {
    fn new(doc: RoomsDoc) -> Self {
        Self {
            saved_rows: !doc.rows.items().is_empty(),
            doc,
            subscription: None,
            held: Vec::new(),
            starting: None,
            quiet_targets: Vec::new(),
            badges_stale: false,
            warmed: VecDeque::new(),
            pending_warm: Vec::new(),
            failures: 0,
        }
    }

    fn settle(&mut self) {
        if !self.doc.status.view().settled {
            self.doc.status.edit_fields(|status| status.settled = true);
        }
    }

    fn apply(&mut self, diffs: Vec<VectorDiff<RoomListItemView>>) {
        if !self.doc.status.view().settled && !self.doc.rows.items().is_empty() {
            let _ = self.doc.rows.apply(VectorDiff::Clear);
        }
        for diff in diffs {
            if let Err(error) = self.doc.rows.apply(diff) {
                tracing::warn!(%error, "a room list diff did not apply");
            }
        }
        self.settle();
        self.badges_stale = true;
    }

    fn subscribed(&mut self, answer: Result<RoomListSubscribed, RpcError>) -> Cmd<Input> {
        self.starting = None;
        let subscription = match answer {
            Ok(answered) => answered.subscription,
            Err(error) => {
                tracing::warn!(?error, "the room list is unavailable");
                let wait = backoff::delay(self.failures);
                self.failures += 1;
                return Cmd::after(RETRY_TIMER, wait, Input::Resubscribe);
            }
        };
        self.failures = 0;
        self.subscription = Some(subscription);
        if !self.saved_rows {
            self.settle();
        }
        for (held, diffs) in std::mem::take(&mut self.held) {
            if held == subscription {
                self.apply(diffs);
            }
        }
        Cmd::none()
    }

    fn typing(&mut self, room_id: String, user_ids: Vec<String>) {
        let known = self.doc.status.view().typing.contains_key(&room_id);
        if user_ids.is_empty() && !known {
            return;
        }
        self.doc.status.edit_fields(|status| {
            if user_ids.is_empty() {
                status.typing.remove(&room_id);
            } else {
                status.typing.insert(room_id, user_ids);
            }
        });
    }

    fn warm(&mut self, room_id: String) -> Cmd<Input> {
        if self.warmed.contains(&room_id) {
            return Cmd::none();
        }
        self.warmed.push_back(room_id.clone());
        if self.warmed.len() > WARM_LIMIT {
            self.warmed.pop_front();
        }
        self.pending_warm.push(room_id);
        Cmd::after(WARM_TIMER, WARM_BATCH, Input::WarmDue)
    }

    fn refresh_badges(&mut self) {
        self.badges_stale = false;
        let rows = self.doc.rows.items();
        let nodes: Vec<SpaceNode> = rows
            .iter()
            .map(|room| SpaceNode {
                room_id: room.room_id.as_str(),
                is_space: room.room_kind == Some(RoomKind::Space),
                joined: matches!(room.state, RoomStateView::Joined),
                children: room
                    .space_children
                    .iter()
                    .map(|edge| edge.room_id.as_str())
                    .collect(),
            })
            .collect();
        let RoomBadgesView {
            quiet_room_ids,
            badges,
            space_unread,
        } = room_badges(
            &nodes,
            rows.iter().map(|room| RoomBadge {
                room_id: room.room_id.as_str(),
                is_direct: room.is_direct,
                room_override: room.notification.room,
                counts: UnreadCountView {
                    unread: room.counts.unread,
                    highlight: room.counts.highlight,
                    marked: room.counts.marked,
                    notifying: room.counts.notifying,
                },
            }),
            self.quiet_targets.iter().map(String::as_str),
            self.doc.status.view().badge_defaults,
        );
        let status = &mut self.doc.status;
        if status.view().quiet_room_ids != quiet_room_ids {
            status.edit_fields(|status| {
                status.quiet_room_ids = quiet_room_ids;
            });
        }
        if status.view().badges != badges {
            status.edit_fields(|status| status.badges = badges);
        }
        if status.view().space_unread != space_unread {
            status.edit_fields(|status| status.space_unread = space_unread);
        }
    }
}

pub struct Rooms;

impl Slice for Rooms {
    const NAME: &'static str = "rooms";
    const LIFETIME: Lifetime = crate::KEPT;
    const INTEREST: Interest = Interest::of(&[CoreEventKind::RoomListDiff, CoreEventKind::Typing]);
    const PERSIST: bool = true;

    type Key = ();
    type State = State;
    type View = RoomsDoc;
    type Action = RoomsAction;
    type Input = Input;

    fn init((): &(), cached: Option<Value>) -> (State, Cmd<Input>) {
        let doc = cached.and_then(RoomsDoc::from_cached).unwrap_or_default();
        let mut state = State::new(doc);
        let cmd = state.subscribe();
        (state, cmd)
    }

    fn core_input(state: &State, event: &CoreEvent) -> Option<Input> {
        match event {
            CoreEvent::RoomListDiff {
                subscription,
                diffs,
            } if state.subscription == Some(*subscription) || state.starting.is_some() => {
                Some(Input::Diff {
                    subscription: *subscription,
                    diffs: diffs.clone(),
                })
            }
            CoreEvent::Typing { room_id, user_ids } => Some(Input::Typing {
                room_id: room_id.to_string(),
                user_ids: user_ids.iter().map(ToString::to_string).collect(),
            }),
            _ => None,
        }
    }

    fn view(state: &mut State) -> &mut RoomsDoc {
        if state.badges_stale {
            state.refresh_badges();
        }
        &mut state.doc
    }

    fn reduce((): &(), state: &mut State, input: Input, _: &Cx) -> Cmd<Input> {
        match input {
            Input::Action(RoomsAction::SetPreferences {
                quiet_targets,
                badge_defaults,
            }) => {
                state.quiet_targets = quiet_targets;
                if state.doc.status.view().badge_defaults != badge_defaults {
                    state.doc.status.edit_fields(|status| {
                        status.badge_defaults = badge_defaults;
                    });
                }
                state.badges_stale = true;
            }
            Input::Action(RoomsAction::Warm { room_id }) => return state.warm(room_id),
            Input::Subscribed(answer) => return state.subscribed(answer),
            Input::Resubscribe => return state.subscribe(),
            Input::Diff {
                subscription,
                diffs,
            } => {
                if state.subscription == Some(subscription) {
                    state.apply(diffs);
                } else if state.subscription.is_none() && state.starting.is_some() {
                    state.held.push((subscription, diffs));
                }
            }
            Input::Typing { room_id, user_ids } => state.typing(room_id, user_ids),
            Input::WarmDue => {
                let room_ids = std::mem::take(&mut state.pending_warm);
                return Cmd::task(move |ports| async move {
                    if let Err(error) = ports.backend.run(WarmRooms { room_ids }).await {
                        tracing::debug!(?error, "rooms were not warmed");
                    }
                    None
                });
            }
        }
        Cmd::none()
    }

    fn dispose((): &(), state: &mut State) -> Cmd<Input> {
        let active_subscription = state.subscription.take();
        let starting = state.starting.take();
        Cmd::task(move |ports| async move {
            if let Some(starting) = starting
                && let Ok(Some(subscription)) = starting.await
                && Some(subscription) != active_subscription
                && let Err(error) = ports.backend.run(Unsubscribe { subscription }).await
            {
                tracing::debug!(?error, "the room list subscription was not ended");
            }
            let subscription = active_subscription?;
            if let Err(error) = ports.backend.run(Unsubscribe { subscription }).await {
                tracing::debug!(?error, "the room list subscription was not ended");
            }
            None
        })
    }
}

impl State {
    fn subscribe(&mut self) -> Cmd<Input> {
        let (sent, done) = oneshot::channel();
        self.starting = Some(done);
        Cmd::task(move |ports| async move {
            let answer = ports.backend.run(SubscribeRoomList {}).await;
            let _ = sent.send(answer.as_ref().ok().map(|answer| answer.subscription));
            Some(Input::Subscribed(answer))
        })
    }
}

impl RoomsDoc {
    #[must_use]
    pub fn rows(&self) -> &[RoomListItemView] {
        self.rows.items()
    }

    #[must_use]
    pub const fn status(&self) -> &RoomsStatus {
        self.status.view()
    }

    fn from_cached(cached: Value) -> Option<Self> {
        let Value::Object(mut fields) = cached else {
            return None;
        };
        let items = serde_json::from_value(fields.remove("items")?).ok()?;
        fields.remove("total");
        let mut status: RoomsStatus = serde_json::from_value(Value::Object(fields)).ok()?;
        status.settled = false;
        status.typing.clear();
        Some(Self {
            rows: ListDoc::new(items),
            status: Doc::new(status),
        })
    }
}
