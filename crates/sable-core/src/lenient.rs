//! ruma fails a whole response when one item of a list in it is invalid, so these lists are read
//! as `Raw` and an invalid item is dropped on its own.

use std::fmt;
use std::marker::PhantomData;

use ruma::api::error::IntoHttpError;
use ruma::api::path_builder::PathBuilder;
use ruma::api::{IncomingResponse, Metadata, OutgoingRequest};
use ruma::exports::http;
use ruma::serde::Raw;

pub(crate) fn parse_or_skip<'a, T: serde::Deserialize<'a>>(
    raw: &'a Raw<T>,
    what: &str,
) -> Option<T> {
    raw.deserialize()
        .inspect_err(|error| tracing::warn!("skipping an invalid {what}: {error}"))
        .ok()
}

/// Sends ruma's request `R` unchanged and reads the response as `T`.
pub(crate) struct Request<R, T>(R, PhantomData<fn() -> T>);

impl<R, T> Request<R, T> {
    pub(crate) const fn new(request: R) -> Self {
        Self(request, PhantomData)
    }
}

impl<R: Clone, T> Clone for Request<R, T> {
    fn clone(&self) -> Self {
        Self::new(self.0.clone())
    }
}

impl<R: fmt::Debug, T> fmt::Debug for Request<R, T> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(f)
    }
}

impl<R: Metadata, T> Metadata for Request<R, T> {
    const METHOD: http::Method = R::METHOD;
    const RATE_LIMITED: bool = R::RATE_LIMITED;
    type Authentication = R::Authentication;
    type PathBuilder = R::PathBuilder;
    const PATH_BUILDER: Self::PathBuilder = R::PATH_BUILDER;
}

impl<R, T> OutgoingRequest for Request<R, T>
where
    R: OutgoingRequest,
    T: IncomingResponse<EndpointError = R::EndpointError>,
{
    type Body = R::Body;
    type EndpointError = R::EndpointError;
    type IncomingResponse = T;

    fn try_into_http_request_inner(
        self,
        base_url: &str,
        input: <Self::PathBuilder as PathBuilder>::Input<'_>,
    ) -> Result<http::Request<Self::Body>, IntoHttpError> {
        self.0.try_into_http_request_inner(base_url, input)
    }
}
