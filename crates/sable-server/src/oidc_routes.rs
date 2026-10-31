use std::time::{Duration, Instant};

use axum::{
    Extension,
    extract::{Query, State},
    http::{HeaderMap, HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
};
use axum_client_ip::ClientIp;
use axum_extra::headers::{Cookie, HeaderMapExt};
use serde::Deserialize;
use tower_sessions::Session;

use crate::Server;

#[derive(Deserialize)]
pub(super) struct OidcCallback {
    code: String,
    state: String,
}

pub(super) async fn oidc_status(State(server): State<Server>) -> Response {
    let mut response = axum::Json(
        serde_json::json!({ "oidc": server.oidc.is_some(), "local": server.auth.local_enabled() }),
    )
    .into_response();
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

pub(super) async fn oidc_start(
    State(server): State<Server>,
    Extension(ClientIp(ip)): Extension<ClientIp>,
    headers: HeaderMap,
) -> Response {
    let Some(oidc) = &server.oidc else {
        return StatusCode::NOT_FOUND.into_response();
    };
    {
        let mut transactions = server.oidc_transactions.lock().await;
        transactions.retain(|_, (created, _, _)| created.elapsed() < Duration::from_secs(600));
        if let Some(previous) = oidc_cookie(&headers) {
            transactions.remove(&previous);
        }
        if transactions.len() >= 1024
            || transactions
                .values()
                .filter(|(_, owner, _)| *owner == ip)
                .count()
                >= 5
        {
            return StatusCode::SERVICE_UNAVAILABLE.into_response();
        }
    }
    let Ok((url, transaction)) = oidc.start().await else {
        return StatusCode::BAD_GATEWAY.into_response();
    };
    let cookie = uuid::Uuid::new_v4().to_string();
    let mut transactions = server.oidc_transactions.lock().await;
    transactions.retain(|_, (created, _, _)| created.elapsed() < Duration::from_secs(600));
    if let Some(previous) = oidc_cookie(&headers) {
        transactions.remove(&previous);
    }
    if transactions.len() >= 1024
        || transactions
            .values()
            .filter(|(_, owner, _)| *owner == ip)
            .count()
            >= 5
    {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    }
    transactions.insert(cookie.clone(), (Instant::now(), ip, transaction));
    let mut response = axum::response::Redirect::temporary(&url).into_response();
    let cookie =
        format!("__Host-sable_oidc={cookie}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=600");
    if let Ok(value) = HeaderValue::from_str(&cookie) {
        response.headers_mut().append(header::SET_COOKIE, value);
    }
    response
}

fn oidc_cookie(headers: &HeaderMap) -> Option<String> {
    headers
        .typed_get::<Cookie>()?
        .get("__Host-sable_oidc")
        .map(ToOwned::to_owned)
}

pub(super) async fn oidc_callback(
    State(server): State<Server>,
    session: Session,
    headers: HeaderMap,
    Query(query): Query<OidcCallback>,
) -> Response {
    let Some(oidc) = &server.oidc else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let cookie = oidc_cookie(&headers);
    let Some(cookie) = cookie else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    let transaction = server.oidc_transactions.lock().await.remove(&cookie);
    let Some((created, _, transaction)) = transaction else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    if created.elapsed() >= Duration::from_secs(600) || transaction.state != query.state {
        return StatusCode::BAD_REQUEST.into_response();
    }
    let Ok(subject) = oidc.exchange(query.code, transaction).await else {
        return StatusCode::UNAUTHORIZED.into_response();
    };
    let user_id = if server.oidc_auto_provision {
        server
            .auth
            .provision_oidc(oidc.issuer.clone(), subject)
            .await
    } else {
        server.auth.oidc_user(&oidc.issuer, &subject)
    };
    let Some(user_id) = user_id else {
        return StatusCode::FORBIDDEN.into_response();
    };
    if server.auth.login(&session, &user_id, None).await.is_err() {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    let mut response = axum::response::Redirect::to("/").into_response();
    response.headers_mut().append(
        header::SET_COOKIE,
        HeaderValue::from_static(
            "__Host-sable_oidc=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0",
        ),
    );
    response
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{config::Config, oidc, sessions::SessionMemoryStore};
    use axum_client_ip::ClientIpSource;
    use std::{net::IpAddr, sync::Arc};

    #[test]
    fn oidc_cookie_is_read_from_multiple_cookie_headers() {
        let mut headers = HeaderMap::new();
        headers.append(header::COOKIE, HeaderValue::from_static("other=value"));
        headers.append(
            header::COOKIE,
            HeaderValue::from_static("another=value; __Host-sable_oidc=transaction"),
        );
        assert_eq!(oidc_cookie(&headers).as_deref(), Some("transaction"));
        assert_eq!(oidc_cookie(&HeaderMap::new()), None);
    }

    #[tokio::test]
    async fn oidc_callback_rejects_mismatched_and_replayed_state() {
        let dir = tempfile::tempdir().unwrap();
        let config = Config {
            listen_addr: "127.0.0.1:18008".into(),
            public_url: "http://127.0.0.1:18008".into(),
            client_ip_source: ClientIpSource::ConnectInfo,
            data_dir: dir.path().to_owned(),
            max_active_users: 128,
            allowed_private_cidrs: vec!["127.0.0.1/32".into()],
            username: "legacy".into(),
            password_hash: None,
            oidc_issuer: Some("http://127.0.0.1:9999".into()),
            oidc_client_id: Some("client".into()),
            oidc_client_secret: Some("secret".into()),
            oidc_auto_provision: false,
            frontend_dir: dir.path().join("missing"),
        };
        let server = Server::new(config).unwrap();
        server.oidc_transactions.lock().await.insert(
            "cookie".into(),
            (
                Instant::now(),
                IpAddr::from([127, 0, 0, 1]),
                oidc::Transaction {
                    state: "expected".into(),
                    nonce: "nonce".into(),
                    verifier: "verifier".into(),
                },
            ),
        );
        let mut headers = HeaderMap::new();
        headers.insert(
            header::COOKIE,
            HeaderValue::from_static("__Host-sable_oidc=cookie"),
        );
        let session = Session::new(None, Arc::new(SessionMemoryStore::default()), None);
        let response = oidc_callback(
            State(server.clone()),
            session.clone(),
            headers.clone(),
            Query(OidcCallback {
                code: "code".into(),
                state: "wrong".into(),
            }),
        )
        .await;
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        let replay = oidc_callback(
            State(server),
            session,
            headers,
            Query(OidcCallback {
                code: "code".into(),
                state: "expected".into(),
            }),
        )
        .await;
        assert_eq!(replay.status(), StatusCode::BAD_REQUEST);
    }
}
