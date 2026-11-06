#![expect(
    clippy::assertions_on_result_states,
    clippy::expect_used,
    clippy::panic,
    clippy::unwrap_used,
    reason = "test failures should stop the test at the failed assertion"
)]

use std::{net::SocketAddr, time::Duration};

use axum_client_ip::ClientIpSource;
use futures_util::{SinkExt, StreamExt};
use sable_server::{Server, config::Config};
use serde_json::{Value, json};
use tempfile::tempdir;
use tokio_tungstenite::{
    connect_async,
    tungstenite::{Message, client::IntoClientRequest},
};

#[test]
fn invalid_configured_password_hash_reports_the_setting() {
    let directory = tempdir().unwrap();
    let output = std::process::Command::new(env!("CARGO_BIN_EXE_sable-server"))
        .env("SABLE_SERVER_LISTEN_ADDR", "127.0.0.1:0")
        .env("SABLE_SERVER_PUBLIC_URL", "http://localhost")
        .env("SABLE_SERVER_DATA_DIR", directory.path())
        .env("SABLE_SERVER_PASSWORD_HASH", "secret-malformed-hash")
        .output()
        .unwrap();
    assert!(!output.status.success());
    let stderr = String::from_utf8(output.stderr).unwrap();
    assert!(stderr.contains("SABLE_SERVER_PASSWORD_HASH"), "{stderr}");
    assert!(!stderr.contains("secret-malformed-hash"), "{stderr}");
}

async fn start_server() -> (String, Server, tokio::task::JoinHandle<()>) {
    start_server_with_ip_source(ClientIpSource::ConnectInfo).await
}

async fn start_server_with_ip_source(
    client_ip_source: ClientIpSource,
) -> (String, Server, tokio::task::JoinHandle<()>) {
    start_server_with_users(client_ip_source, None, None).await
}

async fn start_server_with_users(
    client_ip_source: ClientIpSource,
    users: Option<Value>,
    directory: Option<std::path::PathBuf>,
) -> (String, Server, tokio::task::JoinHandle<()>) {
    let data_dir =
        directory.unwrap_or_else(|| tempdir().expect("temporary server directory").keep());
    if let Some(users) = users {
        std::fs::write(data_dir.join("users.json"), users.to_string()).unwrap();
    }
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("test listener");
    let address = listener.local_addr().expect("test listener address");
    let config = Config {
        listen_addr: "127.0.0.1:0".to_owned(),
        public_url: format!("http://{address}"),
        client_ip_source,
        data_dir,
        max_active_users: 128,
        allowed_private_cidrs: vec!["127.0.0.1/32".into()],
        username: "test".to_owned(),
        password_hash: Some("$argon2id$v=19$m=19456,t=2,p=1$P+eI2tfGQ1sd90QtbQ8wFA$Obgt2lytjJYQTynFGGi4Lu+2hlyyipgjDot5QXzqxjs".to_owned()),
        oidc_issuer: None,
        oidc_client_id: None,
        oidc_client_secret: None,
        oidc_auto_provision: false,
        frontend_dir: "missing-frontend".into(),
    };
    let server = Server::new(config).expect("server");
    let app_server = server.clone();
    let task = tokio::spawn(async move {
        axum::serve(
            listener,
            app_server
                .app()
                .into_make_service_with_connect_info::<SocketAddr>(),
        )
        .await
        .expect("test server");
    });
    (format!("http://{address}"), server, task)
}

async fn cookie(base: &str) -> String {
    let response = reqwest::Client::new()
        .post(format!("{base}/_sable/auth"))
        .basic_auth("test", Some("password"))
        .send()
        .await
        .expect("auth request");
    assert_eq!(
        response.status(),
        reqwest::StatusCode::NO_CONTENT,
        "basic auth should succeed"
    );
    response
        .headers()
        .get(reqwest::header::SET_COOKIE)
        .expect("auth cookie")
        .to_str()
        .expect("cookie header")
        .split(';')
        .next()
        .expect("cookie value")
        .to_owned()
}

async fn connect(
    base: &str,
    cookie: &str,
    query: &str,
) -> tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>> {
    let url = format!("{base}/_sable/ws{query}").replace("http://", "ws://");
    let mut request = url.into_client_request().expect("websocket request");
    request
        .headers_mut()
        .insert("Cookie", cookie.parse().expect("cookie header"));
    request
        .headers_mut()
        .insert("Origin", base.parse().expect("origin header"));
    connect_async(request)
        .await
        .expect("authenticated websocket")
        .0
}

async fn receive_json(
    socket: &mut tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
) -> Value {
    let message = tokio::time::timeout(Duration::from_secs(2), socket.next())
        .await
        .expect("websocket message timeout")
        .expect("websocket closed")
        .expect("websocket error");
    let Message::Text(text) = message else {
        panic!("expected a text websocket message")
    };
    serde_json::from_str(&text).expect("JSON websocket message")
}

async fn connect_compressed(base: &str, cookie: &str) -> yawc::TcpWebSocket {
    let url = format!("{base}/_sable/ws").replace("http://", "ws://");
    yawc::WebSocket::connect(url.parse().expect("websocket URL"))
        .with_request(
            yawc::HttpRequestBuilder::new()
                .header("Cookie", cookie)
                .header("Origin", base),
        )
        .with_options(yawc::Options::default().with_balanced_compression())
        .await
        .expect("compressed websocket")
}

async fn receive_yawc_json(socket: &mut yawc::TcpWebSocket) -> Value {
    let frame = tokio::time::timeout(Duration::from_secs(2), socket.next())
        .await
        .expect("websocket message timeout")
        .expect("websocket closed");
    assert!(
        frame.opcode() == yawc::OpCode::Text,
        "expected a text websocket message"
    );
    serde_json::from_slice(frame.payload()).expect("JSON websocket message")
}

#[tokio::test]
async fn authenticates_with_basic_credentials_and_rejects_bad_credentials() {
    let (base, _server, task) = start_server().await;
    let client = reqwest::Client::new();
    let bad = client
        .post(format!("{base}/_sable/auth"))
        .basic_auth("test", Some("wrong"))
        .send()
        .await
        .expect("bad auth");
    assert_eq!(bad.status(), reqwest::StatusCode::UNAUTHORIZED);
    let unknown = client
        .post(format!("{base}/_sable/auth"))
        .basic_auth("unknown-user", Some("password"))
        .send()
        .await
        .expect("unknown user auth");
    assert_eq!(unknown.status(), reqwest::StatusCode::UNAUTHORIZED);
    let good = client
        .post(format!("{base}/_sable/auth"))
        .basic_auth("test", Some("password"))
        .send()
        .await
        .expect("good auth");
    assert_eq!(good.status(), reqwest::StatusCode::NO_CONTENT);
    assert!(good.headers().contains_key(reqwest::header::SET_COOKIE));
    task.abort();
}

#[tokio::test]
async fn rate_limits_repeated_bad_credentials() {
    let (base, _server, task) =
        start_server_with_ip_source(ClientIpSource::RightmostXForwardedFor).await;
    let client = reqwest::Client::new();
    for _ in 0..5 {
        let response = client
            .post(format!("{base}/_sable/auth"))
            .header("X-Forwarded-For", "192.0.2.10")
            .basic_auth("test", Some("wrong"))
            .send()
            .await
            .expect("bad auth");
        assert_eq!(response.status(), reqwest::StatusCode::UNAUTHORIZED);
    }
    let response = client
        .post(format!("{base}/_sable/auth"))
        .header("X-Forwarded-For", "192.0.2.10")
        .basic_auth("test", Some("password"))
        .send()
        .await
        .expect("limited auth");
    assert_eq!(response.status(), reqwest::StatusCode::TOO_MANY_REQUESTS);
    let response = client
        .post(format!("{base}/_sable/auth"))
        .header("X-Forwarded-For", "192.0.2.11")
        .basic_auth("test", Some("password"))
        .send()
        .await
        .expect("different client auth");
    assert_eq!(response.status(), reqwest::StatusCode::NO_CONTENT);
    task.abort();
}

#[tokio::test]
async fn login_sets_a_secure_cookie_and_logout_destroys_the_session() {
    let (base, _server, task) = start_server().await;
    let client = reqwest::Client::new();
    let login = client
        .post(format!("{base}/_sable/auth"))
        .basic_auth("test", Some("password"))
        .send()
        .await
        .expect("auth");
    assert_eq!(login.status(), reqwest::StatusCode::NO_CONTENT);
    let cookie_header = login
        .headers()
        .get(reqwest::header::SET_COOKIE)
        .expect("auth cookie")
        .to_str()
        .expect("cookie header")
        .to_owned();
    assert!(login.bytes().await.expect("response body").is_empty());
    assert!(cookie_header.starts_with("__Host-sable_auth="));
    assert!(cookie_header.contains("HttpOnly"));
    assert!(cookie_header.contains("Secure"));
    assert!(cookie_header.contains("SameSite=Strict"));
    assert!(cookie_header.contains("Path=/"));
    let cookie = cookie(&base).await;
    let status = client
        .get(format!("{base}/_sable/auth"))
        .header(reqwest::header::COOKIE, &cookie)
        .send()
        .await
        .expect("auth status");
    assert_eq!(status.status(), reqwest::StatusCode::NO_CONTENT);
    let relogin = client
        .post(format!("{base}/_sable/auth"))
        .header(reqwest::header::COOKIE, &cookie)
        .header(reqwest::header::ORIGIN, &base)
        .basic_auth("test", Some("password"))
        .send()
        .await
        .expect("relogin");
    assert_eq!(relogin.status(), reqwest::StatusCode::NO_CONTENT);
    let rotated_cookie = relogin
        .headers()
        .get(reqwest::header::SET_COOKIE)
        .expect("rotated auth cookie")
        .to_str()
        .expect("rotated cookie header")
        .split(';')
        .next()
        .expect("rotated cookie value")
        .to_owned();
    assert_ne!(cookie, rotated_cookie);
    let old_status = client
        .get(format!("{base}/_sable/auth"))
        .header(reqwest::header::COOKIE, &cookie)
        .send()
        .await
        .expect("old auth status");
    assert_eq!(old_status.status(), reqwest::StatusCode::UNAUTHORIZED);
    let status = client
        .get(format!("{base}/_sable/auth"))
        .header(reqwest::header::COOKIE, &rotated_cookie)
        .send()
        .await
        .expect("rotated auth status");
    assert_eq!(status.status(), reqwest::StatusCode::NO_CONTENT);
    let logout = client
        .post(format!("{base}/_sable/logout"))
        .header(reqwest::header::COOKIE, &rotated_cookie)
        .header(reqwest::header::ORIGIN, &base)
        .send()
        .await
        .expect("logout");
    assert_eq!(logout.status(), reqwest::StatusCode::NO_CONTENT);
    let status = client
        .get(format!("{base}/_sable/auth"))
        .header(reqwest::header::COOKIE, &rotated_cookie)
        .send()
        .await
        .expect("revoked auth status");
    assert_eq!(status.status(), reqwest::StatusCode::UNAUTHORIZED);
    task.abort();
}

#[tokio::test]
async fn every_response_has_security_headers_and_missing_index_is_not_not_modified() {
    let (base, _server, task) = start_server().await;
    let client = reqwest::Client::new();
    let response = client
        .get(format!("{base}/healthz"))
        .send()
        .await
        .expect("health");
    assert_eq!(response.status(), reqwest::StatusCode::OK);
    assert_eq!(response.headers()["x-content-type-options"], "nosniff");
    assert_eq!(response.headers()["x-frame-options"], "DENY");
    assert_eq!(
        response.headers()["referrer-policy"],
        "strict-origin-when-cross-origin"
    );
    let missing = client
        .get(format!("{base}/missing.js"))
        .header(reqwest::header::IF_NONE_MATCH, "\"stale\"")
        .send()
        .await
        .expect("missing asset");
    assert_eq!(missing.status(), reqwest::StatusCode::NOT_FOUND);
    task.abort();
}

#[tokio::test]
async fn rejects_unauthenticated_and_cross_origin_websockets() {
    let (base, _server, task) = start_server().await;
    assert!(
        connect_async(format!("{base}/_sable/ws").replace("http://", "ws://"))
            .await
            .is_err()
    );
    let cookie = cookie(&base).await;
    let url = format!("{base}/_sable/ws").replace("http://", "ws://");
    let mut request = url.into_client_request().expect("request");
    request
        .headers_mut()
        .insert("Cookie", cookie.parse().expect("cookie"));
    request
        .headers_mut()
        .insert("Origin", "https://evil.example".parse().expect("origin"));
    assert!(connect_async(request).await.is_err());
    task.abort();
}

#[tokio::test]
async fn calls_core_and_broadcasts_sequence_numbered_events() {
    let (base, server, task) = start_server().await;
    let cookie = cookie(&base).await;
    let mut first = connect(&base, &cookie, "").await;
    let mut second = connect(&base, &cookie, "").await;
    let hello = receive_json(&mut first).await;
    assert_eq!(hello["server"]["version"], "0.1.0");
    assert!(hello["server"]["run_id"].is_string());
    assert!(receive_json(&mut second).await["server"].is_object());
    first
        .send(Message::Text(
            json!({"id": 7, "method": "session.list_accounts", "params": {}})
                .to_string()
                .into(),
        ))
        .await
        .expect("RPC");
    let reply = receive_json(&mut first).await;
    assert_eq!(reply["id"], 7);
    assert_eq!(reply["ok"], json!([]));
    server
        .core()
        .emit(sable_core::protocol::CoreEvent::SessionEnded {
            reason: "test".to_owned(),
        });
    let event = receive_json(&mut first).await;
    assert_eq!(event["seq"], 1);
    assert_eq!(
        event["event"],
        json!({"type": "session_ended", "reason": "test"})
    );
    assert_eq!(receive_json(&mut second).await["seq"], 1);
    task.abort();
}

#[tokio::test]
async fn negotiates_permessage_deflate_and_decodes_text_messages() {
    let (base, _server, task) = start_server().await;
    let cookie = cookie(&base).await;
    let mut socket = connect_compressed(&base, &cookie).await;
    assert!(receive_yawc_json(&mut socket).await["server"].is_object());
    socket
        .send(yawc::Frame::text(
            json!({"id": 9, "method": "session.list_accounts", "params": {}}).to_string(),
        ))
        .await
        .expect("RPC");
    let reply = receive_yawc_json(&mut socket).await;
    assert_eq!(reply["id"], 9);
    assert_eq!(reply["ok"], json!([]));
    task.abort();
}

#[tokio::test]
async fn replays_events_and_resets_when_the_run_or_buffer_is_not_available() {
    let (base, server, task) = start_server().await;
    let cookie = cookie(&base).await;
    let mut socket = connect(&base, &cookie, "").await;
    let run_id = receive_json(&mut socket).await["server"]["run_id"]
        .as_str()
        .expect("run id")
        .to_owned();
    server
        .core()
        .emit(sable_core::protocol::CoreEvent::SessionEnded {
            reason: "replay".to_owned(),
        });
    assert_eq!(receive_json(&mut socket).await["seq"], 1);
    drop(socket);
    server
        .core()
        .emit(sable_core::protocol::CoreEvent::SessionEnded {
            reason: "missed".to_owned(),
        });
    let query = format!("?run_id={run_id}&last_received_event=1");
    let mut resumed = connect(&base, &cookie, &query).await;
    assert_eq!(receive_json(&mut resumed).await["server"]["run_id"], run_id);
    assert_eq!(
        receive_json(&mut resumed).await["event"]["reason"],
        "missed"
    );
    let mut reset = connect(&base, &cookie, "?run_id=old&last_received_event=1").await;
    assert!(receive_json(&mut reset).await["server"].is_object());
    assert_eq!(receive_json(&mut reset).await["reset"], true);
    task.abort();
}

#[cfg(unix)]
#[tokio::test]
async fn shutdown_cancels_in_flight_http_work() {
    use tokio::io::AsyncWriteExt;

    let directory = tempdir().unwrap();
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    drop(listener);
    let base = format!("http://{address}");
    let mut child = std::process::Command::new(env!("CARGO_BIN_EXE_sable-server"))
        .env("SABLE_SERVER_LISTEN_ADDR", address.to_string())
        .env("SABLE_SERVER_PUBLIC_URL", &base)
        .env("SABLE_SERVER_DATA_DIR", directory.path())
        .env("SABLE_SERVER_USERNAME", "test")
        .env("SABLE_SERVER_PASSWORD_HASH", "$argon2id$v=19$m=19456,t=2,p=1$P+eI2tfGQ1sd90QtbQ8wFA$Obgt2lytjJYQTynFGGi4Lu+2hlyyipgjDot5QXzqxjs")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn().unwrap();
    let result = async {
        tokio::time::timeout(Duration::from_secs(10), async {
            while reqwest::get(format!("{base}/healthz")).await.is_err() {
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
        }).await.unwrap();
        let cookie = cookie(&base).await;
        let mut socket = connect(&base, &cookie, "").await;
        receive_json(&mut socket).await;
        let mut upload = tokio::net::TcpStream::connect(address).await.unwrap();
        let request = format!("POST /_sable/upload HTTP/1.1\r\nHost: {address}\r\nOrigin: {base}\r\nCookie: {cookie}\r\nTransfer-Encoding: chunked\r\n\r\n4\r\ndata\r\n");
        upload.write_all(request.as_bytes()).await.unwrap();
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert!(std::process::Command::new("kill").args(["-TERM", &child.id().to_string()]).status().unwrap().success());
        let closed = tokio::time::timeout(Duration::from_secs(3), socket.next()).await.unwrap();
        assert!(matches!(closed, None | Some(Ok(Message::Close(_)) | Err(_))));
        tokio::time::timeout(Duration::from_secs(4), async {
            loop {
                if let Some(status) = child.try_wait().unwrap() { break status; }
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
        }).await
    }.await;
    if result.is_err() {
        let _ = child.kill();
        let _ = child.wait();
    }
    assert!(
        result
            .expect("server did not shut down with an incomplete upload")
            .success()
    );
}

#[tokio::test]
async fn user_removal_requires_stopped_server_and_deletes_only_its_stores() {
    let directory = tempdir().unwrap();
    let alice = "7c230ca2-1285-4af9-8c18-fddcc321229e";
    let bob = "69cbc01f-5826-46e6-a808-f39d9217cad8";
    let hash = "$argon2id$v=19$m=19456,t=2,p=1$P+eI2tfGQ1sd90QtbQ8wFA$Obgt2lytjJYQTynFGGi4Lu+2hlyyipgjDot5QXzqxjs";
    let users = json!({"users": [{"id": alice, "username": "alice", "password_hash": hash}, {"id": bob, "username": "bob", "password_hash": hash}]});
    let (_, server, task) = start_server_with_users(
        ClientIpSource::ConnectInfo,
        Some(users),
        Some(directory.path().to_owned()),
    )
    .await;
    for id in [alice, bob] {
        let path = directory.path().join("users").join(id);
        std::fs::create_dir_all(&path).unwrap();
        std::fs::write(path.join("data-account-a1"), "private store").unwrap();
    }
    let legacy = directory.path().join("legacy-store");
    std::fs::write(&legacy, "legacy").unwrap();
    let remove = || {
        std::process::Command::new(env!("CARGO_BIN_EXE_sable-server"))
            .env("SABLE_SERVER_DATA_DIR", directory.path())
            .args(["remove-user", alice, "--delete-data"])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .unwrap()
    };
    assert!(!remove().success());
    assert!(directory.path().join("users").join(alice).exists());
    task.abort();
    let _ = task.await;
    drop(server);
    assert!(remove().success());
    assert!(!directory.path().join("users").join(alice).exists());
    assert!(
        directory
            .path()
            .join("users")
            .join(bob)
            .join("data-account-a1")
            .exists()
    );
    assert_eq!(std::fs::read_to_string(legacy).unwrap(), "legacy");
    let registry: Value =
        serde_json::from_slice(&std::fs::read(directory.path().join("users.json")).unwrap())
            .unwrap();
    assert_eq!(registry["users"][0]["disabled"], true);
    assert_eq!(registry["users"][0]["deleted"], true);
    assert_eq!(registry["users"][1]["disabled"], false);
    assert!(remove().success());
}

#[tokio::test]
async fn protected_media_and_upload_routes_require_the_cookie() {
    let (base, _server, task) = start_server().await;
    let client = reqwest::Client::new();
    let unknown = client
        .get(format!("{base}/_sable/not-a-route"))
        .send()
        .await
        .expect("unknown protected route");
    assert_eq!(unknown.status(), reqwest::StatusCode::UNAUTHORIZED);
    let media = client
        .get(format!("{base}/_sable/media/example.org/id"))
        .send()
        .await
        .expect("media request");
    assert_eq!(media.status(), reqwest::StatusCode::UNAUTHORIZED);
    let upload = client
        .post(format!("{base}/_sable/upload"))
        .body("data")
        .send()
        .await
        .expect("upload request");
    assert_eq!(upload.status(), reqwest::StatusCode::UNAUTHORIZED);
    task.abort();
}

#[tokio::test]
async fn local_users_have_separate_runtime_and_replay() {
    let hash = "$argon2id$v=19$m=19456,t=2,p=1$P+eI2tfGQ1sd90QtbQ8wFA$Obgt2lytjJYQTynFGGi4Lu+2hlyyipgjDot5QXzqxjs";
    let users = json!({"users": [{"id": "7c230ca2-1285-4af9-8c18-fddcc321229e", "username": "alice", "password_hash": hash}, {"id": "69cbc01f-5826-46e6-a808-f39d9217cad8", "username": "bob", "password_hash": hash}]});
    let (base, server, task) =
        start_server_with_users(ClientIpSource::ConnectInfo, Some(users), None).await;
    let client = reqwest::Client::new();
    let mut cookies = Vec::new();
    for user in ["alice", "bob"] {
        let response = client
            .post(format!("{base}/_sable/auth"))
            .basic_auth(user, Some("password"))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), reqwest::StatusCode::NO_CONTENT);
        cookies.push(
            response.headers()[reqwest::header::SET_COOKIE]
                .to_str()
                .unwrap()
                .split(';')
                .next()
                .unwrap()
                .to_owned(),
        );
    }
    let denied = client
        .get(format!("{base}/_sable/identity"))
        .header(reqwest::header::COOKIE, &cookies[1])
        .header("x-sable-user", "7c230ca2-1285-4af9-8c18-fddcc321229e")
        .send()
        .await
        .unwrap();
    assert_eq!(denied.status(), reqwest::StatusCode::FORBIDDEN);
    let url = format!("{base}/_sable/ws?user_id=7c230ca2-1285-4af9-8c18-fddcc321229e")
        .replace("http://", "ws://");
    let mut wrong_user = url.into_client_request().unwrap();
    wrong_user
        .headers_mut()
        .insert("Cookie", cookies[1].parse().unwrap());
    wrong_user
        .headers_mut()
        .insert("Origin", base.parse().unwrap());
    assert!(connect_async(wrong_user).await.is_err());
    let mut alice = connect(&base, &cookies[0], "").await;
    let mut bob = connect(&base, &cookies[1], "").await;
    let alice_run = receive_json(&mut alice).await["server"]["run_id"]
        .as_str()
        .unwrap()
        .to_owned();
    let bob_run = receive_json(&mut bob).await["server"]["run_id"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_ne!(alice_run, bob_run);
    server
        .core()
        .emit(sable_core::protocol::CoreEvent::SessionEnded {
            reason: "legacy only".into(),
        });
    assert!(
        tokio::time::timeout(Duration::from_millis(100), alice.next())
            .await
            .is_err()
    );
    assert!(
        tokio::time::timeout(Duration::from_millis(100), bob.next())
            .await
            .is_err()
    );
    let mut resumed = connect(
        &base,
        &cookies[1],
        &format!("?run_id={alice_run}&last_received_event=0"),
    )
    .await;
    receive_json(&mut resumed).await;
    assert_eq!(receive_json(&mut resumed).await["reset"], true);
    task.abort();
}

#[tokio::test]
async fn logout_closes_only_the_associated_websocket() {
    let (base, _, task) = start_server().await;
    let first_cookie = cookie(&base).await;
    let second_cookie = cookie(&base).await;
    let mut first = connect(&base, &first_cookie, "").await;
    let mut second = connect(&base, &second_cookie, "").await;
    receive_json(&mut first).await;
    receive_json(&mut second).await;
    let response = reqwest::Client::new()
        .post(format!("{base}/_sable/logout"))
        .header(reqwest::header::COOKIE, first_cookie)
        .header(reqwest::header::ORIGIN, &base)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), reqwest::StatusCode::NO_CONTENT);
    let closed = tokio::time::timeout(Duration::from_secs(2), first.next())
        .await
        .unwrap();
    assert!(matches!(
        closed,
        None | Some(Ok(Message::Close(_)) | Err(_))
    ));
    second
        .send(Message::Text(
            json!({"id": 99, "method": "session.list_accounts", "params": {}})
                .to_string()
                .into(),
        ))
        .await
        .unwrap();
    assert_eq!(receive_json(&mut second).await["id"], 99);
    task.abort();
}

#[tokio::test]
async fn logout_cancels_in_flight_upload() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let (base, _, task) = start_server().await;
    let cookie = cookie(&base).await;
    let address = base.strip_prefix("http://").unwrap();
    let mut upload = tokio::net::TcpStream::connect(address).await.unwrap();
    let headers = format!(
        "POST /_sable/upload HTTP/1.1\r\nHost: {address}\r\nOrigin: {base}\r\nCookie: {cookie}\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n4\r\ndata\r\n"
    );
    upload.write_all(headers.as_bytes()).await.unwrap();
    // Let the request enter the upload body extractor while its body remains open.
    tokio::time::sleep(Duration::from_millis(100)).await;
    let response = reqwest::Client::new()
        .post(format!("{base}/_sable/logout"))
        .header(reqwest::header::COOKIE, &cookie)
        .header(reqwest::header::ORIGIN, &base)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), reqwest::StatusCode::NO_CONTENT);
    let mut bytes = Vec::new();
    tokio::time::timeout(Duration::from_secs(3), upload.read_to_end(&mut bytes))
        .await
        .expect("upload was not cancelled")
        .unwrap();
    let response = String::from_utf8_lossy(&bytes).to_ascii_lowercase();
    assert!(response.starts_with("http/1.1 500"));
    assert!(!response.contains("set-cookie:"));
    let status = reqwest::Client::new()
        .get(format!("{base}/_sable/auth"))
        .header(reqwest::header::COOKIE, &cookie)
        .send()
        .await
        .unwrap();
    assert_eq!(status.status(), reqwest::StatusCode::UNAUTHORIZED);
    task.abort();
}

#[tokio::test]
async fn disabling_user_cancels_in_flight_upload() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let directory = tempdir().unwrap();
    let hash = "$argon2id$v=19$m=19456,t=2,p=1$P+eI2tfGQ1sd90QtbQ8wFA$Obgt2lytjJYQTynFGGi4Lu+2hlyyipgjDot5QXzqxjs";
    let mut users = json!({"users": [{"id": "7c230ca2-1285-4af9-8c18-fddcc321229e", "username": "alice", "password_hash": hash}]});
    let (base, _, task) = start_server_with_users(
        ClientIpSource::ConnectInfo,
        Some(users.clone()),
        Some(directory.path().to_owned()),
    )
    .await;
    let response = reqwest::Client::new()
        .post(format!("{base}/_sable/auth"))
        .basic_auth("alice", Some("password"))
        .send()
        .await
        .unwrap();
    let cookie = response.headers()[reqwest::header::SET_COOKIE]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap();
    let address = base.strip_prefix("http://").unwrap();
    let mut upload = tokio::net::TcpStream::connect(address).await.unwrap();
    let headers = format!(
        "POST /_sable/upload HTTP/1.1\r\nHost: {address}\r\nOrigin: {base}\r\nCookie: {cookie}\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n4\r\ndata\r\n"
    );
    upload.write_all(headers.as_bytes()).await.unwrap();
    tokio::time::sleep(Duration::from_millis(100)).await;
    users["users"][0]["disabled"] = json!(true);
    std::fs::write(directory.path().join("users.json"), users.to_string()).unwrap();
    let mut bytes = Vec::new();
    tokio::time::timeout(Duration::from_secs(5), upload.read_to_end(&mut bytes))
        .await
        .expect("disabled user's upload was not cancelled")
        .unwrap();
    assert!(String::from_utf8_lossy(&bytes).starts_with("HTTP/1.1 401"));
    task.abort();
}

#[tokio::test]
async fn http_request_limit_is_per_user_and_does_not_block_logout() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let hash = "$argon2id$v=19$m=19456,t=2,p=1$P+eI2tfGQ1sd90QtbQ8wFA$Obgt2lytjJYQTynFGGi4Lu+2hlyyipgjDot5QXzqxjs";
    let users = json!({"users": [{"id": "7c230ca2-1285-4af9-8c18-fddcc321229e", "username": "alice", "password_hash": hash}]});
    let (base, _, task) =
        start_server_with_users(ClientIpSource::ConnectInfo, Some(users), None).await;
    let client = reqwest::Client::new();
    let login = client
        .post(format!("{base}/_sable/auth"))
        .basic_auth("alice", Some("password"))
        .send()
        .await
        .unwrap();
    let alice = login.headers()[reqwest::header::SET_COOKIE]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_owned();
    let legacy = cookie(&base).await;
    let address = base.strip_prefix("http://").unwrap();
    let mut pending = Vec::new();
    for _ in 0..16 {
        let mut stream = tokio::net::TcpStream::connect(address).await.unwrap();
        let headers = format!(
            "POST /_sable/media/forget HTTP/1.1\r\nHost: {address}\r\nOrigin: {base}\r\nCookie: {alice}\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n1\r\n{{\r\n"
        );
        stream.write_all(headers.as_bytes()).await.unwrap();
        pending.push(stream);
    }
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            let response = client
                .get(format!("{base}/_sable/identity"))
                .header(reqwest::header::COOKIE, &alice)
                .send()
                .await
                .unwrap();
            if response.status() == reqwest::StatusCode::TOO_MANY_REQUESTS {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("request quota was not reached");
    let other = client
        .get(format!("{base}/_sable/identity"))
        .header(reqwest::header::COOKIE, &legacy)
        .send()
        .await
        .unwrap();
    assert_eq!(other.status(), reqwest::StatusCode::OK);
    let logout = client
        .post(format!("{base}/_sable/logout"))
        .header(reqwest::header::COOKIE, &alice)
        .header(reqwest::header::ORIGIN, &base)
        .send()
        .await
        .unwrap();
    assert_eq!(logout.status(), reqwest::StatusCode::NO_CONTENT);
    for mut stream in pending {
        let mut bytes = Vec::new();
        tokio::time::timeout(Duration::from_secs(3), stream.read_to_end(&mut bytes))
            .await
            .unwrap()
            .unwrap();
        assert!(String::from_utf8_lossy(&bytes).starts_with("HTTP/1.1 500"));
    }
    task.abort();
}

#[tokio::test]
async fn logout_cancels_in_flight_websocket_rpc() {
    use tokio::io::AsyncReadExt;

    let (base, _, task) = start_server().await;
    let first_cookie = cookie(&base).await;
    let second_cookie = cookie(&base).await;
    let mut first = connect(&base, &first_cookie, "").await;
    let mut second = connect(&base, &second_cookie, "").await;
    receive_json(&mut first).await;
    receive_json(&mut second).await;
    let upstream = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let homeserver = format!("http://{}", upstream.local_addr().unwrap());
    first
        .send(Message::Text(
            json!({
                "id": 1, "method": "auth.login_flows", "params": {"homeserver": homeserver}
            })
            .to_string()
            .into(),
        ))
        .await
        .unwrap();
    let (mut stalled, _) = tokio::time::timeout(Duration::from_secs(3), upstream.accept())
        .await
        .unwrap()
        .unwrap();
    let mut buffer = [0u8; 4096];
    assert!(
        tokio::time::timeout(Duration::from_secs(3), stalled.read(&mut buffer))
            .await
            .unwrap()
            .unwrap()
            > 0
    );
    let response = reqwest::Client::new()
        .post(format!("{base}/_sable/logout"))
        .header(reqwest::header::COOKIE, first_cookie)
        .header(reqwest::header::ORIGIN, &base)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), reqwest::StatusCode::NO_CONTENT);
    let closed = tokio::time::timeout(Duration::from_secs(3), first.next())
        .await
        .unwrap();
    assert!(matches!(
        closed,
        None | Some(Ok(Message::Close(_)) | Err(_))
    ));
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(3), stalled.read(&mut buffer))
            .await
            .unwrap()
            .unwrap(),
        0
    );
    second
        .send(Message::Text(
            json!({"id": 2, "method": "session.list_accounts", "params": {}})
                .to_string()
                .into(),
        ))
        .await
        .unwrap();
    assert_eq!(receive_json(&mut second).await["id"], 2);
    task.abort();
}

#[tokio::test]
async fn rpc_limit_is_per_user() {
    let hash = "$argon2id$v=19$m=19456,t=2,p=1$P+eI2tfGQ1sd90QtbQ8wFA$Obgt2lytjJYQTynFGGi4Lu+2hlyyipgjDot5QXzqxjs";
    let users = json!({"users": [{"id": "7c230ca2-1285-4af9-8c18-fddcc321229e", "username": "alice", "password_hash": hash}]});
    let (base, _, task) =
        start_server_with_users(ClientIpSource::ConnectInfo, Some(users), None).await;
    let response = reqwest::Client::new()
        .post(format!("{base}/_sable/auth"))
        .basic_auth("alice", Some("password"))
        .send()
        .await
        .unwrap();
    let alice_cookie = response.headers()[reqwest::header::SET_COOKIE]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap();
    let mut alice = connect(&base, alice_cookie, "").await;
    receive_json(&mut alice).await;
    let mut legacy = connect(&base, &cookie(&base).await, "").await;
    receive_json(&mut legacy).await;
    let upstream = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let homeserver = format!("http://{}", upstream.local_addr().unwrap());
    for id in 0..16 {
        alice.send(Message::Text(json!({"id": id, "method": "auth.login_flows", "params": {"homeserver": homeserver}}).to_string().into())).await.unwrap();
    }
    let mut pending = Vec::new();
    for _ in 0..16 {
        let (connection, _) = tokio::time::timeout(Duration::from_secs(5), upstream.accept())
            .await
            .unwrap()
            .unwrap();
        pending.push(connection);
    }
    alice
        .send(Message::Text(
            json!({"id": 16, "method": "session.list_accounts", "params": {}})
                .to_string()
                .into(),
        ))
        .await
        .unwrap();
    let limited = receive_json(&mut alice).await;
    assert_eq!(limited["id"], 16);
    assert_eq!(limited["error"]["code"], "rate_limited");
    legacy
        .send(Message::Text(
            json!({"id": 17, "method": "session.list_accounts", "params": {}})
                .to_string()
                .into(),
        ))
        .await
        .unwrap();
    assert_eq!(receive_json(&mut legacy).await["id"], 17);
    drop(pending);
    task.abort();
}

#[tokio::test]
async fn upload_limit_is_per_user() {
    use tokio::io::AsyncWriteExt;

    let hash = "$argon2id$v=19$m=19456,t=2,p=1$P+eI2tfGQ1sd90QtbQ8wFA$Obgt2lytjJYQTynFGGi4Lu+2hlyyipgjDot5QXzqxjs";
    let users = json!({"users": [{"id": "7c230ca2-1285-4af9-8c18-fddcc321229e", "username": "alice", "password_hash": hash}]});
    let (base, _, task) =
        start_server_with_users(ClientIpSource::ConnectInfo, Some(users), None).await;
    let client = reqwest::Client::new();
    let response = client
        .post(format!("{base}/_sable/auth"))
        .basic_auth("alice", Some("password"))
        .send()
        .await
        .unwrap();
    let alice = response.headers()[reqwest::header::SET_COOKIE]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap();
    let legacy = cookie(&base).await;
    let address = base.strip_prefix("http://").unwrap();
    let mut pending = Vec::new();
    for _ in 0..2 {
        let mut stream = tokio::net::TcpStream::connect(address).await.unwrap();
        let headers = format!(
            "POST /_sable/upload HTTP/1.1\r\nHost: {address}\r\nOrigin: {base}\r\nCookie: {alice}\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n4\r\ndata\r\n"
        );
        stream.write_all(headers.as_bytes()).await.unwrap();
        pending.push(stream);
    }
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            let response = client
                .post(format!("{base}/_sable/upload"))
                .header(reqwest::header::COOKIE, alice)
                .header(reqwest::header::ORIGIN, &base)
                .body("data")
                .send()
                .await
                .unwrap();
            if response.status() == reqwest::StatusCode::TOO_MANY_REQUESTS {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("upload quota was not reached");
    let other = client
        .post(format!("{base}/_sable/upload"))
        .header(reqwest::header::COOKIE, legacy)
        .header(reqwest::header::ORIGIN, &base)
        .body("data")
        .send()
        .await
        .unwrap();
    assert_ne!(other.status(), reqwest::StatusCode::TOO_MANY_REQUESTS);
    drop(pending);
    task.abort();
}

#[tokio::test]
async fn disabling_user_blocks_existing_socket_and_session() {
    let directory = tempdir().unwrap();
    let id = "7c230ca2-1285-4af9-8c18-fddcc321229e";
    let hash = "$argon2id$v=19$m=19456,t=2,p=1$P+eI2tfGQ1sd90QtbQ8wFA$Obgt2lytjJYQTynFGGi4Lu+2hlyyipgjDot5QXzqxjs";
    let mut users = json!({"users": [{"id": id, "username": "alice", "password_hash": hash}]});
    let (base, _, task) = start_server_with_users(
        ClientIpSource::ConnectInfo,
        Some(users.clone()),
        Some(directory.path().to_owned()),
    )
    .await;
    let response = reqwest::Client::new()
        .post(format!("{base}/_sable/auth"))
        .basic_auth("alice", Some("password"))
        .send()
        .await
        .unwrap();
    let cookie = response.headers()[reqwest::header::SET_COOKIE]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_owned();
    let mut socket = connect(&base, &cookie, "").await;
    receive_json(&mut socket).await;
    users["users"][0]["disabled"] = json!(true);
    std::fs::write(directory.path().join("users.json"), users.to_string()).unwrap();
    let closed = tokio::time::timeout(Duration::from_secs(5), socket.next())
        .await
        .unwrap();
    assert!(matches!(
        closed,
        None | Some(Ok(Message::Close(_)) | Err(_))
    ));
    let status = reqwest::Client::new()
        .get(format!("{base}/_sable/auth"))
        .header(reqwest::header::COOKIE, cookie)
        .send()
        .await
        .unwrap();
    assert_eq!(status.status(), reqwest::StatusCode::UNAUTHORIZED);
    task.abort();
}

#[tokio::test]
async fn connection_limit_is_per_user() {
    let hash = "$argon2id$v=19$m=19456,t=2,p=1$P+eI2tfGQ1sd90QtbQ8wFA$Obgt2lytjJYQTynFGGi4Lu+2hlyyipgjDot5QXzqxjs";
    let users = json!({"users": [{"id": "7c230ca2-1285-4af9-8c18-fddcc321229e", "username": "alice", "password_hash": hash}]});
    let (base, _, task) =
        start_server_with_users(ClientIpSource::ConnectInfo, Some(users), None).await;
    let response = reqwest::Client::new()
        .post(format!("{base}/_sable/auth"))
        .basic_auth("alice", Some("password"))
        .send()
        .await
        .unwrap();
    let alice_cookie = response.headers()[reqwest::header::SET_COOKIE]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_owned();
    let mut sockets = Vec::new();
    for _ in 0..16 {
        sockets.push(connect(&base, &alice_cookie, "").await);
    }
    let url = format!("{base}/_sable/ws").replace("http://", "ws://");
    let mut request = url.into_client_request().unwrap();
    request
        .headers_mut()
        .insert("Cookie", alice_cookie.parse().unwrap());
    request
        .headers_mut()
        .insert("Origin", base.parse().unwrap());
    assert!(connect_async(request).await.is_err());
    let legacy_cookie = cookie(&base).await;
    let mut legacy = connect(&base, &legacy_cookie, "").await;
    assert_eq!(
        receive_json(&mut legacy).await["server"]["user_id"],
        "legacy"
    );
    drop(sockets);
    task.abort();
}
