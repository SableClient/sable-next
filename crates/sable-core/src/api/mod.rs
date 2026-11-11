//! The RPC surface: one `Handler` per method, grouped by domain. A wire call
//! is `"<domain>.<method>"` with JSON params; Rust callers use `Core::run`.

use std::future::Future;
use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::value::RawValue;
use web_time::Instant;

use crate::Core;
use crate::protocol::{RpcCode, RpcError};

/// Registers a domain's methods by wire name; `user_profile` is handled by `UserProfileParams`.
macro_rules! domain {
    ($($method:ident),* $(,)?) => {
        pastey::paste! {
            pub(super) async fn call(
                core: &std::sync::Arc<crate::Core>,
                method: &str,
                params: &str,
            ) -> Option<Result<Box<serde_json::value::RawValue>, crate::protocol::RpcError>> {
                Some(match method {
                    $(stringify!($method) => {
                        Box::pin(super::invoke::<[<$method:camel Params>]>(core, params)).await
                    })*
                    _ => return None,
                })
            }

            #[cfg(feature = "typegen")]
            pub(super) fn routes(types: &mut specta::Types) -> Vec<super::Route> {
                vec![$(super::Route::new::<[<$method:camel Params>]>(stringify!($method), types)),*]
            }
        }
    };
}

macro_rules! domains {
    ($($domain:ident),* $(,)?) => {
        $(pub mod $domain;)*

        async fn route(
            core: &Arc<Core>,
            domain: &str,
            method: &str,
            params: &str,
        ) -> Option<Result<Box<RawValue>, RpcError>> {
            match domain {
                $(stringify!($domain) => $domain::call(core, method, params).await,)*
                _ => None,
            }
        }

        /// Every method by domain, for the TypeScript router.
        #[cfg(feature = "typegen")]
        pub fn routes(types: &mut specta::Types) -> Vec<(&'static str, Vec<Route>)> {
            vec![$((stringify!($domain), $domain::routes(types))),*]
        }
    };
}

domains! {
    account,
    auth,
    calendar,
    calls,
    encryption,
    members,
    messages,
    notifications,
    packs,
    personas,
    push,
    room_state,
    rooms,
    rtc,
    search,
    session,
    spaces,
    timeline,
    widgets,
}

/// Raw JSON relayed as is; `unknown` in TypeScript.
#[derive(Debug, Serialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
#[serde(transparent)]
pub struct Json(
    #[cfg_attr(feature = "typegen", specta(type = specta_typescript::Unknown))]
    pub  serde_json::Value,
);

/// One RPC method: its params are `Self`, its result `Self::Ok`.
pub trait Handler: DeserializeOwned {
    type Ok: Serialize;

    fn run(self, core: &Arc<Core>) -> impl Future<Output = Result<Self::Ok, RpcError>>;
}

#[cfg(feature = "typegen")]
pub struct Route {
    pub method: &'static str,
    pub params: specta::datatype::DataType,
    pub ok: specta::datatype::DataType,
}

#[cfg(feature = "typegen")]
impl Route {
    fn new<H>(method: &'static str, types: &mut specta::Types) -> Self
    where
        H: Handler + specta::Type,
        H::Ok: specta::Type,
    {
        Self {
            method,
            params: <H as specta::Type>::definition(types),
            ok: <H::Ok as specta::Type>::definition(types),
        }
    }
}

const SLOW_CALL: Duration = Duration::from_secs(2);

async fn invoke<H: Handler>(core: &Arc<Core>, params: &str) -> Result<Box<RawValue>, RpcError> {
    let handler: H = serde_json::from_str(params)
        .map_err(|error| core.failed_with(std::any::type_name::<H>(), &error))?;
    let ok = handler.run(core).await?;
    serde_json::value::to_raw_value(&ok).map_err(|error| core.failed_with("call", &error))
}

async fn timed<T>(
    method: &str,
    call: impl Future<Output = Result<T, RpcError>>,
) -> Result<T, RpcError> {
    let started = Instant::now();
    let result = call.await;
    let elapsed = started.elapsed();
    let elapsed_ms = u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX);
    match &result {
        Ok(_) if elapsed >= SLOW_CALL => {
            tracing::info!(method, elapsed_ms, "slow call finished");
        }
        Ok(_) => tracing::debug!(method, elapsed_ms, "call finished"),
        Err(error) => tracing::debug!(method, elapsed_ms, ?error, "call failed"),
    }
    result
}

impl Core {
    /// Runs `"<domain>.<method>"` on JSON params and returns the JSON result.
    /// Logs the method name without its params.
    ///
    /// # Errors
    ///
    /// `Unsupported` for an unknown method, otherwise the handler's error.
    pub async fn call(
        self: &Arc<Self>,
        method: &str,
        params: &str,
    ) -> Result<Box<RawValue>, RpcError> {
        if self.shut_down.load(std::sync::atomic::Ordering::SeqCst) {
            return Err(RpcCode::Unavailable.into());
        }
        let Some((domain, name)) = method.split_once('.') else {
            return Err(RpcCode::Unsupported.into());
        };
        let span = tracing::info_span!("rpc", method);
        tracing::Instrument::instrument(
            timed(method, async {
                route(self, domain, name, params)
                    .await
                    .unwrap_or_else(|| Err(RpcCode::Unsupported.into()))
            }),
            span,
        )
        .await
    }

    /// Runs a handler directly, for callers on the Rust side.
    ///
    /// # Errors
    ///
    /// `Unavailable` after shutdown, otherwise the handler's error.
    pub async fn run<H: Handler>(self: &Arc<Self>, handler: H) -> Result<H::Ok, RpcError> {
        if self.shut_down.load(std::sync::atomic::Ordering::SeqCst) {
            return Err(RpcCode::Unavailable.into());
        }
        timed(std::any::type_name::<H>(), Box::pin(handler.run(self))).await
    }
}
