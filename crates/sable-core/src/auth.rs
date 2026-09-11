use std::sync::Arc;

use matrix_sdk::authentication::oauth::error::OAuthDiscoveryError;
use matrix_sdk::ruma::api::client::session::get_login_types::v3::LoginType;
use matrix_sdk::utils::UrlOrQuery;
use url::Url;

use crate::protocol::{AuthIntent, CommandErr, CommandOk};

use crate::session::{Credentials, PersistedSession};

use crate::{Core, PendingLogin};
use crate::{protocol, session};

impl Core {
    async fn reauthentication_account(
        &self,
        account_id: Option<String>,
    ) -> Result<Option<session::PersistedAccount>, CommandErr> {
        let Some(account_id) = account_id else {
            return Ok(None);
        };
        let account = self
            .accounts()
            .await?
            .accounts
            .into_iter()
            .find(|account| account.account_id == account_id && account.needs_reauth)
            .ok_or(CommandErr::NotLoggedIn)?;
        Ok(Some(account))
    }

    async fn login_client(
        &self,
        store_id: &str,
        homeserver: &str,
        account: Option<&session::PersistedAccount>,
    ) -> Result<matrix_sdk::Client, matrix_sdk::ClientBuildError> {
        match account {
            Some(account) => session::restore_client(store_id, &account.session).await,
            None => self.build_account_client(store_id, homeserver).await,
        }
    }

    async fn validate_reauthentication(
        &self,
        expected: Option<&session::PersistedAccount>,
        client: &matrix_sdk::Client,
    ) -> Result<(), CommandErr> {
        let Some(expected) = expected else {
            return Ok(());
        };
        let outcome = match self
            .reauthentication_account(Some(expected.account_id.clone()))
            .await
        {
            Err(error) => Err(error),
            Ok(None) => Err(CommandErr::NotLoggedIn),
            Ok(Some(account))
                if client.user_id().map(ToString::to_string)
                    != Some(account.session.credentials.user_id())
                    || client.device_id().map(ToString::to_string)
                        != Some(account.session.credentials.device_id()) =>
            {
                Err(CommandErr::Denied)
            }
            Ok(Some(_)) => Ok(()),
        };
        if outcome.is_err()
            && let Err(error) = client.logout().await
        {
            tracing::warn!(?error, "could not log out a rejected reauthentication");
        }
        outcome
    }

    pub(crate) async fn login(
        self: &Arc<Self>,
        homeserver: String,
        username: String,
        password: String,
        reauth_account_id: Option<String>,
    ) -> Result<CommandOk, CommandErr> {
        let reauth = self.reauthentication_account(reauth_account_id).await?;
        let homeserver = reauth
            .as_ref()
            .map_or(homeserver, |account| account.session.homeserver.clone());
        let (account_id, account_store_id) = match &reauth {
            Some(account) => (account.account_id.clone(), account.store_id.clone()),
            None => self.allocate_account().await?,
        };
        tracing::info!(
            operation = "password_login",
            homeserver,
            "building Matrix client"
        );
        let client = self
            .login_client(&account_store_id, &homeserver, reauth.as_ref())
            .await
            .map_err(|error| self.failed("build_client", error))?;
        let endpoint = client.homeserver();

        tracing::info!(
            operation = "password_login",
            homeserver,
            "requesting an authenticated session"
        );
        let username = reauth
            .as_ref()
            .map_or(username, |account| account.session.credentials.user_id());
        let mut login = client
            .matrix_auth()
            .login_username(&username, &password)
            .initial_device_display_name("Sable")
            .request_refresh_token();
        if let Some(account) = &reauth {
            login = login.device_id(&account.session.credentials.device_id());
        }
        login.await.map_err(|error| self.login_error(error))?;

        let matrix = client
            .matrix_auth()
            .session()
            .ok_or_else(|| self.failed("login", "no session after a successful login"))?;

        let user_id = matrix.meta.user_id.clone();
        self.validate_reauthentication(reauth.as_ref(), &client)
            .await?;
        let generation = self.claim_session_generation().await;
        self.persist(
            &account_id,
            &account_store_id,
            &PersistedSession {
                resolved_homeserver: Some(endpoint),
                homeserver: homeserver.clone(),
                credentials: Credentials::Password(matrix),
            },
            reauth.as_ref(),
        )
        .await?;
        tracing::info!(
            operation = "password_login",
            homeserver,
            "session persisted; starting sync"
        );
        self.start_session(client, homeserver, account_id.clone(), generation.value())
            .await?;
        self.pending_login.lock().await.take();
        self.pending_registration.lock().await.take();

        tracing::info!(operation = "password_login", "login completed");
        Ok(CommandOk::Login { user_id })
    }

    pub(crate) async fn login_flows(
        self: &Arc<Self>,
        homeserver: String,
    ) -> Result<CommandOk, CommandErr> {
        tracing::info!(
            operation = "login_flows",
            homeserver,
            "discovering sign-in methods"
        );
        let client = session::discovery_client(&homeserver)
            .await
            .map_err(|error| self.discovery_error(error))?;
        self.remember_homeserver(&homeserver, &client).await;
        let mut flows = protocol::LoginFlowsView {
            password: false,
            oidc: false,
            oidc_registration: false,
            sso: false,
            oauth_aware_preferred: false,
            sso_identity_providers: Vec::new(),
        };

        match client.matrix_auth().get_login_types().await {
            Ok(types) => {
                for flow in &types.flows {
                    match flow {
                        LoginType::Password(_) => flows.password = true,
                        LoginType::Sso(sso) => {
                            flows.sso = true;
                            flows.oauth_aware_preferred |= sso.oauth_aware_preferred;
                            flows
                                .sso_identity_providers
                                .extend(sso.identity_providers.iter().map(|provider| {
                                    protocol::SsoIdentityProviderView {
                                        id: provider.id.clone(),
                                        name: provider.name.clone(),
                                        icon: provider.icon.as_ref().map(ToString::to_string),
                                        brand: provider.brand.as_ref().and_then(|brand| {
                                            serde_json::to_value(brand)
                                                .ok()?
                                                .as_str()
                                                .map(str::to_owned)
                                        }),
                                    }
                                }));
                        }
                        _ => {}
                    }
                }
            }
            Err(error) if error.is_endpoint_not_implemented() => {
                tracing::debug!("homeserver has no legacy login flows: {error}");
            }
            Err(error) => {
                return Err(self.homeserver_http_error("login_flows: legacy", error));
            }
        }

        match client.oauth().server_metadata().await {
            Ok(metadata) => {
                flows.oidc = true;
                flows.oidc_registration = metadata.prompt_values_supported.iter().any(|prompt| {
                    matches!(
                        prompt,
                        matrix_sdk::ruma::api::client::discovery::get_authorization_server_metadata::v1::Prompt::Create
                    )
                });
            }
            Err(OAuthDiscoveryError::NotSupported) => {}
            Err(OAuthDiscoveryError::Http(error)) if !flows.password && !flows.sso => {
                return Err(self.homeserver_http_error("login_flows: oauth", error));
            }
            Err(error) if !flows.password && !flows.sso => {
                return Err(self.failed("login_flows: oauth", error));
            }
            Err(error) => tracing::debug!("OAuth login is unavailable: {error}"),
        }

        if !flows.password && !flows.sso && !flows.oidc {
            return Err(CommandErr::Unsupported);
        }

        tracing::info!(
            operation = "login_flows",
            password = flows.password,
            oidc = flows.oidc,
            sso = flows.sso,
            "sign-in methods discovered"
        );
        Ok(CommandOk::LoginFlows { flows })
    }

    /// Parked in `pending_oidc` so step 2 finishes on the same `Client`: the
    /// PKCE verifier and CSRF state live inside it and cannot be rebuilt.
    pub(crate) async fn start_oidc_login(
        self: &Arc<Self>,
        homeserver: String,
        redirect_uri: String,
        intent: AuthIntent,
        reauth_account_id: Option<String>,
    ) -> Result<CommandOk, CommandErr> {
        let reauth = self.reauthentication_account(reauth_account_id).await?;
        let homeserver = reauth
            .as_ref()
            .map_or(homeserver, |account| account.session.homeserver.clone());
        let (account_id, account_store_id) = match &reauth {
            Some(account) => (account.account_id.clone(), account.store_id.clone()),
            None => self.allocate_account().await?,
        };
        tracing::info!(operation = "oidc_login", intent = ?intent, "starting OAuth login");
        let redirect_uri = Url::parse(&redirect_uri)
            .map_err(|error| self.failed("start_oidc_login: redirect_uri", error))?;

        let client = self
            .login_client(&account_store_id, &homeserver, reauth.as_ref())
            .await
            .map_err(|error| self.failed("start_oidc_login: build_client", error))?;

        let registration = session::client_metadata(&redirect_uri).into();
        if let Some(account) = &reauth {
            if matches!(intent, AuthIntent::Register) {
                return Err(CommandErr::Denied);
            }
            if let Credentials::OAuth { client_id, .. } = &account.session.credentials {
                client.oauth().restore_registered_client(
                    matrix_sdk::authentication::oauth::ClientId::new(client_id.clone()),
                );
            }
        }
        let device_id = reauth
            .as_ref()
            .map(|account| account.session.credentials.device_id().into());

        let mut login =
            client
                .oauth()
                .login(redirect_uri.clone(), device_id, Some(registration), None);
        if let Some(account) = &reauth {
            let user_id: matrix_sdk::ruma::OwnedUserId = account
                .session
                .credentials
                .user_id()
                .parse()
                .map_err(|error| self.failed("reauth user", error))?;
            login = login.user_id_hint(&user_id);
        }
        if matches!(intent, AuthIntent::Register) {
            login = login.prompt(vec![
                matrix_sdk::ruma::api::client::discovery::get_authorization_server_metadata::v1::Prompt::Create,
            ]);
        }
        let data = login
            .build()
            .await
            .map_err(|error| self.oauth_login_error("start_oidc_login", &error))?;

        let mut authorization_url = data.url;
        authorization_url
            .query_pairs_mut()
            .append_pair("response_mode", response_mode(&redirect_uri));
        let authorization_url = authorization_url.to_string();
        let mut pending = self.pending_login.lock().await;
        if matches!(pending.as_ref(), Some(PendingLogin::Sso(_, _, _, _, _, _))) {
            return Err(CommandErr::Unavailable);
        }

        if pending.is_some() {
            tracing::warn!("replacing unfinished OIDC login with a new attempt");
        }
        *pending = Some(PendingLogin::Oidc(
            account_id,
            account_store_id,
            homeserver,
            redirect_uri,
            client,
            reauth,
        ));

        tracing::info!(
            operation = "oidc_login",
            "OAuth login ready for browser redirect"
        );
        Ok(CommandOk::StartOidcLogin { authorization_url })
    }

    pub(crate) async fn complete_oidc_login(
        self: &Arc<Self>,
        callback_url: String,
    ) -> Result<CommandOk, CommandErr> {
        tracing::info!(operation = "oidc_login", "completing OAuth login callback");
        let url = Url::parse(&callback_url)
            .map_err(|error| self.failed("complete_oidc_login: callback_url", error))?;

        let mut pending = self.pending_login.lock().await;
        let Some(PendingLogin::Oidc(_, _, _, expected_redirect_uri, client, _)) = pending.as_ref()
        else {
            tracing::warn!("no pending OIDC login: it was started elsewhere or the core restarted");
            return Err(CommandErr::Unavailable);
        };

        if !same_redirect_target(expected_redirect_uri, &url) {
            unexpected_callback("oidc_login", expected_redirect_uri, &url);
            return Err(self.failed(
                "complete_oidc_login: callback_url",
                "callback URL does not match the redirect URI used to start OAuth",
            ));
        }

        client
            .oauth()
            .finish_login(authorization_response(&url))
            .await
            .map_err(|error| self.failed("complete_oidc_login", error))?;

        let Some(PendingLogin::Oidc(account_id, account_store_id, homeserver, _, client, reauth)) =
            pending.take()
        else {
            return Err(CommandErr::Unavailable);
        };
        drop(pending);

        let full = client
            .oauth()
            .full_session()
            .ok_or_else(|| self.failed("complete_oidc_login", "no session after finish_login"))?;

        let user_id = full.user.meta.user_id.clone();
        self.validate_reauthentication(reauth.as_ref(), &client)
            .await?;
        let generation = self.claim_session_generation().await;
        self.persist(
            &account_id,
            &account_store_id,
            &PersistedSession {
                resolved_homeserver: Some(client.homeserver()),
                homeserver: homeserver.clone(),
                credentials: Credentials::oauth(full),
            },
            reauth.as_ref(),
        )
        .await?;
        self.start_session(client, homeserver, account_id.clone(), generation.value())
            .await?;
        self.pending_login.lock().await.take();
        self.pending_registration.lock().await.take();

        tracing::info!(operation = "oidc_login", "OAuth login completed");
        Ok(CommandOk::CompleteOidcLogin { user_id })
    }

    pub(crate) async fn start_sso_login(
        self: &Arc<Self>,
        homeserver: String,
        redirect_uri: String,
        idp_id: Option<String>,
        intent: AuthIntent,
        reauth_account_id: Option<String>,
    ) -> Result<CommandOk, CommandErr> {
        let reauth = self.reauthentication_account(reauth_account_id).await?;
        let homeserver = reauth
            .as_ref()
            .map_or(homeserver, |account| account.session.homeserver.clone());
        let (account_id, account_store_id) = match &reauth {
            Some(account) => (account.account_id.clone(), account.store_id.clone()),
            None => self.allocate_account().await?,
        };
        if reauth.is_some() && matches!(intent, AuthIntent::Register) {
            return Err(CommandErr::Denied);
        }
        tracing::info!(operation = "sso_login", intent = ?intent, "starting SSO login");
        let redirect_uri = Url::parse(&redirect_uri)
            .map_err(|error| self.failed("start_sso_login: redirect_uri", error))?;
        if !has_single_nonempty_query_parameter(&redirect_uri, "sable_sso_state") {
            return Err(CommandErr::Denied);
        }

        let client = self
            .login_client(&account_store_id, &homeserver, reauth.as_ref())
            .await
            .map_err(|error| self.failed("start_sso_login: build_client", error))?;

        let authorization_url = client
            .matrix_auth()
            .get_sso_login_url(redirect_uri.as_str(), idp_id.as_deref())
            .await
            .map_err(|error| self.failed("start_sso_login", error))?;

        let mut authorization_url = Url::parse(&authorization_url)
            .map_err(|error| self.failed("start_sso_login: authorization_url", error))?;
        authorization_url.query_pairs_mut().append_pair(
            "action",
            if matches!(intent, AuthIntent::Register) {
                "register"
            } else {
                "login"
            },
        );

        let mut pending = self.pending_login.lock().await;
        if pending.is_some() {
            return Err(CommandErr::Unavailable);
        }
        *pending = Some(PendingLogin::Sso(
            account_id,
            account_store_id,
            homeserver,
            redirect_uri,
            client,
            reauth,
        ));

        tracing::info!(
            operation = "sso_login",
            "SSO login ready for browser redirect"
        );
        Ok(CommandOk::StartSsoLogin {
            authorization_url: authorization_url.to_string(),
        })
    }

    pub(crate) async fn complete_sso_login(
        self: &Arc<Self>,
        callback_url: String,
    ) -> Result<CommandOk, CommandErr> {
        tracing::info!(operation = "sso_login", "completing SSO login callback");
        // The login token is single-use, so keep the client that created the
        // redirect and consume the pending flow exactly once.
        let callback_url = Url::parse(&callback_url)
            .map_err(|error| self.failed("complete_sso_login: callback_url", error))?;
        if !has_single_nonempty_query_parameter(&callback_url, "loginToken") {
            return Err(CommandErr::Denied);
        }

        let mut pending = self.pending_login.lock().await;
        let Some(PendingLogin::Sso(_, _, _, expected_redirect_uri, _, _)) = pending.as_ref() else {
            tracing::warn!("no pending SSO login: it was started elsewhere or the core restarted");
            return Err(CommandErr::Unavailable);
        };

        if !same_redirect_target(expected_redirect_uri, &callback_url) {
            unexpected_callback("sso_login", expected_redirect_uri, &callback_url);
            return Err(self.failed(
                "complete_sso_login: callback_url",
                "callback URL does not match the redirect URI used to start SSO",
            ));
        }

        let Some(PendingLogin::Sso(account_id, account_store_id, homeserver, _, client, reauth)) =
            pending.take()
        else {
            return Err(CommandErr::Unavailable);
        };
        drop(pending);

        let endpoint = client.homeserver();
        let mut login = client
            .matrix_auth()
            .login_with_sso_callback(callback_url.into())
            .map_err(|error| self.failed("complete_sso_login: callback_url", error))?
            .initial_device_display_name("Sable")
            .request_refresh_token();
        if let Some(account) = &reauth {
            login = login.device_id(&account.session.credentials.device_id());
        }
        login
            .await
            .map_err(|error| self.failed("complete_sso_login", error))?;

        let matrix = client.matrix_auth().session().ok_or_else(|| {
            self.failed("complete_sso_login", "no session after a successful login")
        })?;
        let user_id = matrix.meta.user_id.clone();

        self.validate_reauthentication(reauth.as_ref(), &client)
            .await?;
        let generation = self.claim_session_generation().await;
        self.persist(
            &account_id,
            &account_store_id,
            &PersistedSession {
                resolved_homeserver: Some(endpoint),
                homeserver: homeserver.clone(),
                credentials: Credentials::Password(matrix),
            },
            reauth.as_ref(),
        )
        .await?;
        self.start_session(client, homeserver, account_id.clone(), generation.value())
            .await?;
        self.pending_login.lock().await.take();
        self.pending_registration.lock().await.take();

        tracing::info!(operation = "sso_login", "SSO login completed");
        Ok(CommandOk::CompleteSsoLogin { user_id })
    }
}

fn response_mode(redirect_uri: &Url) -> &'static str {
    match redirect_uri.scheme() {
        "http" | "https" => "fragment",
        _ => "query",
    }
}

fn authorization_response(callback: &Url) -> UrlOrQuery {
    match callback.fragment() {
        Some(fragment) if !fragment.is_empty() => UrlOrQuery::Query(fragment.to_owned()),
        _ => UrlOrQuery::Url(callback.clone()),
    }
}

fn same_redirect_target(expected: &Url, callback: &Url) -> bool {
    if expected.scheme() != callback.scheme()
        || expected.host_str() != callback.host_str()
        || expected.port_or_known_default() != callback.port_or_known_default()
        || expected.path() != callback.path()
    {
        return false;
    }

    let returned = callback.query_pairs().collect::<Vec<_>>();
    expected.query_pairs().all(|(key, value)| {
        returned
            .iter()
            .any(|(returned_key, returned_value)| *returned_key == key && *returned_value == value)
    })
}

fn unexpected_callback(operation: &str, expected: &Url, callback: &Url) {
    let extra = authorization_response(callback)
        .query()
        .map(|query| {
            url::form_urlencoded::parse(query.as_bytes())
                .map(|(key, _)| key.into_owned())
                .collect::<Vec<_>>()
                .join(",")
        })
        .unwrap_or_default();
    tracing::warn!(
        operation,
        expected = %expected,
        callback_origin = %callback.origin().ascii_serialization(),
        callback_path = callback.path(),
        callback_parameters = extra,
        "callback URL does not match the redirect URI"
    );
}

fn has_single_nonempty_query_parameter(url: &Url, name: &str) -> bool {
    let mut values = url
        .query_pairs()
        .filter(|(key, _)| key == name)
        .map(|(_, value)| value);
    matches!(values.next(), Some(value) if !value.is_empty()) && values.next().is_none()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(not(target_family = "wasm"))]
    #[tokio::test]
    async fn password_reauthentication_reuses_account_device_and_identity() {
        use matrix_sdk::test_utils::mocks::MatrixMockServer;
        use wiremock::{
            Mock, ResponseTemplate,
            matchers::{body_partial_json, method, path},
        };
        let server = MatrixMockServer::new().await;
        server.mock_versions().ok().mount().await;
        Mock::given(method("POST"))
            .and(path("/_matrix/client/v3/login"))
            .and(body_partial_json(serde_json::json!({
                "device_id": "EXISTING", "identifier": {"user": "@alice:example.org"}
            })))
            .respond_with(ResponseTemplate::new(403).set_body_json(
                serde_json::json!({"errcode": "M_FORBIDDEN", "error": "bad password"}),
            ))
            .expect(1)
            .mount(server.server())
            .await;
        let directory = std::env::temp_dir().join(format!(
            "sable-reauth-{}",
            matrix_sdk::ruma::TransactionId::new()
        ));
        let store_id = directory.to_str().unwrap();
        let (core, _events) = Core::new(
            store_id,
            Box::new(crate::store::MemorySessionStore::default()),
        );
        let bytes = serde_json::to_vec(&serde_json::json!({
            "version": 1, "active_account_id": null, "next_account_id": 2,
            "accounts": [{"account_id": "a1", "store_id": store_id, "needs_reauth": true,
                "session": {"homeserver": "example.org", "resolved_homeserver": server.server().uri(),
                    "credentials": {"kind": "password", "user_id": "@alice:example.org", "device_id": "EXISTING", "access_token": "old"}}
            }]
        })).unwrap();
        *core.accounts.lock().await = Some(
            session::AccountRegistry::from_bytes(&bytes, store_id)
                .unwrap()
                .0,
        );
        core.login(
            "ignored.invalid".to_owned(),
            "different-user".to_owned(),
            "bad".to_owned(),
            Some("a1".to_owned()),
        )
        .await
        .expect_err("invalid credentials reject reauthentication");
        let accounts = core.accounts().await.unwrap();
        assert_eq!(accounts.accounts.len(), 1);
        assert!(accounts.accounts[0].needs_reauth);
        assert_eq!(
            accounts.accounts[0].session.credentials.device_id(),
            "EXISTING"
        );
        drop(core);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[cfg(not(target_family = "wasm"))]
    #[tokio::test]
    async fn a_login_persists_the_endpoint_it_was_built_at_not_the_advertised_one() {
        use matrix_sdk::test_utils::mocks::MatrixMockServer;
        use wiremock::{
            Mock, ResponseTemplate,
            matchers::{method, path},
        };
        let server = MatrixMockServer::new().await;
        server.mock_versions().ok().mount().await;
        Mock::given(method("POST"))
            .and(path("/_matrix/client/v3/login"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "user_id": "@alice:example.org", "device_id": "FRESH", "access_token": "token",
                "well_known": {"m.homeserver": {"base_url": "http://advertised.invalid"}}
            })))
            .mount(server.server())
            .await;
        let directory = std::env::temp_dir().join(format!(
            "sable-endpoint-{}",
            matrix_sdk::ruma::TransactionId::new()
        ));
        let store_id = directory.to_str().unwrap();
        let (core, _events) = Core::new(
            store_id,
            Box::new(crate::store::MemorySessionStore::default()),
        );

        core.login(
            server.server().uri(),
            "alice".to_owned(),
            "pw".to_owned(),
            None,
        )
        .await
        .unwrap();

        let entered = Url::parse(&server.server().uri()).unwrap();
        let live = core.session.read().await.as_ref().unwrap().client.clone();
        assert_eq!(live.homeserver().host_str(), Some("advertised.invalid"));
        let persisted = core.accounts().await.unwrap().accounts.remove(0).session;
        assert_eq!(persisted.resolved_homeserver, Some(entered.clone()));
        let restored = session::restore_client(store_id, &persisted).await.unwrap();
        assert_eq!(restored.homeserver(), entered);
        if let Some(session) = core.take_session().await {
            session.sync_service.stop().await;
        }
        drop((core, restored, live));
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[cfg(not(target_family = "wasm"))]
    #[tokio::test]
    async fn a_rejected_reauthentication_logs_the_issued_session_out() {
        use matrix_sdk::ruma::{device_id, user_id};
        use matrix_sdk::test_utils::mocks::MatrixMockServer;
        use wiremock::{
            Mock, ResponseTemplate,
            matchers::{method, path},
        };
        let server = MatrixMockServer::new().await;
        let client = server
            .client_builder()
            .logged_in_with_token(
                "fresh".to_owned(),
                user_id!("@bob:example.org").to_owned(),
                device_id!("OTHER").to_owned(),
            )
            .build()
            .await;
        Mock::given(method("POST"))
            .and(path("/_matrix/client/v3/logout"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({})))
            .expect(1)
            .mount(server.server())
            .await;
        let store_id = "reauth-logout";
        let (core, _events) = Core::new(
            store_id,
            Box::new(crate::store::MemorySessionStore::default()),
        );
        let bytes = serde_json::to_vec(&serde_json::json!({
            "version": 1, "active_account_id": null, "next_account_id": 2,
            "accounts": [{"account_id": "a1", "store_id": store_id, "needs_reauth": true,
                "session": {"homeserver": "example.org", "resolved_homeserver": server.server().uri(),
                    "credentials": {"kind": "password", "user_id": "@alice:example.org", "device_id": "EXISTING", "access_token": "old"}}
            }]
        })).unwrap();
        *core.accounts.lock().await = Some(
            session::AccountRegistry::from_bytes(&bytes, store_id)
                .unwrap()
                .0,
        );
        let account = core.accounts().await.unwrap().accounts.remove(0);

        let result = core
            .validate_reauthentication(Some(&account), &client)
            .await;

        assert!(matches!(result, Err(CommandErr::Denied)));
        server.server().verify().await;
    }

    #[test]
    fn oauth_callback_must_match_its_redirect_target() -> Result<(), url::ParseError> {
        let expected = Url::parse("https://next.sable.moe/login")?;
        let valid = Url::parse("https://next.sable.moe/login?code=secret&state=csrf")?;
        let error = Url::parse(
            "https://next.sable.moe/login?error=access_denied&error_description=no&state=csrf",
        )?;
        let issuer = Url::parse(
            "https://next.sable.moe/login?code=secret&state=csrf&iss=https%3A%2F%2Fsable.moe%2F",
        )?;
        let fragment = Url::parse("https://next.sable.moe/login#code=secret&state=csrf")?;
        let wrong_path = Url::parse("https://next.sable.moe/other?code=secret&state=csrf")?;
        let wrong_origin = Url::parse("https://attacker.invalid/login?code=secret&state=csrf")?;
        let wrong_port = Url::parse("https://next.sable.moe:8443/login?code=secret&state=csrf")?;

        for accepted in [valid, error, issuer, fragment] {
            assert!(same_redirect_target(&expected, &accepted));
        }
        for invalid in [wrong_path, wrong_origin, wrong_port] {
            assert!(!same_redirect_target(&expected, &invalid));
        }
        Ok(())
    }

    #[test]
    fn browser_redirect_uris_ask_for_a_fragment_response() -> Result<(), url::ParseError> {
        assert_eq!(
            response_mode(&Url::parse("https://next.sable.moe/login")?),
            "fragment"
        );
        assert_eq!(
            response_mode(&Url::parse("moe.sable.next:/login")?),
            "query"
        );
        assert_eq!(
            response_mode(&Url::parse("http://localhost:5173/login")?),
            "fragment"
        );
        Ok(())
    }

    #[test]
    fn a_fragment_carries_the_authorization_response() -> Result<(), url::ParseError> {
        let fragment = Url::parse("https://next.sable.moe/login#code=secret&state=csrf")?;
        let query = Url::parse("moe.sable.next:/login?code=secret&state=csrf")?;

        assert_eq!(
            authorization_response(&fragment).query(),
            Some("code=secret&state=csrf")
        );
        assert_eq!(
            authorization_response(&query).query(),
            Some("code=secret&state=csrf")
        );
        Ok(())
    }

    #[test]
    fn sso_callback_must_preserve_our_state() -> Result<(), url::ParseError> {
        let expected = Url::parse("moe.sable.next://login?sable_sso_state=expected")?;
        let valid =
            Url::parse("moe.sable.next://login?sable_sso_state=expected&loginToken=secret")?;
        let wrong_state =
            Url::parse("moe.sable.next://login?sable_sso_state=attacker&loginToken=secret")?;

        assert!(same_redirect_target(&expected, &valid));
        assert!(!same_redirect_target(&expected, &wrong_state));
        assert!(has_single_nonempty_query_parameter(
            &expected,
            "sable_sso_state"
        ));
        assert!(has_single_nonempty_query_parameter(&valid, "loginToken"));
        assert!(!has_single_nonempty_query_parameter(
            &Url::parse("moe.sable.next://login")?,
            "sable_sso_state"
        ));
        assert!(!has_single_nonempty_query_parameter(
            &Url::parse("moe.sable.next://login?sable_sso_state=")?,
            "sable_sso_state"
        ));
        assert!(!has_single_nonempty_query_parameter(
            &Url::parse("moe.sable.next://login?loginToken=one&loginToken=two")?,
            "loginToken"
        ));
        Ok(())
    }
}
