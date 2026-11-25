use crate::api::auth::AuthIntent;
use crate::api::auth::CompleteOidcLoginParams;
use crate::api::auth::CompleteSsoLoginParams;
use crate::api::auth::LoginFlowsParams;
use crate::api::auth::LoginIdentifier;
use crate::api::auth::StartOidcLoginParams;
use crate::api::auth::StartSsoLoginParams;
use std::sync::Arc;
use std::sync::atomic::Ordering;

use matrix_sdk::authentication::oauth::error::OAuthDiscoveryError;
use matrix_sdk::ruma::OwnedUserId;
use matrix_sdk::ruma::api::client::session::get_login_types::v3::LoginType;
use matrix_sdk::ruma::api::client::uiaa::{
    EmailUserIdentifier, MatrixUserIdentifier, UserIdentifier,
};
use matrix_sdk::utils::UrlOrQuery;
use std::collections::HashMap;

use tokio::sync::Mutex;
use url::Url;

use crate::ResultExt;
use crate::protocol::{RpcCode, RpcError};

use crate::session::{AccountState, Credentials, PersistedSession};

use crate::{Core, LoginMethod, PendingLogin};
use crate::{protocol, session};

#[derive(Default)]
pub(crate) struct SignInFlows {
    pub(crate) pending_login: Mutex<Option<PendingLogin>>,
    pub(crate) pending_registration:
        parking_lot::Mutex<Option<crate::registration::PendingRegistration>>,
    pub(crate) qr_flow: parking_lot::Mutex<Option<crate::qr_login::QrFlow>>,
    pub(crate) discovered_homeservers: parking_lot::Mutex<HashMap<String, Url>>,
}

impl Core {
    async fn reauthentication_account(
        self: &Arc<Self>,
        account_id: Option<String>,
    ) -> Result<Option<session::PersistedAccount>, RpcError> {
        let Some(account_id) = account_id else {
            return Ok(None);
        };
        let mut account = self
            .accounts()
            .await?
            .accounts
            .into_iter()
            .find(|account| account.account_id == account_id)
            .ok_or(RpcCode::NotLoggedIn)?;
        if account.state.usable() {
            #[cfg(not(target_family = "wasm"))]
            let retired = self.retire_unusable_login(&account).await?;
            #[cfg(target_family = "wasm")]
            let retired = false;
            if !retired {
                return Err(RpcCode::NotLoggedIn.into());
            }
            account.state = AccountState::NeedsSignIn;
        }
        if !account.state.device_gone() {
            match session::validate_saved_crypto_store(&account.store_id, &account.session).await {
                Ok(()) => {}
                Err(error) if let Some(reason) = error.invalid_reason() => {
                    tracing::warn!(reason, "reauthenticating on a new device");
                    self.require_sign_in(&account_id, true).await?;
                    account.state = AccountState::DeviceGone;
                    account.session.credentials.discard_tokens();
                }
                Err(error) => return Err(self.failed_report("reauth_crypto_store", error)),
            }
        }
        Ok(Some(account))
    }

    async fn authentication_store(
        &self,
        account: Option<&session::PersistedAccount>,
    ) -> Result<(String, String), RpcError> {
        match account {
            Some(account) if !account.state.device_gone() => {
                Ok((account.account_id.clone(), account.store_id.clone()))
            }
            _ => self.allocate_account().await,
        }
    }

    async fn login_client(
        &self,
        store_id: &str,
        homeserver: &str,
        account: Option<&session::PersistedAccount>,
    ) -> Result<matrix_sdk::Client, RpcError> {
        let client = match account {
            Some(account) if !account.state.device_gone() => {
                session::restore_client(store_id, &account.session, self.persistent_event_cache)
                    .await
            }
            _ => self.build_account_client(store_id, homeserver).await,
        }
        .map_err(|error| self.discovery_error(error))?;
        self.require_sliding_sync(&client).await?;
        Ok(client)
    }

    async fn validate_reauthentication(
        self: &Arc<Self>,
        expected: Option<&session::PersistedAccount>,
        client: &matrix_sdk::Client,
    ) -> Result<(), RpcError> {
        let Some(expected) = expected else {
            return Ok(());
        };
        let outcome = match self
            .reauthentication_account(Some(expected.account_id.clone()))
            .await
        {
            Err(error) => Err(error),
            Ok(None) => Err(RpcCode::NotLoggedIn.into()),
            Ok(Some(account))
                if client.user_id().map(ToString::to_string)
                    != Some(account.session.credentials.user_id())
                    || (!account.state.device_gone()
                        && client.device_id().map(ToString::to_string)
                            != Some(account.session.credentials.device_id()))
                    || (account.state.device_gone()
                        && client.device_id().map(ToString::to_string)
                            == Some(account.session.credentials.device_id())) =>
            {
                Err(RpcCode::Denied.into())
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
        identifier: LoginIdentifier,
        password: String,
        reauth_account_id: Option<String>,
        device_display_name: Option<String>,
    ) -> Result<OwnedUserId, RpcError> {
        let reauth = self.reauthentication_account(reauth_account_id).await?;
        let homeserver = reauth
            .as_ref()
            .map_or(homeserver, |account| account.session.homeserver.clone());
        let (account_id, account_store_id) = self.authentication_store(reauth.as_ref()).await?;
        tracing::info!(
            operation = "password_login",
            homeserver,
            "building Matrix client"
        );
        // Before the lease: the queue this waits on may itself be waiting for the lease.
        if reauth.is_some() {
            self.release_account_client(&account_id).await?;
        }
        // Held until the session starts, so no push or switch opens the store the reauthentication
        // reuses while its new client is built and signs in.
        let lease = session::store_lease(&account_store_id).await;
        let client = self
            .login_client(&account_store_id, &homeserver, reauth.as_ref())
            .await?;
        let endpoint = client.homeserver();

        tracing::info!(
            operation = "password_login",
            homeserver,
            "requesting an authenticated session"
        );
        let identifier = reauth
            .as_ref()
            .map_or(identifier, |account| LoginIdentifier::User {
                user: account.session.credentials.user_id(),
            });
        let mut login = client
            .matrix_auth()
            .login_identifier(user_identifier(identifier), &password)
            .initial_device_display_name(session::device_display_name(
                device_display_name.as_deref(),
            ));
        if let Some(account) = &reauth
            && !account.state.device_gone()
        {
            login = login.device_id(&account.session.credentials.device_id());
        }
        login.await.or_failed(self, "login")?;

        let matrix = client
            .matrix_auth()
            .session()
            .ok_or_else(|| self.failed("login", "no session after a successful login"))?;

        let user_id = matrix.meta.user_id.clone();
        self.validate_reauthentication(reauth.as_ref(), &client)
            .await?;
        self.finish_sign_in_leased(
            client,
            account_id.clone(),
            &account_store_id,
            PersistedSession {
                oauth_issuer: None,
                oauth_redirect_uri: None,
                resolved_homeserver: Some(endpoint),
                homeserver: homeserver.clone(),
                credentials: Credentials::Password(matrix),
            },
            reauth.as_ref(),
            Some(lease),
        )
        .await?;
        tracing::info!(
            operation = "password_login",
            homeserver,
            "session persisted; starting sync"
        );
        self.sign_in.pending_login.lock().await.take();
        self.sign_in.pending_registration.lock().take();

        tracing::info!(operation = "password_login", "login completed");
        Ok(user_id)
    }

    pub(crate) async fn login_flows(
        self: &Arc<Self>,
        LoginFlowsParams { homeserver }: LoginFlowsParams,
    ) -> Result<protocol::LoginFlowsView, RpcError> {
        tracing::info!(
            operation = "login_flows",
            homeserver,
            "discovering sign-in methods"
        );
        let client = session::discovery_client(&homeserver)
            .await
            .map_err(|error| self.discovery_error(error))?;
        self.remember_homeserver(&homeserver, &client);
        self.require_sliding_sync(&client).await?;
        let mut flows = protocol::LoginFlowsView {
            password: false,
            oidc: false,
            oidc_registration: false,
            qr_login: false,
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
                return Err(self.rpc_error("login_flows_legacy", &error));
            }
        }

        match client.oauth().server_metadata().await {
            Ok(metadata) => {
                flows.oidc = true;
                flows.qr_login = metadata.device_authorization_endpoint.is_some();
                flows.oidc_registration = metadata.prompt_values_supported.iter().any(|prompt| {
                    matches!(
                        prompt,
                        ruma::api::client::discovery::get_authorization_server_metadata::v1::Prompt::Create
                    )
                });
            }
            Err(OAuthDiscoveryError::NotSupported) => {}
            Err(OAuthDiscoveryError::Http(error)) if !flows.password && !flows.sso => {
                return Err(self.rpc_error("login_flows_oauth", &error));
            }
            Err(error) if !flows.password && !flows.sso => {
                return Err(self.failed_with("login_flows_oauth", &error));
            }
            Err(error) => tracing::debug!("OAuth login is unavailable: {error}"),
        }

        if !flows.password && !flows.sso && !flows.oidc {
            return Err(RpcCode::Unsupported.into());
        }

        tracing::info!(
            operation = "login_flows",
            password = flows.password,
            oidc = flows.oidc,
            sso = flows.sso,
            "sign-in methods discovered"
        );
        Ok(flows)
    }

    /// Parked in `pending_oidc` so step 2 finishes on the same `Client`: the
    /// PKCE verifier and CSRF state live inside it and cannot be rebuilt.
    pub(crate) async fn start_oidc_login(
        self: &Arc<Self>,
        StartOidcLoginParams {
            homeserver,
            redirect_uri,
            intent,
            reauth_account_id,
            device_display_name,
        }: StartOidcLoginParams,
    ) -> Result<String, RpcError> {
        let redirect_uri =
            Url::parse(&redirect_uri).or_failed(self, "start_oidc_login_redirect_uri")?;
        let mut reauth = self.reauthentication_account(reauth_account_id).await?;
        if let Some(account) = reauth.as_mut()
            && !account.state.device_gone()
            && matches!(account.session.credentials, Credentials::OAuth { .. })
            && !reuses_oauth_client(&account.session, &redirect_uri)
        {
            // The server ties the device to the client that created it.
            tracing::warn!("reauthenticating on a new device: the OAuth client cannot be reused");
            self.require_sign_in(&account.account_id, true).await?;
            account.state = AccountState::DeviceGone;
            account.session.credentials.discard_tokens();
        }
        let homeserver = reauth
            .as_ref()
            .map_or(homeserver, |account| account.session.homeserver.clone());
        let (account_id, account_store_id) = self.authentication_store(reauth.as_ref()).await?;
        tracing::info!(operation = "oidc_login", intent = ?intent, "starting OAuth login");
        if reauth.is_some() {
            self.release_account_client(&account_id).await?;
        }

        let client = self
            .login_client(&account_store_id, &homeserver, reauth.as_ref())
            .await?;

        let registration =
            session::client_metadata(&redirect_uri, device_display_name.as_deref()).into();
        if let Some(account) = &reauth {
            if matches!(intent, AuthIntent::Register) {
                return Err(RpcCode::Denied.into());
            }
            if let Credentials::OAuth { client_id, .. } = &account.session.credentials
                && reuses_oauth_client(&account.session, &redirect_uri)
            {
                client.oauth().restore_registered_client(
                    matrix_sdk::authentication::oauth::ClientId::new(client_id.clone()),
                );
            }
        }
        let device_id = reauth
            .as_ref()
            .filter(|account| !account.state.device_gone())
            .map(|account| account.session.credentials.device_id().into());

        let mut login =
            client
                .oauth()
                .login(redirect_uri.clone(), device_id, Some(registration), None);
        if let Some(account) = &reauth {
            let user_id: OwnedUserId = account
                .session
                .credentials
                .user_id()
                .parse()
                .or_failed(self, "reauth_user")?;
            login = login.user_id_hint(&user_id);
        }
        if matches!(intent, AuthIntent::Register) {
            login = login.prompt(vec![
                ruma::api::client::discovery::get_authorization_server_metadata::v1::Prompt::Create,
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
        let mut pending = self.sign_in.pending_login.lock().await;
        if pending
            .as_ref()
            .is_some_and(|pending| pending.method == LoginMethod::Sso)
        {
            return Err(RpcCode::Unavailable.into());
        }

        if pending.is_some() {
            tracing::warn!("replacing unfinished OIDC login with a new attempt");
        }
        *pending = Some(PendingLogin {
            attempt: self.next_login_attempt.fetch_add(1, Ordering::Relaxed),
            method: LoginMethod::Oidc,
            account_id,
            account_store_id,
            homeserver,
            redirect_uri,
            client,
            reauth,
        });

        tracing::info!(
            operation = "oidc_login",
            "OAuth login ready for browser redirect"
        );
        Ok(authorization_url)
    }

    pub(crate) async fn complete_oidc_login(
        self: &Arc<Self>,
        CompleteOidcLoginParams { callback_url }: CompleteOidcLoginParams,
    ) -> Result<OwnedUserId, RpcError> {
        tracing::info!(operation = "oidc_login", "completing OAuth login callback");
        let url = Url::parse(&callback_url).or_failed(self, "complete_oidc_login_callback_url")?;

        let (attempt, client) = {
            let pending = self.sign_in.pending_login.lock().await;
            let Some(PendingLogin {
                attempt,
                redirect_uri: expected_redirect_uri,
                client,
                ..
            }) = pending
                .as_ref()
                .filter(|pending| pending.method == LoginMethod::Oidc)
            else {
                tracing::warn!(
                    "no pending OIDC login: it was started elsewhere or the core restarted"
                );
                return Err(RpcCode::Unavailable.into());
            };

            if !same_redirect_target(expected_redirect_uri, &url) {
                unexpected_callback("oidc_login", expected_redirect_uri, &url);
                return Err(self.failed(
                    "complete_oidc_login_callback_url",
                    "callback URL does not match the redirect URI used to start OAuth",
                ));
            }
            (*attempt, client.clone())
        };

        // A suspension reads the pending login to close its stores, so the request must not hold it.
        let finished = client
            .oauth()
            .finish_login(authorization_response(&url))
            .await;
        let mut pending = self.sign_in.pending_login.lock().await;
        if pending
            .as_ref()
            .is_none_or(|pending| pending.attempt != attempt)
        {
            return Err(RpcCode::Unavailable.into());
        }

        if let Err(error) = finished {
            let refused = pending.take_if(|pending| {
                refuses_device(&error)
                    && matches!(&pending.reauth, Some(account) if !account.state.device_gone())
            });
            drop(pending);
            if let Some(account) = refused.and_then(|pending| pending.reauth) {
                tracing::warn!(
                    "the server refused the saved device: the next sign-in uses a new one"
                );
                self.require_sign_in(&account.account_id, true).await?;
            }
            return Err(self.rpc_error("complete_oidc_login", &error));
        }

        let Some(PendingLogin {
            account_id,
            account_store_id,
            homeserver,
            redirect_uri,
            client,
            reauth,
            ..
        }) = pending.take()
        else {
            return Err(RpcCode::Unavailable.into());
        };
        drop(pending);

        let full = client
            .oauth()
            .full_session()
            .ok_or_else(|| self.failed("complete_oidc_login", "no session after finish_login"))?;

        let user_id = full.user.meta.user_id.clone();
        self.validate_reauthentication(reauth.as_ref(), &client)
            .await?;
        let endpoint = client.homeserver();
        self.finish_sign_in(
            client,
            account_id.clone(),
            &account_store_id,
            PersistedSession {
                oauth_issuer: None,
                oauth_redirect_uri: Some(session::registration_redirect_uri(&redirect_uri)),
                resolved_homeserver: Some(endpoint),
                homeserver,
                credentials: Credentials::oauth(full),
            },
            reauth.as_ref(),
        )
        .await?;
        self.sign_in.pending_login.lock().await.take();
        self.sign_in.pending_registration.lock().take();

        tracing::info!(operation = "oidc_login", "OAuth login completed");
        Ok(user_id)
    }

    pub(crate) async fn start_sso_login(
        self: &Arc<Self>,
        StartSsoLoginParams {
            homeserver,
            redirect_uri,
            idp_id,
            intent,
            reauth_account_id,
        }: StartSsoLoginParams,
    ) -> Result<String, RpcError> {
        let reauth = self.reauthentication_account(reauth_account_id).await?;
        let homeserver = reauth
            .as_ref()
            .map_or(homeserver, |account| account.session.homeserver.clone());
        let (account_id, account_store_id) = self.authentication_store(reauth.as_ref()).await?;
        if reauth.is_some() && matches!(intent, AuthIntent::Register) {
            return Err(RpcCode::Denied.into());
        }
        tracing::info!(operation = "sso_login", intent = ?intent, "starting SSO login");
        let redirect_uri =
            Url::parse(&redirect_uri).or_failed(self, "start_sso_login_redirect_uri")?;
        if !has_single_nonempty_query_parameter(&redirect_uri, "sable_sso_state") {
            return Err(RpcCode::Denied.into());
        }

        if reauth.is_some() {
            self.release_account_client(&account_id).await?;
        }
        let client = self
            .login_client(&account_store_id, &homeserver, reauth.as_ref())
            .await?;

        let authorization_url = client
            .matrix_auth()
            .get_sso_login_url(redirect_uri.as_str(), idp_id.as_deref())
            .await
            .or_failed(self, "start_sso_login")?;

        let mut authorization_url =
            Url::parse(&authorization_url).or_failed(self, "start_sso_login_authorization_url")?;
        authorization_url.query_pairs_mut().append_pair(
            "action",
            if matches!(intent, AuthIntent::Register) {
                "register"
            } else {
                "login"
            },
        );

        let mut pending = self.sign_in.pending_login.lock().await;
        if pending.is_some() {
            return Err(RpcCode::Unavailable.into());
        }
        *pending = Some(PendingLogin {
            attempt: self.next_login_attempt.fetch_add(1, Ordering::Relaxed),
            method: LoginMethod::Sso,
            account_id,
            account_store_id,
            homeserver,
            redirect_uri,
            client,
            reauth,
        });

        tracing::info!(
            operation = "sso_login",
            "SSO login ready for browser redirect"
        );
        Ok(authorization_url.to_string())
    }

    pub(crate) async fn complete_sso_login(
        self: &Arc<Self>,
        CompleteSsoLoginParams {
            callback_url,
            device_display_name,
        }: CompleteSsoLoginParams,
    ) -> Result<OwnedUserId, RpcError> {
        tracing::info!(operation = "sso_login", "completing SSO login callback");
        // The login token is single-use, so keep the client that created the
        // redirect and consume the pending flow exactly once.
        let callback_url =
            Url::parse(&callback_url).or_failed(self, "complete_sso_login_callback_url")?;
        if !has_single_nonempty_query_parameter(&callback_url, "loginToken") {
            return Err(RpcCode::Denied.into());
        }

        let mut pending = self.sign_in.pending_login.lock().await;
        let Some(PendingLogin {
            redirect_uri: expected_redirect_uri,
            ..
        }) = pending
            .as_ref()
            .filter(|pending| pending.method == LoginMethod::Sso)
        else {
            tracing::warn!("no pending SSO login: it was started elsewhere or the core restarted");
            return Err(RpcCode::Unavailable.into());
        };

        if !same_redirect_target(expected_redirect_uri, &callback_url) {
            unexpected_callback("sso_login", expected_redirect_uri, &callback_url);
            return Err(self.failed(
                "complete_sso_login_callback_url",
                "callback URL does not match the redirect URI used to start SSO",
            ));
        }

        let Some(PendingLogin {
            account_id,
            account_store_id,
            homeserver,
            client,
            reauth,
            ..
        }) = pending.take()
        else {
            return Err(RpcCode::Unavailable.into());
        };
        drop(pending);

        let endpoint = client.homeserver();
        let mut login = client
            .matrix_auth()
            .login_with_sso_callback(callback_url.into())
            .or_failed(self, "complete_sso_login_callback_url")?
            .initial_device_display_name(session::device_display_name(
                device_display_name.as_deref(),
            ));
        if let Some(account) = &reauth
            && !account.state.device_gone()
        {
            login = login.device_id(&account.session.credentials.device_id());
        }
        login.await.or_failed(self, "complete_sso_login")?;

        let matrix = client.matrix_auth().session().ok_or_else(|| {
            self.failed("complete_sso_login", "no session after a successful login")
        })?;
        let user_id = matrix.meta.user_id.clone();

        self.validate_reauthentication(reauth.as_ref(), &client)
            .await?;
        self.finish_sign_in(
            client,
            account_id.clone(),
            &account_store_id,
            PersistedSession {
                oauth_issuer: None,
                oauth_redirect_uri: None,
                resolved_homeserver: Some(endpoint),
                homeserver,
                credentials: Credentials::Password(matrix),
            },
            reauth.as_ref(),
        )
        .await?;
        self.sign_in.pending_login.lock().await.take();
        self.sign_in.pending_registration.lock().take();

        tracing::info!(operation = "sso_login", "SSO login completed");
        Ok(user_id)
    }
}

// Browsers never send the fragment to a loopback listener.
fn response_mode(redirect_uri: &Url) -> &'static str {
    match redirect_uri.scheme() {
        _ if session::is_loopback_redirect(redirect_uri) => "query",
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

fn user_identifier(identifier: LoginIdentifier) -> UserIdentifier {
    match identifier {
        LoginIdentifier::User { user } => UserIdentifier::Matrix(MatrixUserIdentifier::new(user)),
        LoginIdentifier::Email { address } => {
            UserIdentifier::Email(EmailUserIdentifier::new(address))
        }
    }
}

fn has_single_nonempty_query_parameter(url: &Url, name: &str) -> bool {
    let mut values = url
        .query_pairs()
        .filter(|(key, _)| key == name)
        .map(|(_, value)| value);
    matches!(values.next(), Some(value) if !value.is_empty()) && values.next().is_none()
}

/// The device scope is the only one that differs between a reauthentication
/// and a login the server accepts.
fn refuses_device(error: &matrix_sdk::Error) -> bool {
    use matrix_sdk::authentication::oauth::error::{
        BasicErrorResponseType, OAuthAuthorizationCodeError, OAuthError, RequestTokenError,
    };
    let matrix_sdk::Error::OAuth(error) = error else {
        return false;
    };
    matches!(
        &**error,
        OAuthError::AuthorizationCode(OAuthAuthorizationCodeError::RequestToken(
            RequestTokenError::ServerResponse(response)
        )) if *response.error() == BasicErrorResponseType::InvalidScope
    )
}

fn reuses_oauth_client(session: &PersistedSession, redirect_uri: &Url) -> bool {
    session::registered_redirect_uri(session, redirect_uri)
        .is_some_and(|registered| registered == session::registration_redirect_uri(redirect_uri))
}

#[cfg(test)]
#[path = "auth_tests.rs"]
mod tests;
