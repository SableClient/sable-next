//! A `Cmd` is data, built while the state is borrowed and run afterwards, so reducers stay synchronous.

use std::{future::Future, time::Duration};

use futures_util::Stream;
use sable_protocol::RpcError;
use serde::Serialize;

use crate::{
    ports::{Ports, Rpc},
    rt::{BoxFuture, BoxOnce, BoxStream, SendOutsideWasm},
    wire::{Outcome, ReplyError, ReqId},
};

pub type Name = &'static str;

pub(crate) enum Effect<I> {
    Task(BoxOnce<Ports, BoxFuture<'static, Option<I>>>),
    Input(I),
    After(Name, Duration, I),
    Debounce(Name, Duration, I),
    Cancel(Name),
    Stream(Name, BoxOnce<Ports, BoxStream<'static, I>>),
    EndStream(Name),
    Notice { stage: String, text: String },
    Reply(ReqId, Outcome),
}

#[must_use = "a Cmd does nothing until the reducer returns it"]
pub struct Cmd<I>(pub(crate) Vec<Effect<I>>);

impl<I: SendOutsideWasm + 'static> Cmd<I> {
    pub const fn none() -> Self {
        Self(Vec::new())
    }

    pub fn batch(cmds: impl IntoIterator<Item = Self>) -> Self {
        Self(cmds.into_iter().flat_map(|cmd| cmd.0).collect())
    }

    /// For commands whose order matters, such as `cancel` before `after`.
    pub fn then(mut self, next: Self) -> Self {
        self.0.extend(next.0);
        self
    }

    pub fn input(input: I) -> Self {
        Self(vec![Effect::Input(input)])
    }

    pub fn task<F, Fut>(work: F) -> Self
    where
        F: FnOnce(Ports) -> Fut + SendOutsideWasm + 'static,
        Fut: Future<Output = Option<I>> + SendOutsideWasm + 'static,
    {
        Self(vec![Effect::Task(Box::new(move |ports| {
            Box::pin(work(ports))
        }))])
    }

    pub fn rpc<P>(
        params: P,
        done: impl FnOnce(Result<P::Ok, RpcError>) -> I + SendOutsideWasm + 'static,
    ) -> Self
    where
        P: Rpc + SendOutsideWasm + 'static,
    {
        Self::task(move |ports| async move { Some(done(ports.backend.run(params).await)) })
    }

    /// Does nothing if a timer called `name` is already pending.
    pub fn after(name: Name, delay: Duration, input: I) -> Self {
        Self(vec![Effect::After(name, delay, input)])
    }

    /// Replaces a pending timer called `name`.
    pub fn debounce(name: Name, delay: Duration, input: I) -> Self {
        Self(vec![Effect::Debounce(name, delay, input)])
    }

    /// The input is never reduced, even if it was already on its way.
    pub fn cancel(name: Name) -> Self {
        Self(vec![Effect::Cancel(name)])
    }

    /// Ends when the stream ends, another stream called `name` replaces it, or the instance stops.
    pub fn stream<F, S>(name: Name, open: F) -> Self
    where
        F: FnOnce(Ports) -> S + SendOutsideWasm + 'static,
        S: Stream<Item = I> + SendOutsideWasm + 'static,
    {
        Self(vec![Effect::Stream(
            name,
            Box::new(move |ports| Box::pin(open(ports))),
        )])
    }

    pub fn end_stream(name: Name) -> Self {
        Self(vec![Effect::EndStream(name)])
    }

    pub fn notice(stage: impl Into<String>, text: impl Into<String>) -> Self {
        Self(vec![Effect::Notice {
            stage: stage.into(),
            text: text.into(),
        }])
    }

    /// A request answered twice, or after it was lost, is not answered again.
    pub fn reply<T: Serialize>(req: Option<ReqId>, result: Result<T, RpcError>) -> Self {
        let Some(req) = req else {
            return Self::none();
        };
        Self(vec![Effect::Reply(req, outcome(result))])
    }
}

fn outcome<T: Serialize>(result: Result<T, RpcError>) -> Outcome {
    let error = match result.map(|ok| serde_json::to_value(ok)) {
        Ok(Ok(value)) => return Outcome::Ok { value },
        Ok(Err(error)) => {
            tracing::error!(%error, "a reply does not serialize");
            RpcError::Failed {
                log_id: "reply".to_owned(),
            }
        }
        Err(error) => error,
    };
    match serde_json::to_value(error) {
        Ok(error) => Outcome::Error {
            error: ReplyError::Rpc { error },
        },
        Err(error) => {
            tracing::error!(%error, "an rpc error does not serialize");
            Outcome::Error {
                error: ReplyError::Encode,
            }
        }
    }
}
