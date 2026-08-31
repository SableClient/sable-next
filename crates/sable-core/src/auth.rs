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
    pub(crate) async fn login(
        self: &Arc<Self>,
        homeserver: String,
        username: String,
        password: String,
    ) -> Result<CommandOk, CommandErr> {
        let (account_id, account_store_id) = self.allocate_account().await?;
        tracing::info!(
            operation = "password_login",
            homeserver,
            "building Matrix client"
        );
        let client = self
            .build_account_client(&account_store_id, &homeserver)
            .await
            .map_err(|error| self.failed("build_client", error))?;

        tracing::info!(
            operation = "password_login",
            homeserver,
            "requesting an authenticated session"
        );
        client
            .matrix_auth()
            .login_username(&username, &password)
            .initial_device_display_name("Sable")
            .request_refresh_token()
            .await
            .map_err(|error| self.login_error(error))?;

        let matrix = client
            .matrix_auth()
            .session()
            .ok_or_else(|| self.failed("login", "no session after a successful login"))?;

        let user_id = matrix.meta.user_id.clone();
        let mut generation = self.claim_session_generation();
        self.persist(
            &account_id,
            &account_store_id,
            &PersistedSession {
                homeserver: homeserver.clone(),
                credentials: Credentials::Password(matrix),
            },
            generation.value(),
        )
        .await?;
        tracing::info!(
            operation = "password_login",
            homeserver,
            "session persisted; starting sync"
        );
        self.start_session(client, homeserver, account_id.clone(), generation.value())
            .await?;
        self.set_active_account(&account_id).await?;
        self.pending_login.lock().await.take();
        self.pending_registration.lock().await.take();
        generation.commit();

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
    ) -> Result<CommandOk, CommandErr> {
        let (account_id, account_store_id) = self.allocate_account().await?;
        tracing::info!(operation = "oidc_login", intent = ?intent, "starting OAuth login");
        let redirect_uri = Url::parse(&redirect_uri)
            .map_err(|error| self.failed("start_oidc_login: redirect_uri", error))?;

        let client = self
            .build_account_client(&account_store_id, &homeserver)
            .await
            .map_err(|error| self.failed("start_oidc_login: build_client", error))?;

        let registration = session::client_metadata(&redirect_uri).into();

        let mut login = client
            .oauth()
            .login(redirect_uri.clone(), None, Some(registration), None);
        if matches!(intent, AuthIntent::Register) {
            login = login.prompt(vec![
                matrix_sdk::ruma::api::client::discovery::get_authorization_server_metadata::v1::Prompt::Create,
            ]);
        }
        let data = login
            .build()
            .await
            .map_err(|error| self.failed("start_oidc_login", error))?;

        let mut authorization_url = data.url;
        authorization_url
            .query_pairs_mut()
            .append_pair("response_mode", response_mode(&redirect_uri));
        let authorization_url = authorization_url.to_string();
        let mut pending = self.pending_login.lock().await;
        if matches!(pending.as_ref(), Some(PendingLogin::Sso(_, _, _, _, _))) {
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
        let Some(PendingLogin::Oidc(_, _, _, expected_redirect_uri, client)) = pending.as_ref()
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

        let Some(PendingLogin::Oidc(account_id, account_store_id, homeserver, _, client)) =
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
        let mut generation = self.claim_session_generation();
        self.persist(
            &account_id,
            &account_store_id,
            &PersistedSession {
                homeserver: homeserver.clone(),
                credentials: Credentials::oauth(full),
            },
            generation.value(),
        )
        .await?;
        self.start_session(client, homeserver, account_id.clone(), generation.value())
            .await?;
        self.set_active_account(&account_id).await?;
        self.pending_login.lock().await.take();
        self.pending_registration.lock().await.take();
        generation.commit();

        tracing::info!(operation = "oidc_login", "OAuth login completed");
        Ok(CommandOk::CompleteOidcLogin { user_id })
    }

    pub(crate) async fn start_sso_login(
        self: &Arc<Self>,
        homeserver: String,
        redirect_uri: String,
        idp_id: Option<String>,
        intent: AuthIntent,
    ) -> Result<CommandOk, CommandErr> {
        let (account_id, account_store_id) = self.allocate_account().await?;
        tracing::info!(operation = "sso_login", intent = ?intent, "starting SSO login");
        let redirect_uri = Url::parse(&redirect_uri)
            .map_err(|error| self.failed("start_sso_login: redirect_uri", error))?;
        if !has_single_nonempty_query_parameter(&redirect_uri, "sable_sso_state") {
            return Err(CommandErr::Denied);
        }

        let client = self
            .build_account_client(&account_store_id, &homeserver)
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
        let Some(PendingLogin::Sso(_, _, _, expected_redirect_uri, _)) = pending.as_ref() else {
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

        let Some(PendingLogin::Sso(account_id, account_store_id, homeserver, _, client)) =
            pending.take()
        else {
            return Err(CommandErr::Unavailable);
        };
        drop(pending);

        client
            .matrix_auth()
            .login_with_sso_callback(callback_url.into())
            .map_err(|error| self.failed("complete_sso_login: callback_url", error))?
            .initial_device_display_name("Sable")
            .request_refresh_token()
            .await
            .map_err(|error| self.failed("complete_sso_login", error))?;

        let matrix = client.matrix_auth().session().ok_or_else(|| {
            self.failed("complete_sso_login", "no session after a successful login")
        })?;
        let user_id = matrix.meta.user_id.clone();

        let mut generation = self.claim_session_generation();
        self.persist(
            &account_id,
            &account_store_id,
            &PersistedSession {
                homeserver: homeserver.clone(),
                credentials: Credentials::Password(matrix),
            },
            generation.value(),
        )
        .await?;
        self.start_session(client, homeserver, account_id.clone(), generation.value())
            .await?;
        self.set_active_account(&account_id).await?;
        self.pending_login.lock().await.take();
        self.pending_registration.lock().await.take();
        generation.commit();

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
