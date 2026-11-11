use std::{
    net::SocketAddr,
    sync::{Arc, OnceLock},
    time::Duration,
};

use antissrf::{AntiSSRFPolicy, PolicyConfigOptions};
use axum::{
    Router,
    body::Body,
    extract::State,
    http::{Request, Response, StatusCode, header},
};
use hyper_util::rt::TokioIo;

#[derive(Clone)]
struct Guard {
    policy: AntiSSRFPolicy,
    connections: Arc<tokio::sync::Semaphore>,
}

static INSTALLED: OnceLock<Vec<String>> = OnceLock::new();
static START_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Install one process-wide egress guard for every Matrix client.
pub(crate) fn install(allow: &[String]) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let _lock = START_LOCK
        .lock()
        .map_err(|_| "outbound guard lock poisoned")?;
    if let Some(installed) = INSTALLED.get() {
        return if installed == allow {
            Ok(())
        } else {
            Err("outbound policy differs from the running server".into())
        };
    }
    let mut policy = AntiSSRFPolicy::new(PolicyConfigOptions::ExternalOnlyLatest);
    let allowed: Vec<_> = allow.iter().map(String::as_str).collect();
    policy.add_allowed_addresses(&allowed)?;
    let listener = std::net::TcpListener::bind("127.0.0.1:0")?;
    listener.set_nonblocking(true)?;
    let address = listener.local_addr()?;
    let guard = Guard {
        policy,
        connections: Arc::new(tokio::sync::Semaphore::new(256)),
    };
    let (ready, wait) = std::sync::mpsc::sync_channel(1);
    std::thread::Builder::new()
        .name("sable-outbound".into())
        .spawn(move || {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build();
            let Ok(runtime) = runtime else {
                let _ = ready.send(false);
                return;
            };
            runtime.block_on(async move {
                let Ok(listener) = tokio::net::TcpListener::from_std(listener) else {
                    let _ = ready.send(false);
                    return;
                };
                let _ = ready.send(true);
                let router = Router::new().fallback(proxy).with_state(guard);
                let _ = axum::serve(listener, router).await;
            });
        })?;
    if !wait.recv()? {
        return Err("could not start outbound guard".into());
    }
    sable_core::tls::set_proxy(format!("http://{address}")).map_err(|error| error.to_string())?;
    INSTALLED
        .set(allow.to_vec())
        .map_err(|_| "outbound guard already installed")?;
    Ok(())
}

async fn proxy(State(guard): State<Guard>, mut request: Request<Body>) -> Response<Body> {
    let Ok(permit) = guard.connections.clone().try_acquire_owned() else {
        return response(StatusCode::SERVICE_UNAVAILABLE);
    };
    let connect = request.method() == hyper::Method::CONNECT;
    let uri = request.uri().clone();
    if !connect && uri.scheme_str() != Some("http") {
        return response(StatusCode::BAD_REQUEST);
    }
    let Some(authority) = uri.authority() else {
        return response(StatusCode::BAD_REQUEST);
    };
    if authority.as_str().contains('@') {
        return response(StatusCode::BAD_REQUEST);
    }
    let host = authority
        .host()
        .trim_start_matches('[')
        .trim_end_matches(']');
    let port = authority
        .port_u16()
        .unwrap_or(if connect { 443 } else { 80 });
    let Ok(Ok(addresses)) = tokio::time::timeout(
        Duration::from_secs(5),
        tokio::net::lookup_host((host, port)),
    )
    .await
    else {
        return response(StatusCode::BAD_GATEWAY);
    };
    let addresses: Vec<SocketAddr> = addresses.collect();
    let addresses_text: Vec<String> = addresses
        .iter()
        .map(|address| address.ip().to_string())
        .collect();
    let borrowed: Vec<&str> = addresses_text.iter().map(String::as_str).collect();
    let mut policy = guard.policy.clone();
    if addresses.is_empty()
        || !policy
            .is_network_connection_allowed(&borrowed)
            .unwrap_or(false)
    {
        return response(StatusCode::FORBIDDEN);
    }
    let mut upstream = None;
    for address in addresses {
        if let Ok(Ok(stream)) = tokio::time::timeout(
            Duration::from_secs(5),
            tokio::net::TcpStream::connect(address),
        )
        .await
        {
            upstream = Some(stream);
            break;
        }
    }
    let Some(stream) = upstream else {
        return response(StatusCode::BAD_GATEWAY);
    };
    if connect {
        tokio::spawn(async move {
            let _permit = permit;
            if let Ok(upgraded) = hyper::upgrade::on(&mut request).await {
                let mut client = TokioIo::new(upgraded);
                let mut stream = stream;
                let _ = tokio::io::copy_bidirectional(&mut client, &mut stream).await;
            }
        });
        return response(StatusCode::OK);
    }
    let Ok(path) = uri
        .path_and_query()
        .map_or("/", |path| path.as_str())
        .parse()
    else {
        return response(StatusCode::BAD_REQUEST);
    };
    *request.uri_mut() = path;
    request.headers_mut().remove(header::PROXY_AUTHORIZATION);
    request.headers_mut().remove(header::PROXY_AUTHENTICATE);
    let Ok((mut sender, connection)) =
        hyper::client::conn::http1::handshake(TokioIo::new(stream)).await
    else {
        return response(StatusCode::BAD_GATEWAY);
    };
    tokio::spawn(async move {
        let _permit = permit;
        let _ = connection.await;
    });
    sender.send_request(request).await.map_or_else(
        |_| response(StatusCode::BAD_GATEWAY),
        |response| response.map(Body::new),
    )
}

fn response(status: StatusCode) -> Response<Body> {
    Response::builder()
        .status(status)
        .body(Body::empty())
        .unwrap_or_else(|_| Response::new(Body::empty()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{http::header::LOCATION, routing::get};

    async fn proxy_client(allow: &[&str]) -> reqwest::Client {
        let mut policy = AntiSSRFPolicy::new(PolicyConfigOptions::ExternalOnlyLatest);
        policy.add_allowed_addresses(allow).unwrap();
        let guard = Guard {
            policy,
            connections: Arc::new(tokio::sync::Semaphore::new(8)),
        };
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, Router::new().fallback(proxy).with_state(guard))
                .await
                .unwrap();
        });
        reqwest::Client::builder()
            .proxy(reqwest::Proxy::all(format!("http://{address}")).unwrap())
            .build()
            .unwrap()
    }

    #[tokio::test]
    async fn blocks_private_targets_for_http_and_https() {
        let client = proxy_client(&[]).await;
        for url in [
            "http://127.0.0.1:9/",
            "http://localhost:9/",
            "http://[::1]:9/",
            "http://[::ffff:127.0.0.1]:9/",
        ] {
            assert_eq!(
                client.get(url).send().await.unwrap().status(),
                StatusCode::FORBIDDEN,
                "{url}"
            );
        }
        client.get("https://127.0.0.1:9/").send().await.unwrap_err();
    }

    #[tokio::test]
    async fn permits_explicit_target_but_checks_redirects() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let redirect = format!("http://127.0.0.2:{}/", address.port());
        let app = Router::new().route("/ok", get(|| async { "ok" })).route(
            "/redirect",
            get(move || {
                let redirect = redirect.clone();
                async move { (StatusCode::FOUND, [(LOCATION, redirect)]) }
            }),
        );
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let client = proxy_client(&["127.0.0.1/32"]).await;
        assert_eq!(
            client
                .get(format!("http://{address}/ok"))
                .send()
                .await
                .unwrap()
                .text()
                .await
                .unwrap(),
            "ok"
        );
        assert_eq!(
            client
                .get(format!("http://{address}/redirect"))
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::FORBIDDEN
        );
    }
}
