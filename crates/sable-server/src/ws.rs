use std::{
    sync::Arc,
    time::{Duration, Instant},
};

use axum::{
    Extension,
    body::Bytes,
    extract::{Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
};
use futures_util::{SinkExt, StreamExt};
use sable_core::protocol::RpcError;
use serde::{Deserialize, Serialize};
use serde_json::{Value, value::RawValue};
use tokio::sync::{broadcast, mpsc};
use tower_sessions::Session;

use crate::{EventRecord, Server, SessionRevocation, UserRuntime, auth_routes::unauthorized};

const MAX_WEBSOCKET_MESSAGE_SIZE: usize = 1024 * 1024;
const PING_TIMEOUT: Duration = Duration::from_secs(60);
const PING_INTERVAL: Duration = Duration::from_secs(20);
const OUTGOING_BUFFER: usize = 128;
const RESET_FRAME: &str = r#"{"reset":true}"#;

#[derive(Deserialize)]
struct Request {
    #[serde(default)]
    id: Value,
    method: Option<String>,
    #[serde(default = "empty_params")]
    params: Box<RawValue>,
}

fn empty_params() -> Box<RawValue> {
    RawValue::from_string("{}".to_owned()).unwrap_or_else(|_| RawValue::NULL.to_owned())
}

#[derive(Serialize)]
#[serde(untagged)]
enum Reply {
    Ok { id: Value, ok: Box<RawValue> },
    Error { id: Value, error: RpcError },
}

#[derive(Serialize)]
struct ServerMessage<'a> {
    server: ServerInfo<'a>,
}

#[derive(Serialize)]
struct ServerInfo<'a> {
    version: &'a str,
    run_id: &'a str,
    user_id: &'a str,
}

#[derive(Deserialize)]
pub(crate) struct ResumeQuery {
    user_id: Option<String>,
    run_id: Option<String>,
    last_received_event: Option<u64>,
}

pub(crate) async fn websocket(
    State(server): State<Server>,
    Extension(runtime): Extension<Arc<UserRuntime>>,
    session: Session,
    Query(query): Query<ResumeQuery>,
    upgrade: yawc::IncomingUpgrade,
) -> Response {
    let Some(session_id) = session.id() else {
        return unauthorized().into_response();
    };
    let Some(user_id) = server.auth.authenticate(&session).await else {
        return unauthorized().into_response();
    };
    if query
        .user_id
        .as_deref()
        .is_some_and(|expected| expected != user_id)
    {
        return StatusCode::FORBIDDEN.into_response();
    }
    let revocations = server.session_revocations.subscribe();
    let Some(connection) = server.connections.clone().try_acquire_owned().ok() else {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    };
    let Some(user_connection) = runtime.connections.clone().try_acquire_owned().ok() else {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    };
    let options = yawc::Options::default()
        .with_balanced_compression()
        .with_limits(MAX_WEBSOCKET_MESSAGE_SIZE, MAX_WEBSOCKET_MESSAGE_SIZE)
        .with_utf8();
    let Ok((response, upgrade)) = upgrade.upgrade(options) else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    tokio::spawn(async move {
        if let Ok(socket) = upgrade.await {
            handle_socket(
                socket,
                server,
                runtime,
                session_id,
                user_id,
                revocations,
                query,
                connection,
                user_connection,
            )
            .await;
        }
    });
    response.into_response()
}

#[expect(
    clippy::too_many_arguments,
    clippy::too_many_lines,
    reason = "socket owns its session, revocation state, and connection permits"
)]
async fn handle_socket(
    socket: yawc::HttpWebSocket,
    server: Server,
    runtime: Arc<UserRuntime>,
    session_id: tower_sessions::session::Id,
    user_id: String,
    mut revocations: broadcast::Receiver<SessionRevocation>,
    query: ResumeQuery,
    _connection: tokio::sync::OwnedSemaphorePermit,
    _user_connection: tokio::sync::OwnedSemaphorePermit,
) {
    let mut shutdown = server.shutdown.subscribe();
    if *shutdown.borrow() {
        return;
    }
    let valid_session = || async {
        let session = Session::new(Some(session_id), Arc::new(server.sessions.clone()), None);
        server.auth.authenticate(&session).await.as_deref() == Some(user_id.as_str())
    };
    if !valid_session().await {
        return;
    }
    let (sink, mut stream) = socket.split();
    let (outgoing, messages) = mpsc::channel(OUTGOING_BUFFER);
    let writer = tokio::spawn(write_socket(sink, messages));
    let mut receiver = {
        let greeting = greet(&server.version, &runtime, &user_id, &query, &outgoing);
        tokio::pin!(greeting);
        loop {
            tokio::select! {
                _ = shutdown.changed() => { writer.abort(); return; }
                revoked = revocations.recv() => {
                    if SessionRevocation::ends(&revoked, session_id, &user_id) {
                        writer.abort();
                        return;
                    }
                }
                result = &mut greeting => {
                    let Some(receiver) = result else { writer.abort(); return; };
                    break receiver;
                }
            }
        }
    };
    let mut ping = tokio::time::interval(PING_INTERVAL);
    ping.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    ping.tick().await;
    let mut last_received = Instant::now();
    let mut tasks = tokio::task::JoinSet::new();
    loop {
        tokio::select! {
            _ = shutdown.changed() => break,
            revoked = revocations.recv() => {
                if SessionRevocation::ends(&revoked, session_id, &user_id) { break; }
            }
            Some(_) = tasks.join_next(), if !tasks.is_empty() => {}
            message = stream.next() => {
                let Some(message) = message else { break };
                match message.opcode() {
                    yawc::OpCode::Text => {
                        if !valid_session().await { break; }
                        last_received = Instant::now();
                        let Ok(text) = std::str::from_utf8(message.payload()) else {
                            break;
                        };
                        let Ok(request) = serde_json::from_str::<Request>(text) else {
                            let reply = Reply::Error {
                                id: Value::Null,
                                error: RpcError::Failed {
                                    log_id: "invalid websocket request".to_owned(),
                                },
                            };
                            if !try_send_reply(&outgoing, &reply) {
                                break;
                            }
                            continue;
                        };
                        spawn_rpc(&server, &runtime, request, &outgoing, &mut tasks);
                    }
                    yawc::OpCode::Ping | yawc::OpCode::Pong => last_received = Instant::now(),
                    yawc::OpCode::Close => break,
                    yawc::OpCode::Binary | yawc::OpCode::Continuation => {}
                }
            }
            event = receiver.recv() => {
                match event {
                    Ok(event) => {
                        if !valid_session().await { break; }
                        if outgoing.try_send(yawc::Frame::text(event.message.to_string())).is_err() {
                            break;
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => {
                        let _ = outgoing.try_send(yawc::Frame::text(RESET_FRAME));
                        break;
                    }
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
            _ = ping.tick() => {
                if last_received.elapsed() > PING_TIMEOUT
                    || outgoing.try_send(yawc::Frame::ping(Bytes::new())).is_err()
                {
                    break;
                }
            }
        }
    }
    writer.abort();
    tasks.abort_all();
    while tasks.join_next().await.is_some() {}
    let _ = writer.await;
}

fn spawn_rpc(
    server: &Server,
    runtime: &UserRuntime,
    request: Request,
    outgoing: &mpsc::Sender<yawc::Frame>,
    tasks: &mut tokio::task::JoinSet<()>,
) {
    let Some(permit) = server.rpc_tasks.clone().try_acquire_owned().ok() else {
        reject_rate_limited(outgoing, request.id);
        return;
    };
    let Some(user_permit) = runtime.rpc_tasks.clone().try_acquire_owned().ok() else {
        reject_rate_limited(outgoing, request.id);
        return;
    };
    let core = runtime.core.clone();
    let outgoing = outgoing.clone();
    tasks.spawn(async move {
        let _permit = permit;
        let _user_permit = user_permit;
        let reply = if let Some(method) = request.method {
            match core.call(&method, request.params.get()).await {
                Ok(ok) => Reply::Ok { id: request.id, ok },
                Err(error) => Reply::Error {
                    id: request.id,
                    error,
                },
            }
        } else {
            Reply::Error {
                id: request.id,
                error: RpcError::Unsupported,
            }
        };
        send_reply(&outgoing, reply).await;
    });
}

fn reject_rate_limited(outgoing: &mpsc::Sender<yawc::Frame>, id: Value) {
    let reply = Reply::Error {
        id,
        error: RpcError::RateLimited {
            retry_after_ms: Some(100),
        },
    };
    try_send_reply(outgoing, &reply);
}

async fn write_socket(
    mut sink: futures_util::stream::SplitSink<yawc::HttpWebSocket, yawc::Frame>,
    mut messages: mpsc::Receiver<yawc::Frame>,
) {
    while let Some(message) = messages.recv().await {
        if sink.send(message).await.is_err() {
            break;
        }
    }
}

/// Sends the hello and what the client missed, or a reset when the gap is gone.
async fn greet(
    version: &str,
    runtime: &UserRuntime,
    user_id: &str,
    query: &ResumeQuery,
    outgoing: &mpsc::Sender<yawc::Frame>,
) -> Option<broadcast::Receiver<Arc<EventRecord>>> {
    let (receiver, replayed, reset) = runtime
        .resume_and_subscribe(query.run_id.as_deref(), query.last_received_event)
        .await;
    let hello = serde_json::to_string(&ServerMessage {
        server: ServerInfo {
            version,
            run_id: &runtime.run_id,
            user_id,
        },
    })
    .ok()?;
    if !send_text(outgoing, &hello).await {
        return None;
    }
    if reset {
        return send_text(outgoing, RESET_FRAME).await.then_some(receiver);
    }
    for event in replayed {
        if !send_text(outgoing, &event.message).await {
            return None;
        }
    }
    Some(receiver)
}

/// False once the socket's writer is gone.
async fn send_text(outgoing: &mpsc::Sender<yawc::Frame>, text: &str) -> bool {
    outgoing
        .send(yawc::Frame::text(text.to_owned()))
        .await
        .is_ok()
}

fn try_send_reply(outgoing: &mpsc::Sender<yawc::Frame>, reply: &Reply) -> bool {
    serde_json::to_string(reply)
        .is_ok_and(|message| outgoing.try_send(yawc::Frame::text(message)).is_ok())
}

async fn send_reply(outgoing: &mpsc::Sender<yawc::Frame>, reply: Reply) -> bool {
    match serde_json::to_string(&reply) {
        Ok(message) => send_text(outgoing, &message).await,
        Err(_) => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_params_default_to_an_empty_object_and_keep_explicit_null() {
        let missing: Request = serde_json::from_str(r#"{"id":1,"method":"m"}"#).unwrap();
        assert_eq!(missing.params.get(), "{}");
        let null: Request = serde_json::from_str(r#"{"id":1,"method":"m","params":null}"#).unwrap();
        assert_eq!(null.params.get(), "null");
        let given: Request =
            serde_json::from_str(r#"{"id":1,"method":"m","params":{"a": 1}}"#).unwrap();
        assert_eq!(given.params.get(), r#"{"a": 1}"#);
    }
}
