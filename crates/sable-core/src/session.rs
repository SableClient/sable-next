use std::sync::Arc;

use matrix_sdk::{
    Client, ClientBuilder,
    authentication::{
        matrix::MatrixSession,
        oauth::{
            ClientId, OAuthSession, UserSession,
            registration::{ApplicationType, ClientMetadata, Localized, OAuthGrantType},
        },
    },
    ruma::serde::Raw,
};
use matrix_sdk_ui::sync_service::SyncService;
use serde::{Deserialize, Serialize};
use url::Url;

pub struct Session {
    pub client: Client,
    pub sync_service: Arc<SyncService>,
    /// So a re-persist after a refresh writes the value we established with.
    pub homeserver: String,
    /// Logging out through the wrong auth API fails.
    pub oauth: bool,
}

/// Whatever the client holds now, which after a refresh is newer than disk.
pub fn current_session(client: &Client, homeserver: String) -> Option<PersistedSession> {
    if let Some(full) = client.oauth().full_session() {
        return Some(PersistedSession {
            homeserver,
            credentials: Credentials::oauth(full),
        });
    }

    client
        .matrix_auth()
        .session()
        .map(|matrix| PersistedSession {
            homeserver,
            credentials: Credentials::Password(matrix),
        })
}

/// The matrix API round-trips one struct. OAuth needs the registered client id
/// alongside the session, since `OAuthSession` is not serializable.
#[derive(Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Credentials {
    Password(MatrixSession),
    OAuth {
        client_id: String,
        user: UserSession,
    },
}

#[derive(Serialize, Deserialize)]
pub struct PersistedSession {
    pub homeserver: String,
    pub credentials: Credentials,
}

impl Credentials {
    pub fn oauth(session: OAuthSession) -> Self {
        Self::OAuth {
            client_id: session.client_id.as_str().to_owned(),
            user: session.user,
        }
    }

    pub fn user_id(&self) -> String {
        match self {
            Self::Password(session) => session.meta.user_id.to_string(),
            Self::OAuth { user, .. } => user.meta.user_id.to_string(),
        }
    }

    pub fn device_id(&self) -> String {
        match self {
            Self::Password(session) => session.meta.device_id.to_string(),
            Self::OAuth { user, .. } => user.meta.device_id.to_string(),
        }
    }
}

/// A filesystem path natively, an IndexedDB name on the web.
pub async fn build_client(
    store_id: &str,
    homeserver: &str,
) -> Result<Client, matrix_sdk::ClientBuildError> {
    let builder = apply_server(Client::builder(), homeserver).handle_refresh_tokens();

    #[cfg(not(target_family = "wasm"))]
    let builder = builder.sqlite_store(std::path::Path::new(store_id).join("store"), None);

    #[cfg(target_family = "wasm")]
    let builder = builder.indexeddb_store(store_id, None);

    builder.build().await
}

/// For dynamic client registration. The redirect URI must match the one handed
/// to `OAuth::login`, and a private-use scheme must be the reverse-DNS of
/// `client_uri`'s host or MAS rejects it with `invalid_redirect_uri`.
pub fn client_metadata(redirect_uri: &Url) -> Raw<ClientMetadata> {
    let loopback = matches!(
        redirect_uri.host_str(),
        Some("localhost" | "127.0.0.1" | "[::1]")
    );

    let (application_type, client_uri) = match redirect_uri.scheme() {
        // MAS rejects an http `client_uri`. A loopback http redirect is a
        // *native* client per RFC 8252, which is what a dev server is.
        "https" => (
            ApplicationType::Web,
            Url::parse(&redirect_uri.origin().ascii_serialization()).expect("origin is a url"),
        ),
        "http" if loopback => (ApplicationType::Native, canonical_client_uri()),
        "http" => (
            ApplicationType::Web,
            Url::parse(&redirect_uri.origin().ascii_serialization()).expect("origin is a url"),
        ),
        scheme => (ApplicationType::Native, reverse_dns_url(scheme)),
    };

    // RFC 8252 §7.3: a loopback redirect registers without a port, and sending
    // one is rejected (continuwuity answers `invalid_client_metadata`).
    // Authorization still uses the real URI.
    let mut registered_uri = redirect_uri.clone();
    if redirect_uri.scheme() == "http" && loopback {
        registered_uri
            .set_port(None)
            .expect("a loopback url accepts a port change");
    }

    let mut metadata = ClientMetadata::new(
        application_type,
        vec![OAuthGrantType::AuthorizationCode {
            redirect_uris: vec![registered_uri],
        }],
        Localized::new(client_uri, []),
    );
    metadata.client_name = Some(Localized::new("Sable".to_owned(), []));

    Raw::new(&metadata).expect("client metadata serializes")
}

fn canonical_client_uri() -> Url {
    Url::parse("https://next.sable.moe").expect("static url")
}

/// `moe.sable.next` -> `https://next.sable.moe`
fn reverse_dns_url(scheme: &str) -> Url {
    let host = scheme.split('.').rev().collect::<Vec<_>>().join(".");
    Url::parse(&format!("https://{host}")).expect("reversed scheme is a host")
}

pub async fn start_sync(
    client: Client,
) -> Result<Arc<SyncService>, matrix_sdk_ui::sync_service::Error> {
    let sync_service = Arc::new(SyncService::builder(client).build().await?);
    sync_service.start().await;
    Ok(sync_service)
}

pub fn oauth_session(client_id: String, user: UserSession) -> OAuthSession {
    OAuthSession {
        client_id: ClientId::new(client_id),
        user,
    }
}

pub async fn discovery_client(homeserver: &str) -> Result<Client, matrix_sdk::ClientBuildError> {
    apply_server(Client::builder(), homeserver).build().await
}

/// A scheme is no reason to skip `.well-known`: `https://example.com` is usually
/// the server *name*, delegating elsewhere.
fn apply_server(builder: ClientBuilder, homeserver: &str) -> ClientBuilder {
    builder.server_name_or_homeserver_url(homeserver)
}
