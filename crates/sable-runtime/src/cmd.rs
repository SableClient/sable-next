use std::{future::Future, marker::PhantomData, time::Duration};

use sable_protocol::RpcError;
use serde::Serialize;
use serde_json::Value;

use crate::{
    ports::{Ports, Rpc},
    rt::{BoxAny, BoxFuture, BoxOnce, SendOutsideWasm},
    wire::{Outcome, ReplyError, ReqId},
};

pub type Name = &'static str;

pub(crate) enum Effect {
    Task(BoxOnce<Ports, BoxFuture<Option<BoxAny>>>),
    After(Name, Duration, BoxAny),
    Notice(Value),
    Reply(ReqId, Outcome),
}

#[must_use = "a Cmd does nothing until the reducer returns it"]
pub struct Cmd<I>(Vec<Effect>, PhantomData<fn() -> I>);

impl<I: SendOutsideWasm + 'static> Cmd<I> {
    const fn of(effects: Vec<Effect>) -> Self {
        Self(effects, PhantomData)
    }

    pub(crate) fn into_effects(self) -> Vec<Effect> {
        self.0
    }

    pub const fn none() -> Self {
        Self::of(Vec::new())
    }

    pub fn batch(cmds: impl IntoIterator<Item = Self>) -> Self {
        Self::of(cmds.into_iter().flat_map(|cmd| cmd.0).collect())
    }

    pub fn then(mut self, next: Self) -> Self {
        self.0.extend(next.0);
        self
    }

    pub fn task<F, Fut>(work: F) -> Self
    where
        F: FnOnce(Ports) -> Fut + SendOutsideWasm + 'static,
        Fut: Future<Output = Option<I>> + SendOutsideWasm + 'static,
    {
        Self::of(vec![Effect::Task(Box::new(move |ports| {
            Box::pin(async move { work(ports).await.map(|input| Box::new(input) as BoxAny) })
        }))])
    }

    pub fn rpc<P>(
        params: P,
        done: impl FnOnce(Result<P::Ok, RpcError>) -> I + SendOutsideWasm + 'static,
    ) -> Self
    where
        P: Rpc + SendOutsideWasm + 'static,
    {
        Self::of(vec![Effect::Task(Box::new(move |ports| {
            Box::pin(async move { Some(Box::new(done(ports.backend.run(params).await)) as BoxAny) })
        }))])
    }

    /// Does nothing if a timer called `name` is already pending.
    pub fn after(name: Name, delay: Duration, input: I) -> Self {
        Self::of(vec![Effect::After(name, delay, Box::new(input))])
    }

    pub fn notice<T: Serialize>(notice: &T) -> Self {
        match serde_json::to_value(notice) {
            Ok(notice) => Self::of(vec![Effect::Notice(notice)]),
            Err(error) => {
                tracing::error!(%error, "a notice does not serialize");
                Self::none()
            }
        }
    }

    pub fn reply<T: Serialize>(req: Option<ReqId>, result: Result<T, RpcError>) -> Self {
        let Some(req) = req else {
            return Self::none();
        };
        Self::of(vec![Effect::Reply(req, outcome(result))])
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
