use crate::Core;
use crate::protocol::{OpenIdTokenView, RpcCode, RpcError, UrlPreviewView};
use sable_link_preview::{
    Fetch as _, MAX_DIRECT_VIDEO_BYTES, PostMediaKind, PreviewData, Response as _, ScrapeOptions,
    TunnelFetch,
};
use serde::Deserialize;
use std::time::Duration;
use tokio::sync::Mutex;
use web_time::Instant;

const USER_AGENT: &str = concat!(
    "Sable/",
    env!("SABLE_APP_VERSION"),
    " (link preview; +https://sable.moe)"
);

const MAX_IMAGE_BYTES: usize = 20 * 1024 * 1024;

const MAX_SCRAPED_MEDIA: usize = 512;

const REFRESH_MARGIN: Duration = Duration::from_secs(60);

struct Session {
    service: String,
    expires: Instant,
    fetch: TunnelFetch,
}

#[derive(Default)]
struct State {
    openid: Option<(OpenIdTokenView, Instant)>,
    session: Option<Session>,
}

struct ScrapedMedia {
    cap: usize,
    service: String,
}

pub(crate) struct Tunnel {
    state: Mutex<State>,
    /// Only these are fetched, so an event naming a web URL as its media cannot make the
    /// client load it.
    scraped: parking_lot::Mutex<hashlink::LruCache<String, ScrapedMedia>>,
}

impl Tunnel {
    pub(crate) fn new() -> Self {
        Self {
            state: Mutex::new(State::default()),
            scraped: parking_lot::Mutex::new(hashlink::LruCache::new(MAX_SCRAPED_MEDIA)),
        }
    }
}

#[derive(Deserialize)]
struct TicketAnswer {
    ticket: String,
    expires_in_ms: u64,
}

enum Ticket {
    Granted(TicketAnswer),
    Refused { token_rejected: bool },
}

fn relay_url(service: &str) -> Option<url::Url> {
    let mut relay = url::Url::parse(service).ok()?;
    relay
        .set_scheme(match relay.scheme() {
            "https" => "wss",
            "http" => "ws",
            _ => return None,
        })
        .ok()?;
    relay.set_path("/_soliditas/tunnel");
    relay.set_query(None);
    Some(relay)
}

async fn request_ticket(service: &str, token: &OpenIdTokenView) -> Result<Ticket, RpcError> {
    let endpoint = format!("{}/_soliditas/tunnel_ticket", service.trim_end_matches('/'));
    let response = crate::link_previews::service_client()?
        .post(endpoint)
        .header("content-type", "application/json")
        .body(
            serde_json::json!({
                "access_token": token.access_token,
                "matrix_server_name": token.matrix_server_name,
                "expires_in": token.expires_in_ms / 1000,
            })
            .to_string(),
        )
        .send()
        .await
        .map_err(|error| {
            tracing::warn!("tunnel ticket failed: {}", error.without_url());
            RpcCode::Unavailable
        })?;
    let status = response.status();
    if status.is_success() {
        let body = response.bytes().await.map_err(|error| {
            crate::errors::coded("tunnel_ticket_body", RpcCode::Unavailable, &error)
        })?;
        return serde_json::from_slice(&body)
            .map(Ticket::Granted)
            .map_err(|error| {
                crate::errors::coded("tunnel_ticket_body", RpcCode::Unavailable, &error)
            });
    }
    tracing::info!("tunnel ticket answered {status}");
    Ok(Ticket::Refused {
        token_rejected: status == matrix_sdk::reqwest::StatusCode::UNAUTHORIZED,
    })
}

impl Core {
    /// The relay client for the current ticket, `None` when the service withholds one.
    /// Holding the lock while asking keeps a single ticket request in flight.
    async fn tunnel_fetch(&self, service: &str) -> Result<Option<TunnelFetch>, RpcError> {
        let Some(relay) = relay_url(service) else {
            return Ok(None);
        };
        let mut state = self.tunnel.state.lock().await;
        if let Some(session) = &state.session
            && session.service == service
            && session.expires > Instant::now() + REFRESH_MARGIN
        {
            return Ok(Some(session.fetch.clone()));
        }
        state.session = None;

        let token = match &state.openid {
            Some((token, expires)) if *expires > Instant::now() + REFRESH_MARGIN => token.clone(),
            _ => {
                let token = self.openid_token().await?;
                state.openid = Some((
                    token.clone(),
                    Instant::now() + Duration::from_millis(token.expires_in_ms),
                ));
                token
            }
        };
        let granted = match request_ticket(service, &token).await? {
            Ticket::Granted(granted) => granted,
            Ticket::Refused { token_rejected } => {
                if token_rejected {
                    state.openid = None;
                }
                return Ok(None);
            }
        };
        let fetch = TunnelFetch::new(relay, granted.ticket, USER_AGENT.to_owned());
        state.session = Some(Session {
            service: service.to_owned(),
            expires: Instant::now() + Duration::from_millis(granted.expires_in_ms),
            fetch: fetch.clone(),
        });
        Ok(Some(fetch))
    }

    pub(crate) async fn tunnel_preview(
        &self,
        service: &str,
        url: &str,
    ) -> Result<Option<UrlPreviewView>, RpcError> {
        let Some(target) = sable_link_preview::parse_public_url(url, None) else {
            return Ok(None);
        };
        let Some(fetch) = self.tunnel_fetch(service).await? else {
            return Ok(None);
        };
        let Some(preview) =
            sable_link_preview::scrape(&fetch, &target, &ScrapeOptions::default()).await
        else {
            return Ok(None);
        };
        {
            let video_cap = usize::try_from(MAX_DIRECT_VIDEO_BYTES).unwrap_or(usize::MAX);
            let mut scraped = self.tunnel.scraped.lock();
            for (media, kind) in preview.media_urls() {
                let cap = match kind {
                    PostMediaKind::Image => MAX_IMAGE_BYTES,
                    PostMediaKind::Video | PostMediaKind::Gif => video_cap,
                };
                scraped.insert(
                    media.into(),
                    ScrapedMedia {
                        cap,
                        service: service.to_owned(),
                    },
                );
            }
        }
        let data = serde_json::Value::Object(preview.to_matrix(ToString::to_string));
        Ok(PreviewData::read(&data)
            .and_then(|data| crate::link_previews::preview_view(url.to_owned(), &data, |_| true)))
    }

    /// `None` for anything a tunnel scrape never handed out.
    pub(crate) async fn tunnel_media(
        &self,
        source: &str,
        limit: usize,
    ) -> Option<Result<Vec<u8>, RpcError>> {
        let (cap, service) = {
            let mut scraped = self.tunnel.scraped.lock();
            let known = scraped.get(source)?;
            (known.cap, known.service.clone())
        };
        Some(self.tunnel_download(&service, source, limit.min(cap)).await)
    }

    async fn tunnel_download(
        &self,
        service: &str,
        source: &str,
        limit: usize,
    ) -> Result<Vec<u8>, RpcError> {
        let url = url::Url::parse(source).map_err(|_| RpcCode::InvalidMedia)?;
        let fetch = self
            .tunnel_fetch(service)
            .await?
            .ok_or(RpcCode::Unavailable)?;
        let response = fetch
            .get(&url, "image/*,video/*;q=0.9,*/*;q=0.5")
            .await
            .ok_or(RpcCode::Unavailable)?;
        let body = response
            .body(limit.saturating_add(1))
            .await
            .ok_or(RpcCode::Unavailable)?;
        if body.is_empty() || body.len() > limit {
            return Err(RpcCode::InvalidMedia.into());
        }
        Ok(body)
    }
}

#[cfg(test)]
mod tests {
    use super::{ScrapedMedia, relay_url};
    use crate::Core;
    use matrix_sdk::test_utils::mocks::MatrixMockServer;
    use serde_json::json;
    use std::sync::Arc;
    use wiremock::{
        Mock, MockServer, ResponseTemplate,
        matchers::{body_json, method, path, path_regex},
    };

    async fn core_with_openid(openid_calls: u64) -> (MatrixMockServer, Arc<Core>) {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;
        Mock::given(method("POST"))
            .and(path_regex(
                "/_matrix/client/v3/user/.*/openid/request_token",
            ))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "access_token": "openid", "token_type": "Bearer",
                "matrix_server_name": "example.org", "expires_in": 3600
            })))
            .expect(openid_calls)
            .mount(server.server())
            .await;
        let (core, _events) = crate::test_support::signed_in_core(&server, client).await;
        (server, core)
    }

    /// Its tunnel endpoint is no WebSocket, so the relay handshake fails.
    async fn ticket_service(status: u16, expires_in_ms: u64, calls: u64) -> MockServer {
        let service = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/_soliditas/tunnel_ticket"))
            .and(body_json(json!({
                "access_token": "openid",
                "matrix_server_name": "example.org",
                "expires_in": 3600
            })))
            .respond_with(
                ResponseTemplate::new(status)
                    .set_body_json(json!({"ticket": "jwt", "expires_in_ms": expires_in_ms})),
            )
            .expect(calls)
            .mount(&service)
            .await;
        Mock::given(path("/_soliditas/preview_url"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({"og:title": "Hi"})))
            .expect(0)
            .mount(&service)
            .await;
        service
    }

    #[test]
    fn the_relay_is_the_service_host_over_a_websocket() {
        assert_eq!(
            relay_url("https://preview.example.org/base?x=1")
                .unwrap()
                .as_str(),
            "wss://preview.example.org/_soliditas/tunnel"
        );
        assert_eq!(
            relay_url("http://127.0.0.1:8080").unwrap().as_str(),
            "ws://127.0.0.1:8080/_soliditas/tunnel"
        );
        assert!(relay_url("ftp://preview.example.org").is_none());
    }

    #[tokio::test]
    async fn a_ticket_is_reused_until_shortly_before_it_expires() {
        let (_server, core) = core_with_openid(1).await;
        let service = ticket_service(200, 600_000, 1).await;
        for _ in 0..3 {
            let preview = core
                .tunnel_preview(&service.uri(), "https://example.org/")
                .await
                .unwrap();
            assert!(preview.is_none());
        }
    }

    #[tokio::test]
    async fn a_ticket_about_to_expire_is_replaced() {
        let (_server, core) = core_with_openid(1).await;
        let service = ticket_service(200, 1_000, 2).await;
        for _ in 0..2 {
            core.tunnel_preview(&service.uri(), "https://example.org/")
                .await
                .unwrap();
        }
    }

    #[tokio::test]
    async fn a_rejected_openid_token_is_requested_again() {
        let (_server, core) = core_with_openid(2).await;
        let service = ticket_service(401, 600_000, 2).await;
        for _ in 0..2 {
            let preview = core
                .tunnel_preview(&service.uri(), "https://example.org/")
                .await
                .unwrap();
            assert!(preview.is_none());
        }
    }

    #[tokio::test]
    async fn a_service_without_a_tunnel_gives_no_preview() {
        let (_server, core) = core_with_openid(1).await;
        let service = ticket_service(404, 600_000, 1).await;
        let preview = core
            .tunnel_preview(&service.uri(), "https://example.org/")
            .await
            .unwrap();
        assert!(preview.is_none());
    }

    #[tokio::test]
    async fn an_unreachable_relay_gives_no_preview_and_never_asks_the_service() {
        let (_server, core) = core_with_openid(1).await;
        let service = ticket_service(200, 600_000, 1).await;
        let preview = core
            .tunnel_preview(&service.uri(), "https://example.org/")
            .await
            .unwrap();
        assert!(preview.is_none());
        let paths: Vec<_> = service
            .received_requests()
            .await
            .unwrap()
            .iter()
            .map(|request| request.url.path().to_owned())
            .collect();
        assert_eq!(paths, ["/_soliditas/tunnel_ticket", "/_soliditas/tunnel"]);
    }

    #[tokio::test]
    async fn only_media_a_scrape_handed_out_is_fetched() {
        let (_server, core) = core_with_openid(0).await;
        core.tunnel.scraped.lock().insert(
            "https://cdn.example/known.png".to_owned(),
            ScrapedMedia {
                cap: 10,
                service: "http://127.0.0.1:1".to_owned(),
            },
        );
        for source in [
            "https://tracker.example/pixel.png",
            "mxc://example.org/media",
        ] {
            assert!(core.tunnel_media(source, usize::MAX).await.is_none());
        }
    }

    #[tokio::test]
    async fn the_media_list_forgets_the_oldest_url_first() {
        let (_server, core) = core_with_openid(0).await;
        let mut scraped = core.tunnel.scraped.lock();
        for index in 0..=super::MAX_SCRAPED_MEDIA {
            scraped.insert(
                format!("https://cdn.example/{index}.png"),
                ScrapedMedia {
                    cap: 10,
                    service: String::new(),
                },
            );
        }
        assert!(scraped.get("https://cdn.example/0.png").is_none());
        assert!(scraped.get("https://cdn.example/1.png").is_some());
    }

    #[tokio::test]
    async fn handed_out_media_fails_closed_when_the_relay_is_down() {
        let (_server, core) = core_with_openid(1).await;
        let service = ticket_service(200, 600_000, 1).await;
        core.tunnel.scraped.lock().insert(
            "https://cdn.example/a.png".to_owned(),
            ScrapedMedia {
                cap: 10,
                service: service.uri(),
            },
        );
        let media = core
            .tunnel_media("https://cdn.example/a.png", usize::MAX)
            .await;
        assert!(matches!(media, Some(Err(_))));
    }

    #[tokio::test]
    #[ignore = "needs a Soliditas at TUNNEL_SERVICE, a ticket from it in TUNNEL_TICKET, and network"]
    async fn a_page_and_its_image_arrive_through_a_real_relay() {
        let service = std::env::var("TUNNEL_SERVICE").unwrap();
        let ticket = std::env::var("TUNNEL_TICKET").unwrap();
        let (_server, core) = core_with_openid(0).await;
        let relay = relay_url(&service).unwrap();
        core.tunnel.state.lock().await.session = Some(super::Session {
            service: service.clone(),
            expires: std::time::Instant::now() + std::time::Duration::from_secs(300),
            fetch: sable_link_preview::TunnelFetch::new(
                relay,
                ticket,
                super::USER_AGENT.to_owned(),
            ),
        });

        let preview = core
            .tunnel_preview(&service, "https://github.com/SableClient/soliditas")
            .await
            .unwrap()
            .expect("a preview");
        assert!(
            preview
                .title
                .is_some_and(|title| title.contains("soliditas"))
        );
        let image = preview.image.expect("an image");
        assert!(image.starts_with("https://"), "{image}");

        let bytes = core
            .tunnel_media(&image, usize::MAX)
            .await
            .expect("handed out")
            .unwrap();
        assert!(bytes.len() > 1000, "{} bytes", bytes.len());
        assert!(
            core.tunnel_media("https://example.com/never-handed-out.png", usize::MAX)
                .await
                .is_none()
        );
    }
}
