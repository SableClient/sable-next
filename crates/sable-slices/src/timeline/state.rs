//! The state of one timeline and the rules that move it. Nothing here waits:
//! what has to happen outside is returned as a `Cmd`, and what comes back is
//! another `Input`.

use std::collections::HashSet;

use tokio::sync::oneshot;

use sable_protocol::PaginationDirection as TimelineDirectionView;
use sable_protocol::{
    RpcError, SubscriptionId, TimelineItemContentView, TimelineItemView, VectorDiff,
};
use sable_runtime::{Cmd, ReqId, list_diff};

use super::{
    TimelineKey,
    doc::TimelineDoc,
    identity::Identity,
    rows::{self, Rows, RowsInput},
    unread::{Unread, Viewing},
    view::{
        PaginationStateView, Shared, TimelineAction, TimelineFiltersView, TimelineModeView,
        TimelinePaginated, TimelineStatus,
    },
};
use crate::rpc::timeline::{
    FetchEventDetails, Paginate, PaginateOk, ReadMarker, Subscribe, SubscribeOk, Unsubscribe,
};
use sable_model::timeline::TimelineReplyStyleView;

pub const LOAD_FAILED: &str = "load_failed";
const PENDING_DIFF_CAP: usize = 256;

#[derive(Debug)]
pub enum Input {
    Action(TimelineAction),
    Diff {
        subscription: SubscriptionId,
        diffs: Vec<VectorDiff<TimelineItemView>>,
    },
    Pagination {
        loading: bool,
        reached_start: bool,
    },
    Aggregations {
        items: Vec<TimelineItemView>,
    },
    Subscribed {
        session: u64,
        fallback: bool,
        answer: Result<SubscribeOk, RpcError>,
    },
    MarkerLoaded {
        session: u64,
        answer: Result<Option<String>, RpcError>,
    },
    /// The read marker the unread tracker asked for.
    UnreadMarker {
        session: u64,
        answer: Result<Option<String>, RpcError>,
    },
    /// The subscription that was open before a jump is gone.
    Released {
        session: u64,
        event_id: String,
        failed: bool,
    },
    /// A subscription ended that a new one waited for.
    Unsubscribed,
    Paginated {
        session: u64,
        generation: u64,
        subscription: SubscriptionId,
        direction: TimelineDirectionView,
        req: Option<ReqId>,
        answer: Result<PaginateOk, RpcError>,
    },
}

impl From<TimelineAction> for Input {
    fn from(action: TimelineAction) -> Self {
        Self::Action(action)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Target {
    mode: TimelineModeView,
    hidden_events: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Phase {
    Stopped,
    Starting,
    Active,
}

#[derive(Debug, Clone)]
struct OpenRequest {
    mode: TimelineModeView,
    hidden_events: bool,
    unread: bool,
    /// `None` leaves what the tracker was told as it is.
    has_unread: Option<bool>,
    landing: Option<String>,
    force: bool,
}

/// The first subscribe's answer, held while the read marker is looked up.
struct Held {
    mode: TimelineModeView,
    response: SubscribeOk,
}

struct Starting {
    session: u64,
    done: oneshot::Receiver<Option<SubscriptionId>>,
}

struct Config {
    filters: TimelineFiltersView,
    reply_style: TimelineReplyStyleView,
    read_only: bool,
    utc_offset_ms: i64,
    thread_root: Option<String>,
}

/// What the tracker and the read state belong to.
#[derive(Debug, PartialEq, Eq)]
struct Context {
    thread_root: Option<String>,
}

struct Resume {
    req: Option<ReqId>,
    joiners: Vec<ReqId>,
}

pub struct State {
    key: TimelineKey,
    read_marker: Option<String>,
    pub(super) doc: TimelineDoc,
    /// What the core sent, before the reader's filters. Rows are built from it and it is not served.
    config: Config,
    target: Option<Target>,
    plan: Option<OpenRequest>,
    session: u64,
    phase: Phase,
    subscription: Option<SubscriptionId>,
    /// Diffs that arrived before the core answered which subscription is ours.
    pending_diffs: Vec<(SubscriptionId, Vec<VectorDiff<TimelineItemView>>)>,
    held: Option<Held>,
    starting: Vec<Starting>,
    /// The opens that wait for the start in flight, the first one included.
    waiters: Vec<ReqId>,
    resume: Option<Resume>,
    unsubscribing: usize,
    deferred: Option<(OpenRequest, Option<ReqId>)>,
    pagination_generation: u64,
    items_version: u64,
    details_version: u64,
    requested_details: HashSet<String>,
    identity: Identity,
    /// What the filters leave of the items, without hidden-event aggregations.
    event_items: Vec<Shared>,
    unread: Unread,
    has_unread: bool,
    viewing: Option<Viewing>,
    unread_waiters: Vec<ReqId>,
    context: Option<Context>,
    stale: bool,
}

impl State {
    #[must_use]
    pub(super) fn new(key: TimelineKey) -> Self {
        Self {
            key,
            read_marker: None,
            doc: TimelineDoc::default(),
            config: Config {
                filters: TimelineFiltersView::default(),
                reply_style: TimelineReplyStyleView::default(),
                read_only: false,
                utc_offset_ms: 0,
                thread_root: None,
            },
            target: None,
            plan: None,
            session: 0,
            phase: Phase::Stopped,
            subscription: None,
            pending_diffs: Vec::new(),
            held: None,
            starting: Vec::new(),
            waiters: Vec::new(),
            resume: None,
            unsubscribing: 0,
            deferred: None,
            pagination_generation: 0,
            items_version: 0,
            details_version: 0,
            requested_details: HashSet::new(),
            identity: Identity::default(),
            event_items: Vec::new(),
            unread: Unread::default(),
            has_unread: false,
            viewing: None,
            unread_waiters: Vec::new(),
            context: None,
            stale: false,
        }
    }

    const fn status(&self) -> &TimelineStatus {
        self.doc.status.view()
    }

    fn edit_status(&mut self, edit: impl FnOnce(&mut TimelineStatus)) {
        self.doc.status.edit_fields(edit);
        self.stale = true;
    }

    fn reply_all(reqs: Vec<ReqId>) -> Cmd<Input> {
        Cmd::batch(reqs.into_iter().map(|req| Cmd::reply(Some(req), Ok(()))))
    }

    pub(super) fn reduce(&mut self, input: Input, req: Option<ReqId>) -> Cmd<Input> {
        let cmd = match input {
            Input::Action(action) => self.act(action, req),
            Input::Diff {
                subscription,
                diffs,
            } => {
                self.diff_event(subscription, diffs);
                Cmd::none()
            }
            Input::Pagination {
                loading,
                reached_start,
            } => {
                if self.status().mode == TimelineModeView::Live {
                    let state = if loading {
                        PaginationStateView::Loading
                    } else if reached_start {
                        PaginationStateView::End
                    } else {
                        PaginationStateView::Idle
                    };
                    self.edit_status(|status| status.backward_pagination = state);
                }
                Cmd::none()
            }
            Input::Aggregations { items } => {
                self.upsert_aggregations(items);
                Cmd::none()
            }
            Input::Subscribed {
                session,
                fallback,
                answer,
            } => self.subscribed(session, fallback, answer),
            Input::MarkerLoaded { session, answer } => self.marker_loaded(session, answer),
            Input::UnreadMarker { session, answer } => self.unread_marker(session, answer),
            Input::Released {
                session,
                event_id,
                failed,
            } => self.released(session, event_id, failed),
            Input::Unsubscribed => self.unsubscribed(),
            Input::Paginated {
                session,
                generation,
                subscription,
                direction,
                req,
                answer,
            } => self.paginated(session, generation, subscription, direction, req, answer),
        };
        cmd.then(self.missing_reply_details())
    }

    fn act(&mut self, action: TimelineAction, req: Option<ReqId>) -> Cmd<Input> {
        match action {
            TimelineAction::Configure {
                filters,
                reply_style,
                read_only,
                utc_offset_minutes,
                thread_root,
            } => {
                self.config = Config {
                    filters,
                    reply_style,
                    read_only,
                    utc_offset_ms: i64::from(utc_offset_minutes) * 60_000,
                    thread_root,
                };
                self.stale = true;
                Cmd::none()
            }
            TimelineAction::Open {
                target,
                hidden_events,
                unread,
                has_unread,
                landing,
            } => self.open(
                OpenRequest {
                    mode: target,
                    hidden_events,
                    unread,
                    has_unread: Some(has_unread),
                    landing,
                    force: false,
                },
                req,
            ),
            TimelineAction::ResumeLive => self.resume_live(req),
            TimelineAction::Stop => {
                let stopped = self.stop_current(false);
                self.reset_context();
                self.viewing = None;
                let deferred = self.drop_deferred();
                stopped.then(deferred).then(Cmd::reply(req, Ok(())))
            }
            TimelineAction::Release => {
                self.reset_context();
                self.viewing = None;
                Cmd::none()
            }
            TimelineAction::InitializeUnread { has_unread } => {
                self.initialize_unread(req, has_unread)
            }
            TimelineAction::ObserveUnread { first_visible } => {
                self.unread.observe(first_visible.as_deref());
                self.stale = true;
                Cmd::none()
            }
            TimelineAction::Viewing { focused, newest } => {
                let viewing = Viewing { focused, newest };
                self.stale |= self.viewing.as_ref() != Some(&viewing);
                self.viewing = Some(viewing);
                Cmd::none()
            }
            TimelineAction::Read { event_id } => {
                self.refresh();
                let latest = self.status().latest_event_id.clone();
                self.unread.read(&event_id, latest.as_deref());
                self.stale = true;
                Cmd::none()
            }
            TimelineAction::RoomUnread {
                has_unread,
                keep_boundary,
            } => {
                let had_unread = std::mem::replace(&mut self.has_unread, has_unread);
                if had_unread && !has_unread && !keep_boundary && self.unread.initialized() {
                    self.unread.dismiss();
                    self.stale = true;
                }
                Cmd::none()
            }
            TimelineAction::ClearUnread => {
                self.unread.clear();
                self.stale = true;
                Cmd::none()
            }
            TimelineAction::Paginate { direction, count } => self.paginate(direction, count, req),
        }
    }

    fn drop_deferred(&mut self) -> Cmd<Input> {
        match self.deferred.take() {
            Some((_, req)) => Cmd::reply(req, Ok(())),
            None => Cmd::none(),
        }
    }

    fn resume_live(&mut self, req: Option<ReqId>) -> Cmd<Input> {
        let can_resume = matches!(self.status().mode, TimelineModeView::Unread { .. })
            || self.status().resuming_live;
        if !can_resume {
            return Cmd::reply(req, Ok(()));
        }
        if let Some(resume) = &mut self.resume {
            resume.joiners.extend(req);
            return Cmd::none();
        }
        let Some(target) = self.target.clone() else {
            return Cmd::reply(req, Ok(()));
        };
        let cmd = self.open(
            OpenRequest {
                mode: TimelineModeView::Live,
                hidden_events: target.hidden_events,
                unread: false,
                has_unread: None,
                landing: None,
                force: true,
            },
            None,
        );
        self.edit_status(|status| status.resuming_live = true);
        self.resume = Some(Resume {
            req,
            joiners: Vec::new(),
        });
        cmd
    }

    fn open(&mut self, request: OpenRequest, req: Option<ReqId>) -> Cmd<Input> {
        let same_target = self.plan.as_ref().is_some_and(|plan| {
            plan.mode.same_as(&request.mode)
                && plan.hidden_events == request.hidden_events
                && plan.unread == request.unread
                && plan.has_unread == request.has_unread
                && plan.landing == request.landing
        });
        if !request.force && same_target {
            if self.subscription.is_some() {
                return Cmd::reply(req, Ok(()));
            }
            if self.phase == Phase::Starting {
                self.waiters.extend(req);
                return Cmd::none();
            }
        }

        let dropped = self.drop_deferred();
        let stopped = if self.target.is_some() || self.status().resuming_live {
            self.stop_current(request.force)
        } else {
            Cmd::none()
        };
        if self.unsubscribing > 0 {
            self.deferred = Some((request, req));
            return dropped.then(stopped);
        }
        dropped.then(stopped).then(self.proceed(request, req))
    }

    fn proceed(&mut self, request: OpenRequest, req: Option<ReqId>) -> Cmd<Input> {
        self.requested_details.clear();
        let thread_root = match &request.mode {
            TimelineModeView::Thread { root_event_id } => Some(root_event_id.clone()),
            _ => self.config.thread_root.clone(),
        };
        let context = Context { thread_root };
        if self.context.as_ref() != Some(&context) {
            self.reset_context();
            self.context = Some(context);
        }
        if let Some(has_unread) = request.has_unread {
            self.has_unread = has_unread;
        }
        self.target = Some(Target {
            mode: request.mode.clone(),
            hidden_events: request.hidden_events,
        });
        let thread = matches!(request.mode, TimelineModeView::Thread { .. });
        let marker = match &request.mode {
            TimelineModeView::Unread { event_id } => Some(event_id.clone()),
            _ => None,
        };
        let mode = request.mode.clone();
        if marker.is_some() {
            self.read_marker = marker;
        }
        self.edit_status(|status| {
            status.mode = mode;
            status.forward_pagination = if thread {
                PaginationStateView::End
            } else {
                PaginationStateView::Idle
            };
            status.loading = true;
            status.error = None;
        });
        self.stale = true;
        self.phase = Phase::Starting;
        self.waiters.extend(req);
        let cmd = match &request.mode {
            TimelineModeView::Unread { .. } => {
                self.subscribe(&request.mode, request.hidden_events, true)
            }
            mode => self.subscribe(mode, request.hidden_events, false),
        };
        self.plan = Some(request);
        cmd
    }

    fn subscribe(
        &mut self,
        mode: &TimelineModeView,
        hidden_events: bool,
        fallback: bool,
    ) -> Cmd<Input> {
        let session = self.session;
        let (sent, done) = oneshot::channel();
        self.starting.push(Starting { session, done });
        let request = Subscribe::new(self.key.clone(), mode, hidden_events);
        Cmd::task(move |ports| async move {
            let answer = ports.backend.run(request).await;
            let _ = sent.send(answer.as_ref().ok().map(|response| response.subscription));
            Some(Input::Subscribed {
                session,
                fallback,
                answer,
            })
        })
    }

    fn hidden_events(&self) -> bool {
        self.target
            .as_ref()
            .is_some_and(|target| target.hidden_events)
    }

    fn subscribed(
        &mut self,
        session: u64,
        fallback: bool,
        answer: Result<SubscribeOk, RpcError>,
    ) -> Cmd<Input> {
        self.starting.retain(|start| start.session != session);
        if session != self.session {
            return match answer {
                Ok(response) => release(response.subscription),
                Err(_) => Cmd::none(),
            };
        }
        let response = match answer {
            Ok(response) => response,
            Err(error) => {
                tracing::debug!(?error, "a timeline did not open");
                return if fallback {
                    self.pending_diffs.clear();
                    let hidden = self.hidden_events();
                    self.edit_status(|status| status.mode = TimelineModeView::Live);
                    self.subscribe(&TimelineModeView::Live, hidden, false)
                } else {
                    self.fail_start()
                };
            }
        };
        let mode = self.status().mode.clone();
        let Some(plan) = self.plan.clone() else {
            return release(response.subscription);
        };

        let mut jump = None;
        if mode == TimelineModeView::Live {
            if let Some(landing) = &plan.landing {
                jump = (!holds(&response, landing)).then(|| landing.clone());
            } else if plan.unread
                && !response
                    .items
                    .iter()
                    .any(|item| matches!(item.content, TimelineItemContentView::ReadMarker))
            {
                self.held = Some(Held { mode, response });
                return Cmd::rpc(
                    ReadMarker {
                        room_id: self.key.room_id.clone(),
                    },
                    move |answer| Input::MarkerLoaded { session, answer },
                );
            }
        }
        match jump {
            Some(event_id) => self.jump(session, event_id, &response),
            None => self.finish_start(mode, response, None, false),
        }
    }

    fn marker_loaded(
        &mut self,
        session: u64,
        answer: Result<Option<String>, RpcError>,
    ) -> Cmd<Input> {
        if session != self.session {
            return Cmd::none();
        }
        let Some(Held { mode, response }) = self.held.take() else {
            return Cmd::none();
        };
        let marker = answer.unwrap_or_else(|error| {
            tracing::debug!(?error, "the read marker was not loaded");
            None
        });
        match marker.clone().filter(|marker| !holds(&response, marker)) {
            Some(event_id) => self.jump(session, event_id, &response),
            None => self.finish_start(mode, response, marker, true),
        }
    }

    /// Leaves the subscription that does not hold `event_id` for the context around it.
    fn jump(&mut self, session: u64, event_id: String, response: &SubscribeOk) -> Cmd<Input> {
        self.read_marker = Some(event_id.clone());
        Cmd::rpc(
            Unsubscribe {
                subscription: response.subscription,
            },
            move |answer| Input::Released {
                session,
                event_id,
                failed: answer.is_err(),
            },
        )
    }

    fn released(&mut self, session: u64, event_id: String, failed: bool) -> Cmd<Input> {
        if session != self.session {
            return Cmd::none();
        }
        if failed {
            return self.fail_start();
        }
        self.pending_diffs.clear();
        let hidden = self.hidden_events();
        self.edit_status(|status| {
            status.mode = TimelineModeView::Unread {
                event_id: event_id.clone(),
            };
        });
        self.subscribe(&TimelineModeView::Unread { event_id }, hidden, false)
    }

    fn fail_start(&mut self) -> Cmd<Input> {
        self.phase = Phase::Stopped;
        self.pending_diffs.clear();
        let force = self.plan.as_ref().is_some_and(|plan| plan.force);
        if force {
            self.set_items(&[]);
            self.set_aggregations(&[]);
        }
        self.edit_status(|status| {
            status.error = Some(LOAD_FAILED.to_owned());
            status.loading = false;
            if force {
                status.has_snapshot = false;
            }
        });
        self.finish_requests(false)
    }

    /// Answers the opens that waited for this start, and the resume that asked for it.
    fn finish_requests(&mut self, ok: bool) -> Cmd<Input> {
        let waiters = std::mem::take(&mut self.waiters);
        let mut cmds = vec![Self::reply_all(waiters)];
        if let Some(resume) = self.resume.take() {
            self.edit_status(|status| status.resuming_live = false);
            let reqs = resume.req.into_iter().chain(resume.joiners);
            cmds.extend(reqs.map(|req| {
                if ok {
                    Cmd::reply(Some(req), Ok(()))
                } else {
                    Cmd::reply::<()>(
                        Some(req),
                        Err(RpcError::Failed {
                            log_id: "timeline.resume_live".to_owned(),
                        }),
                    )
                }
            }));
        }
        Cmd::batch(cmds)
    }

    fn finish_start(
        &mut self,
        mode: TimelineModeView,
        response: SubscribeOk,
        read_marker: Option<String>,
        update_read_marker: bool,
    ) -> Cmd<Input> {
        let SubscribeOk {
            subscription,
            items,
            aggregations,
        } = response;
        self.subscription = Some(subscription);
        let mut list: Vec<Shared> = items.into_iter().map(Shared::new).collect();
        for (from, diffs) in std::mem::take(&mut self.pending_diffs) {
            if from != subscription {
                continue;
            }
            for diff in diffs {
                if sable_runtime::apply_diffs(&mut list, &[map_diff(diff)]).is_err() {
                    tracing::warn!("a timeline diff did not apply to the snapshot");
                }
            }
        }
        self.set_items(&list);
        self.set_aggregations(
            &aggregations
                .into_iter()
                .map(Shared::new)
                .collect::<Vec<_>>(),
        );
        self.phase = Phase::Active;
        if update_read_marker {
            self.read_marker = read_marker;
        }
        self.edit_status(|status| {
            status.mode = mode;
            status.has_snapshot = true;
            status.subscription = Some(subscription);
            status.loading = false;
        });
        let initialized = self.initialize_unread_cmd(None, self.has_unread);
        initialized.then(self.finish_requests(true))
    }

    /// Releases the core's subscription and empties the timeline unless `keep_content`.
    fn stop_current(&mut self, keep_content: bool) -> Cmd<Input> {
        self.session += 1;
        self.phase = Phase::Stopped;
        let held = self.held.take().map(|held| held.response.subscription);
        self.plan = None;
        self.unread.interrupt_load();
        let waiters = std::mem::take(&mut self.waiters);
        let mut cmds = vec![
            Self::reply_all(waiters),
            Self::reply_all(std::mem::take(&mut self.unread_waiters)),
        ];
        if let Some(resume) = self.resume.take() {
            let reqs = resume.req.into_iter().chain(resume.joiners);
            cmds.extend(reqs.map(|req| {
                Cmd::reply::<()>(
                    Some(req),
                    Err(RpcError::Failed {
                        log_id: "timeline.resume_live".to_owned(),
                    }),
                )
            }));
        }
        let has_snapshot = keep_content && self.status().has_snapshot;
        self.read_marker = None;
        self.edit_status(|status| {
            status.mode = TimelineModeView::Live;
            status.loading = false;
            status.resuming_live = false;
            status.has_snapshot = has_snapshot;
            status.forward_pagination = PaginationStateView::Idle;
            status.backward_pagination = PaginationStateView::Idle;
            status.error = None;
            status.subscription = None;
        });
        if !keep_content {
            self.set_items(&[]);
            self.set_aggregations(&[]);
        }
        self.pending_diffs.clear();
        self.target = None;
        self.stale = true;
        if let Some(subscription) = self.subscription.take() {
            self.unsubscribing += 1;
            cmds.push(Cmd::rpc(Unsubscribe { subscription }, |answer| {
                if let Err(error) = answer {
                    tracing::warn!(?error, "a timeline was not unsubscribed");
                }
                Input::Unsubscribed
            }));
        }
        if let Some(subscription) = held {
            self.unsubscribing += 1;
            cmds.push(Cmd::rpc(Unsubscribe { subscription }, |answer| {
                if let Err(error) = answer {
                    tracing::warn!(?error, "a held timeline was not unsubscribed");
                }
                Input::Unsubscribed
            }));
        }
        Cmd::batch(cmds)
    }

    fn reset_context(&mut self) {
        self.session += 1;
        self.context = None;
        self.unread = Unread::default();
        self.has_unread = false;
        self.stale = true;
    }

    fn initialize_unread(&mut self, req: Option<ReqId>, has_unread: bool) -> Cmd<Input> {
        self.has_unread = has_unread;
        self.initialize_unread_cmd(req, has_unread)
    }

    /// Starts the tracker, and answers `req` once the read marker it needs is known.
    fn initialize_unread_cmd(&mut self, req: Option<ReqId>, has_unread: bool) -> Cmd<Input> {
        self.refresh();
        let read_marker = self.read_marker.as_deref();
        let step = self.unread.initialize(
            self.doc.events.items(),
            has_unread,
            &self.event_items,
            read_marker,
        );
        self.stale = true;
        if step {
            self.unread_waiters.extend(req);
            let session = self.session;
            return Cmd::rpc(
                ReadMarker {
                    room_id: self.key.room_id.clone(),
                },
                move |answer| Input::UnreadMarker { session, answer },
            );
        }
        if self.unread.loading_marker() {
            self.unread_waiters.extend(req);
            return Cmd::none();
        }
        Cmd::reply(req, Ok(()))
    }

    fn unread_marker(
        &mut self,
        session: u64,
        answer: Result<Option<String>, RpcError>,
    ) -> Cmd<Input> {
        if session != self.session {
            return Cmd::none();
        }
        self.unread.loaded(answer.map_err(|error| {
            tracing::debug!(?error, "the read marker was not loaded");
        }));
        self.stale = true;
        Self::reply_all(std::mem::take(&mut self.unread_waiters))
    }

    fn unsubscribed(&mut self) -> Cmd<Input> {
        self.unsubscribing = self.unsubscribing.saturating_sub(1);
        if self.unsubscribing > 0 {
            return Cmd::none();
        }
        match self.deferred.take() {
            Some((request, req)) => self.proceed(request, req),
            None => Cmd::none(),
        }
    }

    fn set_items(&mut self, list: &[Shared]) {
        let edits = list_diff(self.doc.events.items(), list);
        if edits.is_empty() {
            return;
        }
        for edit in edits {
            if self.doc.events.apply(edit).is_err() {
                tracing::warn!("a timeline edit did not apply");
            }
        }
        self.items_changed();
    }

    fn set_aggregations(&mut self, list: &[Shared]) {
        for edit in list_diff(self.doc.aggregations.items(), list) {
            if self.doc.aggregations.apply(edit).is_err() {
                tracing::warn!("an aggregation edit did not apply");
            }
        }
        self.stale = true;
    }

    const fn items_changed(&mut self) {
        self.items_version += 1;
        self.stale = true;
    }

    fn diff_event(
        &mut self,
        subscription: SubscriptionId,
        diffs: Vec<VectorDiff<TimelineItemView>>,
    ) {
        if self.phase == Phase::Starting {
            if self.pending_diffs.len() >= PENDING_DIFF_CAP {
                tracing::warn!(
                    "too many timeline diffs arrived while starting; dropping the excess"
                );
                return;
            }
            self.pending_diffs.push((subscription, diffs));
            return;
        }
        let before = self.doc.events.items().len();
        let reset = diffs
            .iter()
            .any(|diff| matches!(diff, VectorDiff::Clear | VectorDiff::Reset { .. }));
        for diff in diffs {
            if self.doc.events.apply(map_diff(diff)).is_err() {
                tracing::warn!("a timeline diff did not apply");
            }
        }
        self.items_changed();
        if reset {
            let oldest = self
                .doc
                .events
                .items()
                .iter()
                .find(|item| item.event_id.is_some())
                .map_or(u64::MAX, |item| item.timestamp);
            let kept: Vec<Shared> = self
                .doc
                .aggregations
                .items()
                .iter()
                .filter(|item| item.timestamp >= oldest)
                .cloned()
                .collect();
            self.set_aggregations(&kept);
        }
        if before > 0 && self.doc.events.items().is_empty() {
            self.pagination_generation += 1;
            self.edit_status(|status| {
                status.backward_pagination = PaginationStateView::Idle;
                if status.forward_pagination == PaginationStateView::Loading {
                    status.forward_pagination = PaginationStateView::Idle;
                }
            });
        }
    }

    fn upsert_aggregations(&mut self, items: Vec<TimelineItemView>) {
        for item in items {
            let shared = Shared::new(item);
            let at = self
                .doc
                .aggregations
                .items()
                .iter()
                .position(|known| known.id == shared.id);
            let edit = match at {
                Some(index) => VectorDiff::Set {
                    index,
                    value: shared,
                },
                None => VectorDiff::PushBack { value: shared },
            };
            if self.doc.aggregations.apply(edit).is_err() {
                tracing::warn!("an aggregation did not apply");
            }
            self.stale = true;
        }
    }

    fn paginate(
        &mut self,
        direction: TimelineDirectionView,
        count: u16,
        req: Option<ReqId>,
    ) -> Cmd<Input> {
        let status = self.status();
        let gated = match direction {
            TimelineDirectionView::Backward => {
                status.backward_pagination != PaginationStateView::Idle
            }
            TimelineDirectionView::Forward => {
                matches!(
                    status.mode,
                    TimelineModeView::Live | TimelineModeView::Thread { .. }
                ) || status.forward_pagination != PaginationStateView::Idle
            }
        };
        let Some(subscription) = self.subscription.filter(|_| !gated) else {
            let reached_end = match direction {
                TimelineDirectionView::Backward => {
                    status.backward_pagination == PaginationStateView::End
                }
                TimelineDirectionView::Forward => true,
            };
            return Cmd::reply(req, Ok(TimelinePaginated { reached_end }));
        };
        self.edit_status(|status| match direction {
            TimelineDirectionView::Backward => {
                status.backward_pagination = PaginationStateView::Loading;
            }
            TimelineDirectionView::Forward => {
                status.forward_pagination = PaginationStateView::Loading;
            }
        });
        let (session, generation) = (self.session, self.pagination_generation);
        Cmd::rpc(
            Paginate {
                subscription,
                direction,
                count,
            },
            move |answer| Input::Paginated {
                session,
                generation,
                subscription,
                direction,
                req,
                answer,
            },
        )
    }

    fn paginated(
        &mut self,
        session: u64,
        generation: u64,
        subscription: SubscriptionId,
        direction: TimelineDirectionView,
        req: Option<ReqId>,
        answer: Result<PaginateOk, RpcError>,
    ) -> Cmd<Input> {
        let current = session == self.session
            && self.subscription == Some(subscription)
            && generation == self.pagination_generation;
        if current {
            let state = match &answer {
                Ok(PaginateOk { reached_end: true }) => PaginationStateView::End,
                _ => PaginationStateView::Idle,
            };
            let failed = answer.is_err();
            self.edit_status(|status| {
                status.error = failed.then(|| LOAD_FAILED.to_owned());
                match direction {
                    TimelineDirectionView::Backward => status.backward_pagination = state,
                    TimelineDirectionView::Forward => status.forward_pagination = state,
                }
            });
        }
        Cmd::reply(
            req,
            answer.map(|ok| TimelinePaginated {
                reached_end: ok.reached_end,
            }),
        )
    }

    fn missing_reply_details(&mut self) -> Cmd<Input> {
        if self.phase != Phase::Active || self.details_version == self.items_version {
            return Cmd::none();
        }
        self.details_version = self.items_version;
        let thread_root = match self.status().mode {
            TimelineModeView::Thread { ref root_event_id } => Some(root_event_id.clone()),
            _ => None,
        };
        let wanted: Vec<String> = self
            .doc
            .events
            .items()
            .iter()
            .filter_map(|item| {
                let reply = item.in_reply_to.as_ref()?;
                if reply.body.is_some() || reply.fallback.is_some() {
                    return None;
                }
                Some(item.event_id.as_ref()?.to_string())
            })
            .filter(|event_id| self.requested_details.insert(event_id.clone()))
            .collect();
        Cmd::batch(wanted.into_iter().map(|event_id| {
            let params = FetchEventDetails {
                room_id: self.key.room_id.clone(),
                event_id,
                thread_root: thread_root.clone(),
            };
            Cmd::task(move |ports| async move {
                if let Err(error) = ports.backend.run(params).await {
                    tracing::debug!(?error, "reply details are unavailable");
                }
                None
            })
        }))
    }

    /// Brings the rows and what derives from the items up to date.
    pub(super) fn refresh(&mut self) {
        if !self.stale {
            return;
        }
        self.stale = false;
        self.build_rows();
        let attended = self.attend();
        let before = self.unread.first_event_id().map(ToOwned::to_owned);
        let status = self.doc.status.view();
        let oldest_loaded = status.backward_pagination == PaginationStateView::End
            && (status.mode == TimelineModeView::Live
                || status.forward_pagination == PaginationStateView::End);
        self.unread
            .resolve(self.doc.events.items(), oldest_loaded, &self.event_items);
        // Resolving the boundary changes marker placement, not which events are visible.
        if attended || before.as_deref() != self.unread.first_event_id() {
            self.build_rows();
        }
        let latest = rows::latest_event_id(self.doc.events.items());
        let item_count = self.doc.events.items().len();
        let unread = self.unread.view(&self.event_items);
        let status = self.doc.status.view();
        let resuming = status.resuming_live;
        let can_resume_live = matches!(status.mode, TimelineModeView::Unread { .. }) || resuming;
        let reaches_latest = !resuming
            && (status.mode == TimelineModeView::Live
                || status.forward_pagination == PaginationStateView::End);
        if status.latest_event_id != latest
            || status.can_resume_live != can_resume_live
            || status.reaches_latest != reaches_latest
            || status.unread != unread
            || status.item_count != item_count
        {
            self.edit_status(|status| {
                status.latest_event_id = latest;
                status.can_resume_live = can_resume_live;
                status.reaches_latest = reaches_latest;
                status.unread = unread;
                status.item_count = item_count;
            });
        }
        self.stale = false;
    }

    /// Whether what the window shows changed the unread tracker.
    fn attend(&mut self) -> bool {
        let Some(viewing) = &self.viewing else {
            return false;
        };
        let status = self.doc.status.view();
        if status.mode != TimelineModeView::Live || !status.has_snapshot {
            return false;
        }
        let latest = rows::latest_event_id(self.doc.events.items());
        let before = self.unread.view(&self.event_items);
        self.unread
            .attend(viewing, latest.as_deref(), &self.event_items);
        self.unread.view(&self.event_items) != before
    }

    fn build_rows(&mut self) {
        let status = self.doc.status.view();
        let input = RowsInput {
            items: self.doc.events.items(),
            aggregations: self.doc.aggregations.items(),
            filters: &self.config.filters,
            reply_style: self.config.reply_style,
            read_only: self.config.read_only,
            start_loaded: status.backward_pagination == PaginationStateView::End,
            end_loaded: status.mode == TimelineModeView::Live
                || status.forward_pagination == PaginationStateView::End,
            unread_event_id: self.unread.first_event_id(),
            hide_read_marker: !self.unread.active(),
            thread_root: self.config.thread_root.as_deref(),
            utc_offset_ms: self.config.utc_offset_ms,
        };
        let Rows { event_items, rows } = rows::build(&input, &mut self.identity);
        for edit in list_diff(self.doc.rows.items(), &rows) {
            if self.doc.rows.apply(edit).is_err() {
                tracing::warn!("a row edit did not apply");
            }
        }
        self.event_items = event_items;
    }

    /// Whether `subscription` is the core's stream for what this timeline shows.
    pub(super) fn follows(&self, subscription: SubscriptionId) -> bool {
        self.phase == Phase::Active && self.subscription == Some(subscription)
    }

    /// Diffs are also kept while the answer that names the subscription is awaited.
    pub(super) fn listening(
        &self,
        key: Option<&TimelineKey>,
        subscription: SubscriptionId,
    ) -> bool {
        self.follows(subscription) || (self.phase == Phase::Starting && key == Some(&self.key))
    }

    pub(super) fn dispose(&mut self) -> Cmd<Input> {
        let mut subscriptions = [
            self.subscription.take(),
            self.held.take().map(|held| held.response.subscription),
        ]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>();
        let starts = std::mem::take(&mut self.starting);
        Cmd::task(move |ports| async move {
            for start in starts {
                if let Ok(Some(subscription)) = start.done.await
                    && !subscriptions.contains(&subscription)
                {
                    subscriptions.push(subscription);
                }
            }
            for subscription in subscriptions {
                if let Err(error) = ports.backend.run(Unsubscribe { subscription }).await {
                    tracing::debug!(?error, "a timeline subscription was not ended");
                }
            }
            None
        })
    }
}

fn release(subscription: SubscriptionId) -> Cmd<Input> {
    Cmd::task(move |ports| async move {
        if let Err(error) = ports.backend.run(Unsubscribe { subscription }).await {
            tracing::debug!(?error, "a stale timeline was not unsubscribed");
        }
        None
    })
}

fn holds(response: &SubscribeOk, event_id: &str) -> bool {
    response.items.iter().any(|item| {
        item.event_id
            .as_ref()
            .is_some_and(|candidate| candidate.as_str() == event_id)
    })
}

fn map_diff(diff: VectorDiff<TimelineItemView>) -> VectorDiff<Shared> {
    match diff {
        VectorDiff::Append { values } => VectorDiff::Append {
            values: values.into_iter().map(Shared::new).collect(),
        },
        VectorDiff::Clear => VectorDiff::Clear,
        VectorDiff::PushFront { value } => VectorDiff::PushFront {
            value: Shared::new(value),
        },
        VectorDiff::PushBack { value } => VectorDiff::PushBack {
            value: Shared::new(value),
        },
        VectorDiff::PopFront => VectorDiff::PopFront,
        VectorDiff::PopBack => VectorDiff::PopBack,
        VectorDiff::Insert { index, value } => VectorDiff::Insert {
            index,
            value: Shared::new(value),
        },
        VectorDiff::Set { index, value } => VectorDiff::Set {
            index,
            value: Shared::new(value),
        },
        VectorDiff::Remove { index } => VectorDiff::Remove { index },
        VectorDiff::Truncate { length } => VectorDiff::Truncate { length },
        VectorDiff::Reset { values } => VectorDiff::Reset {
            values: values.into_iter().map(Shared::new).collect(),
        },
    }
}
