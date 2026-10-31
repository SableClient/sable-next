use std::{net::IpAddr, sync::Arc, sync::atomic::Ordering};

use axum::{
    Extension,
    body::Body,
    extract::{FromRequestParts, State},
    http::{HeaderMap, HeaderValue, Method, StatusCode, header},
    middleware::Next,
    response::{IntoResponse, Response},
};
use axum_client_ip::ClientIp;
use axum_extra::{
    TypedHeader,
    headers::authorization::{Authorization, Basic},
};
use tower_governor::{GovernorError, key_extractor::KeyExtractor};
use tower_sessions::Session;

use crate::{Server, SessionRevocation, auth::logout as destroy_session};

#[derive(Clone)]
pub(super) struct ServerUserId(String);

pub(super) async fn server_identity(Extension(user): Extension<ServerUserId>) -> Response {
    let mut response = axum::Json(serde_json::json!({ "id": user.0 })).into_response();
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

pub(super) async fn auth_status(State(server): State<Server>, session: Session) -> Response {
    if server.auth.authenticate(&session).await.is_some() {
        StatusCode::NO_CONTENT.into_response()
    } else {
        unauthorized().into_response()
    }
}

pub(super) async fn authenticate(
    State(server): State<Server>,
    session: Session,
    credentials: Option<TypedHeader<Authorization<Basic>>>,
) -> Response {
    let Ok(permit) = server.password_checks.clone().try_acquire_owned() else {
        return StatusCode::TOO_MANY_REQUESTS.into_response();
    };
    let Some((user_id, version)) = server
        .auth
        .check_basic(credentials.as_ref().map(|TypedHeader(value)| value), permit)
        .await
    else {
        let mut response = StatusCode::UNAUTHORIZED.into_response();
        response.headers_mut().insert(
            header::WWW_AUTHENTICATE,
            HeaderValue::from_static("Basic realm=\"Sable\", charset=\"UTF-8\""),
        );
        return response;
    };
    if server
        .auth
        .login(&session, &user_id, Some(version))
        .await
        .is_err()
    {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    StatusCode::NO_CONTENT.into_response()
}

pub(super) async fn logout(State(server): State<Server>, session: Session) -> Response {
    let id = session.id();
    if destroy_session(&session).await.is_err() {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    if let Some(id) = id {
        let _ = server
            .session_revocations
            .send(SessionRevocation::Session(id));
    }
    StatusCode::NO_CONTENT.into_response()
}

pub(super) async fn cancel_on_shutdown(
    State(server): State<Server>,
    request: axum::http::Request<Body>,
    next: Next,
) -> Response {
    if server.shutdown.is_cancelled() || server.runtimes.shutting_down.load(Ordering::Acquire) {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    }
    tokio::select! {
        () = server.shutdown.cancelled() => StatusCode::SERVICE_UNAVAILABLE.into_response(),
        response = next.run(request) => response,
    }
}

pub(super) async fn auth_middleware(
    State(server): State<Server>,
    mut request: axum::http::Request<Body>,
    next: Next,
) -> Response {
    let path = request.uri().path().to_owned();
    if !path.starts_with("/_sable/") && path != "/_sable" {
        return next.run(request).await;
    }
    let session = request.extensions().get::<Session>().cloned();
    let user_id = if let Some(session) = &session {
        server.auth.authenticate(session).await
    } else {
        None
    };
    if matches!(
        path.as_str(),
        "/_sable/oidc/status" | "/_sable/oidc/start" | "/_sable/oidc/callback"
    ) {
        return next.run(request).await;
    }
    if path == "/_sable/auth" {
        if request.method() != Method::GET
            && request.method() != Method::HEAD
            && request.headers().contains_key(header::COOKIE)
            && !same_origin(request.headers(), &server.public_url)
        {
            return StatusCode::FORBIDDEN.into_response();
        }
        return next.run(request).await;
    }
    let Some(user_id) = user_id else {
        return unauthorized().into_response();
    };
    if request
        .headers()
        .get("x-sable-user")
        .is_some_and(|expected| expected.as_bytes() != user_id.as_bytes())
    {
        return StatusCode::FORBIDDEN.into_response();
    }
    let state_change = request.method() != Method::GET && request.method() != Method::HEAD;
    let websocket = path == "/_sable/ws";
    if (state_change || websocket) && !same_origin(request.headers(), &server.public_url) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let runtime = match server.runtimes.get(&user_id).await {
        Ok(runtime) => runtime,
        Err(error) => {
            tracing::error!(%error, "failed to open user runtime");
            return StatusCode::SERVICE_UNAVAILABLE.into_response();
        }
    };
    // Logout must remain available even if a user has exhausted their request quota.
    let (_request, _user_request) = if path == "/_sable/logout" || websocket {
        (None, None)
    } else {
        let Ok(request_permit) = server.http_requests.clone().try_acquire_owned() else {
            return StatusCode::TOO_MANY_REQUESTS.into_response();
        };
        let Ok(user_permit) = runtime.http_requests.clone().try_acquire_owned() else {
            return StatusCode::TOO_MANY_REQUESTS.into_response();
        };
        (Some(request_permit), Some(user_permit))
    };
    let _upload = if matches!(
        path.as_str(),
        "/_sable/upload" | "/_sable/send-attachment" | "/_sable/send-gallery"
    ) {
        match runtime.uploads.clone().try_acquire_owned() {
            Ok(permit) => Some(permit),
            Err(_) => return StatusCode::TOO_MANY_REQUESTS.into_response(),
        }
    } else {
        None
    };
    let Some(session_id) = session.and_then(|session| session.id()) else {
        return unauthorized().into_response();
    };
    request.extensions_mut().insert(runtime);
    request
        .extensions_mut()
        .insert(ServerUserId(user_id.clone()));
    if path == "/_sable/logout" {
        return next.run(request).await;
    }

    run_protected_request(&server, session_id, &user_id, request, next).await
}

async fn run_protected_request(
    server: &Server,
    session_id: tower_sessions::session::Id,
    user_id: &str,
    request: axum::http::Request<Body>,
    next: Next,
) -> Response {
    let mut revocations = server.session_revocations.subscribe();
    let valid_session = || async {
        let session = Session::new(Some(session_id), Arc::new(server.sessions.clone()), None);
        server.auth.authenticate(&session).await.as_deref() == Some(user_id)
    };
    if !valid_session().await {
        return unauthorized().into_response();
    }
    let response = next.run(request);
    tokio::pin!(response);
    loop {
        tokio::select! {
            result = &mut response => {
                return if valid_session().await { result } else { unauthorized().into_response() };
            }
            revoked = revocations.recv() => {
                if SessionRevocation::ends(&revoked, session_id, user_id) {
                    return unauthorized().into_response();
                }
            }
        }
    }
}

pub(super) fn same_origin(headers: &HeaderMap, public_url: &str) -> bool {
    headers
        .get(header::ORIGIN)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|origin| origin == public_url)
}

#[derive(Clone, Copy)]
pub(super) struct ClientIpKeyExtractor;

impl KeyExtractor for ClientIpKeyExtractor {
    type Key = IpAddr;

    fn extract<T>(&self, request: &axum::http::Request<T>) -> Result<Self::Key, GovernorError> {
        request
            .extensions()
            .get::<ClientIp>()
            .map(|ClientIp(ip)| *ip)
            .ok_or(GovernorError::UnableToExtractKey)
    }
}

pub(super) fn unauthorized() -> Response {
    StatusCode::UNAUTHORIZED.into_response()
}

pub(super) async fn extract_client_ip(request: axum::http::Request<Body>, next: Next) -> Response {
    let (mut parts, body) = request.into_parts();
    let Ok(client_ip) = ClientIp::from_request_parts(&mut parts, &()).await else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    parts.extensions.insert(client_ip);
    next.run(axum::http::Request::from_parts(parts, body)).await
}
