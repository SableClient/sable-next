use crate::api::encryption::DeleteDeviceParams;
use crate::api::session::RemoveAccountParams;
use crate::api::session::SwitchAccountParams;
use crate::errors::CoreResultExt as _;
use std::sync::{Arc, atomic::Ordering};

use matrix_sdk::executor::{JoinHandleExt, spawn};

use matrix_sdk::ruma::api::client::discovery::get_authorization_server_metadata::v1::AuthorizationServerMetadata;
use matrix_sdk::ruma::api::client::uiaa::{AuthData, AuthType, Password, UserIdentifier};

use crate::ResultExt;
use crate::protocol::{CoreEvent, RpcCode, RpcError, SessionInfo};

use crate::session::AccountRegistry;
use crate::session::{AccountState, PersistedAccount, PersistedSession, Session};

use crate::Core;
use crate::cosmetics;
use crate::image_packs;
use crate::lifecycle::SessionGeneration;
use crate::search;
use crate::session;

/// The other sign-ins of a user that a new one replaces.
#[derive(Debug, Default)]
pub(crate) struct ReplacedSignIns {
    pub(crate) all: Vec<String>,
    /// Those that were usable until now.
    pub(crate) usable: Vec<String>,
}

impl Core {
    pub(crate) async fn delete_device(
        &self,
        DeleteDeviceParams {
            device_id,
            password,
        }: DeleteDeviceParams,
    ) -> Result<Option<String>, RpcError> {
        let client = self.client().await?;
        let devices = [device_id];

        if let Some(metadata) = self
            .oauth_metadata(&client, "account_management_metadata")
            .await?
        {
            return oauth_device_delete_url(&metadata, &devices[0]).map(Some);
        }

        let Err(error) = client.delete_devices(&devices, None).await else {
            return Ok(None);
        };
        let Some(uiaa) = error.as_uiaa_response() else {
            return Err(self.failed_with("delete_device", &error));
        };
        let password_only = uiaa
            .flows
            .iter()
            .any(|flow| flow.stages == [AuthType::Password]);
        let password = match password {
            Some(password) if password_only => password,
            _ => {
                return Err(RpcCode::InteractiveAuthRequired {
                    stages: uiaa
                        .flows
                        .iter()
                        .flat_map(|flow| &flow.stages)
                        .map(|stage| stage.as_str().to_owned())
                        .collect(),
                }
                .into());
            }
        };

        let user_id = client.user_id().ok_or(RpcCode::NotLoggedIn)?.to_owned();
        let mut auth = Password::new(UserIdentifier::Matrix(user_id.into()), password);
        auth.session.clone_from(&uiaa.session);
        client
            .delete_devices(&devices, Some(AuthData::Password(auth)))
            .await
            .map_err(|error| match error.as_uiaa_response() {
                Some(_) => crate::errors::coded("delete_device_auth", RpcCode::Denied, &error),
                None => self.failed_with("delete_device_auth", &error),
            })?;
        Ok(None)
    }

    pub(crate) async fn deactivate_account(
        &self,
        password: Option<String>,
    ) -> Result<Option<String>, RpcError> {
        let client = self.client().await?;

        if client.oauth().full_session().is_some()
            && let Some(metadata) = self
                .oauth_metadata(&client, "deactivate_account_metadata")
                .await?
        {
            return oauth_account_deactivate_url(&metadata).map(Some);
        }

        let account = client.account();
        let Err(error) = account.deactivate(None, None, false).await else {
            return Ok(None);
        };
        let Some(uiaa) = error.as_uiaa_response() else {
            return Err(self.failed_with("deactivate_account", &error));
        };
        let password_only = uiaa
            .flows
            .iter()
            .any(|flow| flow.stages == [AuthType::Password]);
        let password = match password {
            Some(password) if password_only => password,
            _ => {
                return Err(RpcCode::InteractiveAuthRequired {
                    stages: uiaa
                        .flows
                        .iter()
                        .flat_map(|flow| &flow.stages)
                        .map(|stage| stage.as_str().to_owned())
                        .collect(),
                }
                .into());
            }
        };

        let user_id = client.user_id().ok_or(RpcCode::NotLoggedIn)?.to_owned();
        let mut auth = Password::new(UserIdentifier::Matrix(user_id.into()), password);
        auth.session.clone_from(&uiaa.session);
        account
            .deactivate(None, Some(AuthData::Password(auth)), false)
            .await
            .map_err(|error| match error.as_uiaa_response() {
                Some(_) => crate::errors::coded("deactivate_account_auth", RpcCode::Denied, &error),
                None => self.failed_with("deactivate_account_auth", &error),
            })?;
        Ok(None)
    }

    pub(crate) async fn registered_store_id(&self, account_id: &str) -> Option<String> {
        self.accounts.lock().await.as_ref().and_then(|registry| {
            registry
                .accounts
                .iter()
                .find(|account| account.account_id == account_id)
                .map(|account| account.store_id.clone())
        })
    }

    fn refresh_own_identity(&self, client: &matrix_sdk::Client) {
        let Some(user_id) = client.user_id().map(ToOwned::to_owned) else {
            return;
        };
        let client = client.clone();
        self.track_session_task(
            spawn(async move {
                if let Err(error) = client.encryption().request_user_identity(&user_id).await {
                    tracing::warn!(
                        operation = "verification",
                        "could not refresh own device list: {error}"
                    );
                }
            })
            .abort_on_drop(),
        );
    }

    pub(crate) async fn restore(self: &Arc<Self>) -> Result<Option<SessionInfo>, RpcError> {
        let _restoring = self.lifecycle.restoring().await;
        if let Some(session) = self.active_session_info() {
            return Ok(Some(session));
        }

        let stale = self.mark_stale_sign_ins().await?;
        let accounts = self.accounts().await?;
        let Some(account_id) = accounts.active_account_id else {
            return Ok(None);
        };
        let Some(account) = accounts
            .accounts
            .into_iter()
            .find(|account| account.account_id == account_id)
        else {
            return Err(self.failed("restore", "active account is missing"));
        };
        if !account.state.usable() {
            return Ok(None);
        }
        let lease = session::store_lease(&account.store_id).await;
        let client = match self.saved_account_client(&account, &lease).await {
            Ok(client) => client,
            Err(error) => {
                let retired =
                    self.accounts().await?.accounts.iter().any(|saved| {
                        saved.account_id == account.account_id && !saved.state.usable()
                    });
                return if retired { Ok(None) } else { Err(error) };
            }
        };
        let persisted = account.session;

        let info = SessionInfo {
            account_id: account.account_id.clone(),
            user_id: persisted
                .credentials
                .user_id()
                .parse()
                .or_failed(self, "restore_user_id")?,
            device_id: persisted.credentials.device_id(),
            homeserver: persisted.homeserver.clone(),
            needs_reauth: false,
        };

        let generation = self.claim_session_generation().await;
        self.start_session(
            client,
            persisted.homeserver,
            account.account_id,
            &generation,
            &lease,
        )
        .await?;
        self.retire_replaced(stale, &account.store_id);

        Ok(Some(info))
    }

    fn active_session_info(&self) -> Option<SessionInfo> {
        self.session
            .current(|session| {
                Some(SessionInfo {
                    account_id: session.account_id.clone(),
                    user_id: session.client.user_id()?.to_owned(),
                    device_id: session.client.device_id()?.to_string(),
                    homeserver: session.homeserver.clone(),
                    needs_reauth: false,
                })
            })
            .flatten()
    }

    pub(crate) async fn list_accounts(&self) -> Result<Vec<SessionInfo>, RpcError> {
        let accounts = self.accounts().await?;
        let accounts = accounts
            .accounts
            .into_iter()
            .map(|account| {
                Ok(SessionInfo {
                    account_id: account.account_id,
                    user_id: account
                        .session
                        .credentials
                        .user_id()
                        .parse()
                        .or_failed(self, "list_accounts_user_id")?,
                    device_id: account.session.credentials.device_id(),
                    homeserver: account.session.homeserver,
                    needs_reauth: !account.state.usable(),
                })
            })
            .collect::<Result<Vec<_>, RpcError>>()?;
        Ok(accounts)
    }

    pub(crate) async fn switch_account(
        self: &Arc<Self>,
        SwitchAccountParams { account_id }: SwitchAccountParams,
    ) -> Result<SessionInfo, RpcError> {
        let _stalled = self.report_stalled_switch();
        self.session_step("waiting for the restore lock");
        let _restoring = self.lifecycle.restoring().await;
        if let Some(session) = self.active_session_info()
            && session.account_id == account_id
        {
            return Ok(session);
        }
        let accounts = self.accounts().await?;
        let account = accounts
            .accounts
            .into_iter()
            .find(|account| account.account_id == account_id)
            .ok_or(RpcCode::NotLoggedIn)?;
        if !account.state.usable() {
            return Err(RpcCode::NotLoggedIn.into());
        }
        self.session_step("waiting for the store lease");
        let lease = session::store_lease(&account.store_id).await;
        self.session_step("opening the account");
        let client = self.saved_account_client(&account, &lease).await?;
        let persisted = account.session;
        let info = SessionInfo {
            account_id: account.account_id.clone(),
            user_id: persisted
                .credentials
                .user_id()
                .parse()
                .or_failed(self, "switch_account_user_id")?,
            device_id: persisted.credentials.device_id(),
            homeserver: persisted.homeserver.clone(),
            needs_reauth: false,
        };

        self.session_step("claiming the session");
        let generation = self.claim_session_generation().await;
        self.pending_registration.lock().await.take();
        self.pending_login.lock().await.take();
        self.start_session(
            client,
            persisted.homeserver,
            account.account_id,
            &generation,
            &lease,
        )
        .await?;
        Ok(info)
    }

    pub(crate) async fn logout(self: &Arc<Self>) -> Result<(), RpcError> {
        let transition = self.lock_session_transition().await;
        transition.invalidate();
        self.pending_registration.lock().await.take();
        self.pending_login.lock().await.take();
        let session = self.take_session().await;
        let account_id = session.as_ref().map(|session| session.account_id.clone());
        if let Some(session) = session {
            // Stopped first, so the stores are not held open while the server is slow to answer.
            session.sync_service.stop().await;
            let request = async {
                if session.oauth {
                    session
                        .client
                        .oauth()
                        .logout()
                        .await
                        .map_err(|e| e.to_string())
                } else {
                    session
                        .client
                        .matrix_auth()
                        .logout()
                        .await
                        .map(|_| ())
                        .map_err(|e| e.to_string())
                }
            };
            match matrix_sdk::timeout::timeout(Box::pin(request), LOG_OUT_TIMEOUT).await {
                Ok(Ok(())) => {}
                Ok(Err(error)) => {
                    tracing::warn!("server-side logout failed, clearing locally anyway: {error}");
                }
                Err(_) => {
                    tracing::warn!("server-side logout timed out, clearing locally anyway");
                }
            }
        }

        self.remove_account(account_id.as_deref()).await
    }

    /// The active session must be signed out through `logout` so its sync
    /// service is stopped cleanly.
    pub(crate) async fn remove_inactive_account(
        &self,
        RemoveAccountParams { account_id }: RemoveAccountParams,
    ) -> Result<(), RpcError> {
        if self
            .active_session_info()
            .as_ref()
            .map(|session| &session.account_id)
            == Some(&account_id)
        {
            return Err(RpcCode::Denied.into());
        }

        let accounts = self.accounts().await?;
        let Some(account) = accounts
            .accounts
            .iter()
            .find(|account| account.account_id == account_id)
        else {
            return Err(RpcCode::NotLoggedIn.into());
        };

        // A twin of the active session's own device must stay signed in.
        let twin = self.active_session_info().is_some_and(|session| {
            session.user_id.as_str() == account.session.credentials.user_id()
                && session.device_id == account.session.credentials.device_id()
        });
        if !account.state.device_gone() && !twin {
            self.log_out_saved(account).await;
        }
        self.remove_account(Some(&account_id)).await
    }

    /// Stops every writer to the stores and refuses further calls, so another
    /// core can open them.
    pub async fn shutdown(self: &Arc<Self>) {
        self.shut_down.store(true, Ordering::SeqCst);
        let transition = self.lifecycle.exclusive_transition().await;
        transition.invalidate();
        if let Some(session) = self.take_session().await {
            session.sync_service.stop().await;
        }
        let accounts: Vec<String> = self.account_clients.lock().await.keys().cloned().collect();
        for account_id in accounts {
            self.invalidate_account_client(&account_id).await;
        }
    }

    #[cfg(not(target_family = "wasm"))]
    pub(crate) async fn reset_local_cache(self: &Arc<Self>) -> Result<(), RpcError> {
        let outcome = {
            let transition = self.lifecycle.exclusive_transition().await;
            transition.invalidate();
            if let Some(session) = self.take_session().await {
                session.sync_service.stop().await;
            }
            let accounts = self.accounts().await?;
            let mut outcome = Ok(());
            for account in &accounts.accounts {
                let client = self
                    .account_clients
                    .lock()
                    .await
                    .get(&account.account_id)
                    .cloned();
                self.invalidate_account_client(&account.account_id).await;
                if let Some(client) = client
                    && let Err(error) = client.state_store().close().await
                {
                    outcome = Err(self.failed_with("reset_local_cache", &error));
                    continue;
                }
                if let Err(error) = reset_account_cache(account).await {
                    outcome = Err(self.failed_report("reset_local_cache", error));
                }
            }
            outcome
        };
        self.restore().await?;
        outcome
    }

    pub(crate) async fn persist(
        &self,
        account_id: &str,
        store_id: &str,
        persisted: &PersistedSession,
        reauth: Option<&PersistedAccount>,
    ) -> Result<ReplacedSignIns, RpcError> {
        let _guard = self.session_store_lock.lock().await;
        let mut accounts = self.accounts.lock().await;
        let Some(registry) = accounts.as_ref() else {
            return Err(self.failed("persist", "account registry is not initialized"));
        };
        if let Some(expected) = reauth
            && !registry.accounts.iter().any(|account| {
                account.account_id == expected.account_id
                    && !account.state.usable()
                    && account.state.device_gone() == expected.state.device_gone()
            })
        {
            return Err(RpcCode::NotLoggedIn.into());
        }
        let mut updated = registry.clone();
        let user_id = persisted.credentials.user_id();
        let mut replaced = ReplacedSignIns::default();
        for account in &mut updated.accounts {
            if account.account_id != account_id && account.session.credentials.user_id() == user_id
            {
                if account.state.usable() {
                    replaced.usable.push(account.account_id.clone());
                }
                account.state.require_sign_in();
                replaced.all.push(account.account_id.clone());
            }
        }
        let account = PersistedAccount {
            account_id: account_id.to_owned(),
            store_id: store_id.to_owned(),
            session: persisted.clone(),
            state: AccountState::Usable,
        };
        self.save_login_tokens(&account)
            .await
            .or_failed(self, "persist_tokens")?;
        updated.upsert(account);
        self.write_registry(&updated)
            .await
            .or_failed(self, "persist_save")?;
        self.invalidate_account_client(account_id).await;
        for account_id in &replaced.all {
            self.invalidate_account_client(account_id).await;
        }
        *accounts = Some(updated);
        Ok(replaced)
    }

    /// The sign-in that replaced these never started, so they are the user's usable ones again.
    async fn keep_replaced(&self, account_ids: &[String]) -> Result<(), RpcError> {
        if account_ids.is_empty() {
            return Ok(());
        }
        let _guard = self.session_store_lock.lock().await;
        let mut accounts = self.accounts.lock().await;
        let Some(registry) = accounts.as_ref() else {
            return Err(self.failed("keep_replaced", "account registry is not initialized"));
        };
        let mut updated = registry.clone();
        for account in &mut updated.accounts {
            if account_ids.contains(&account.account_id)
                && account.state == AccountState::NeedsSignIn
            {
                account.state = AccountState::Usable;
            }
        }
        self.write_registry(&updated)
            .await
            .or_failed(self, "keep_replaced_save")?;
        *accounts = Some(updated);
        Ok(())
    }

    async fn persist_refreshed(
        &self,
        client: &matrix_sdk::Client,
        homeserver: &str,
        account_id: &str,
        generation: u64,
    ) -> Result<(), RpcError> {
        let _guard = self.session_store_lock.lock().await;
        if self.credential_writers.lock().await.get(account_id) != Some(&generation) {
            tracing::info!("session tokens: save skipped, another client writes this account");
            // The writer's own tokens are saved by the retry, which a refresh here may have made stale.
            self.unsaved_tokens.lock().insert(account_id.to_owned());
            return Ok(());
        }
        let saved = self
            .save_current_credentials(client, homeserver, account_id)
            .await;
        if saved.is_ok() {
            self.unsaved_tokens.lock().remove(account_id);
        } else {
            self.unsaved_tokens.lock().insert(account_id.to_owned());
        }
        saved?;
        tracing::info!(refresh = %refresh_tag(client), "session tokens: save finished");
        Ok(())
    }

    /// The SDK only logs a failed save, and the refresh token it replaced is spent, so the next
    /// start would sign the account out.
    pub(crate) async fn retry_unsaved_tokens(&self) {
        if self.unsaved_tokens.lock().is_empty() {
            return;
        }
        let Some((client, homeserver, account_id)) = self.session.current(|session| {
            (
                session.client.clone(),
                session.homeserver.clone(),
                session.account_id.clone(),
            )
        }) else {
            return;
        };
        if !self.unsaved_tokens.lock().contains(&account_id) {
            return;
        }
        let Some(generation) = self
            .credential_writers
            .lock()
            .await
            .get(&account_id)
            .copied()
        else {
            return;
        };
        if let Err(error) = self
            .persist_refreshed(&client, &homeserver, &account_id, generation)
            .await
        {
            tracing::warn!("could not save the refreshed session tokens again: {error:?}");
        }
    }

    #[cfg(not(target_family = "wasm"))]
    async fn reload_saved_tokens(
        &self,
        account_id: &str,
        generation: u64,
    ) -> Result<matrix_sdk::SessionTokens, RpcError> {
        let _guard = self.session_store_lock.lock().await;
        if self.credential_writers.lock().await.get(account_id) != Some(&generation) {
            return Err(RpcCode::NotLoggedIn.into());
        }
        let device_id = self
            .accounts
            .lock()
            .await
            .as_ref()
            .and_then(|registry| {
                registry
                    .accounts
                    .iter()
                    .find(|account| account.account_id == account_id && account.state.usable())
            })
            .map(|account| account.session.credentials.device_id())
            .ok_or(RpcCode::NotLoggedIn)?;
        let tokens = self
            .read_login_tokens(account_id, device_id)
            .await
            .or_failed(self, "reload_session_read")?
            .map_err(|_| RpcCode::NotLoggedIn)?;
        if tokens.access_token.is_empty() {
            return Err(self.failed("reload_session_read", "saved login access token is empty"));
        }
        Ok(tokens)
    }

    /// A login's tokens leave the registry only once its own file holds them.
    #[cfg(not(target_family = "wasm"))]
    pub(crate) async fn write_registry(
        &self,
        registry: &AccountRegistry,
    ) -> Result<(), crate::store::StoreError> {
        let logins = crate::credentials::LoginTokens::new(std::path::Path::new(&self.store_id));
        let mut saved = registry.clone();
        let saved = tokio::task::spawn_blocking(move || {
            for account in &mut saved.accounts {
                let device_id = account.session.credentials.device_id();
                if matches!(
                    logins.read(&account.account_id, &device_id),
                    Ok(Ok(tokens)) if !tokens.access_token.is_empty()
                ) {
                    account.session.credentials.discard_tokens();
                }
            }
            saved
        })
        .await
        .map_err(crate::store::StoreError::backend)?;
        self.sessions.save(serde_json::to_vec(&saved)?).await
    }

    #[cfg(target_family = "wasm")]
    pub(crate) async fn write_registry(
        &self,
        registry: &AccountRegistry,
    ) -> Result<(), crate::store::StoreError> {
        self.sessions.save(serde_json::to_vec(registry)?).await
    }

    #[cfg(not(target_family = "wasm"))]
    pub(crate) async fn save_login_tokens(
        &self,
        account: &PersistedAccount,
    ) -> Result<(), crate::store::StoreError> {
        let logins = crate::credentials::LoginTokens::new(std::path::Path::new(&self.store_id));
        let account_id = account.account_id.clone();
        let device_id = account.session.credentials.device_id();
        let tokens = account.session.credentials.tokens();
        tokio::task::spawn_blocking(move || logins.save(&account_id, &device_id, &tokens))
            .await
            .map_err(crate::store::StoreError::backend)?
    }

    #[cfg(target_family = "wasm")]
    #[expect(
        clippy::unused_async,
        clippy::unused_async_trait_impl,
        reason = "mirrors the native signature"
    )]
    pub(crate) async fn save_login_tokens(
        &self,
        _account: &PersistedAccount,
    ) -> Result<(), crate::store::StoreError> {
        Ok(())
    }

    /// Returns whether tokens the registry held moved into a file, so it is rewritten without them.
    #[cfg(not(target_family = "wasm"))]
    pub(crate) async fn load_login_tokens(
        &self,
        registry: &mut AccountRegistry,
    ) -> Result<bool, crate::store::StoreError> {
        let logins = crate::credentials::LoginTokens::new(std::path::Path::new(&self.store_id));
        let mut loaded = registry.clone();
        let (loaded, embedded) = tokio::task::spawn_blocking(move || {
            let mut embedded = false;
            for account in loaded
                .accounts
                .iter_mut()
                .filter(|account| account.state.usable())
            {
                let credentials = &mut account.session.credentials;
                let device_id = credentials.device_id();
                match logins.read_or_migrate(&account.account_id, &device_id, &credentials.tokens())
                {
                    Ok(Ok((tokens, migrated))) => {
                        credentials.set_tokens(tokens);
                        embedded |= migrated;
                    }
                    // Reported once the account is opened.
                    Ok(Err(_)) => {}
                    Err(error) => tracing::warn!(
                        account_id = account.account_id,
                        "saved login tokens are unavailable: {error}"
                    ),
                }
            }
            let devices: Vec<_> = loaded
                .accounts
                .iter()
                .map(|account| {
                    (
                        account.account_id.clone(),
                        account.session.credentials.device_id(),
                    )
                })
                .collect();
            logins.retain(
                devices
                    .iter()
                    .map(|(account_id, device_id)| (account_id.as_str(), device_id.as_str())),
            );
            (loaded, embedded)
        })
        .await
        .map_err(crate::store::StoreError::backend)?;
        *registry = loaded;
        Ok(embedded)
    }

    #[cfg(not(target_family = "wasm"))]
    async fn read_login_tokens(
        &self,
        account_id: &str,
        device_id: String,
    ) -> Result<
        Result<matrix_sdk::SessionTokens, crate::credentials::MissingTokens>,
        crate::store::StoreError,
    > {
        let logins = crate::credentials::LoginTokens::new(std::path::Path::new(&self.store_id));
        let account_id = account_id.to_owned();
        tokio::task::spawn_blocking(move || logins.read(&account_id, &device_id))
            .await
            .map_err(crate::store::StoreError::backend)?
    }

    /// Returns whether the account must now sign in again.
    #[cfg(not(target_family = "wasm"))]
    pub(crate) async fn retire_unusable_login(
        &self,
        account: &PersistedAccount,
    ) -> Result<bool, RpcError> {
        let tokens = self
            .read_login_tokens(&account.account_id, account.session.credentials.device_id())
            .await
            .or_failed(self, "reauth_login_tokens")?;
        let Err(missing) = tokens else {
            return Ok(false);
        };
        self.sign_in_again(&account.account_id, missing).await?;
        Ok(true)
    }

    /// The account keeps its crypto store and settings until it signs in again.
    #[cfg(not(target_family = "wasm"))]
    async fn sign_in_again(
        &self,
        account_id: &str,
        missing: crate::credentials::MissingTokens,
    ) -> Result<(), RpcError> {
        tracing::warn!(
            reported = true,
            reason = missing.reason(),
            "saved login tokens cannot be used, so the account must sign in again"
        );
        self.mark_account_needs_reauth(Some(account_id), false)
            .await
    }

    /// `None` forgets every login.
    #[cfg(not(target_family = "wasm"))]
    async fn forget_login_tokens(&self, account_id: Option<&str>) {
        let logins = crate::credentials::LoginTokens::new(std::path::Path::new(&self.store_id));
        let account_id = account_id.map(ToOwned::to_owned);
        if let Err(error) = tokio::task::spawn_blocking(move || match account_id {
            Some(account_id) => logins.forget(&account_id),
            None => logins.forget_all(),
        })
        .await
        {
            tracing::warn!("could not forget the saved tokens: {error}");
        }
    }

    #[cfg(target_family = "wasm")]
    #[expect(clippy::unused_async, reason = "mirrors the native signature")]
    async fn forget_login_tokens(&self, _account_id: Option<&str>) {}

    async fn save_current_credentials(
        &self,
        client: &matrix_sdk::Client,
        homeserver: &str,
        account_id: &str,
    ) -> Result<(), RpcError> {
        let mut accounts = self.accounts.lock().await;
        let Some(registry) = accounts.as_ref() else {
            return Ok(());
        };
        let mut updated = registry.clone();
        let Some(account) = updated
            .accounts
            .iter_mut()
            .find(|account| account.account_id == account_id)
        else {
            return Ok(());
        };
        if !account.state.usable() {
            return Ok(());
        }
        let Some(persisted) = session::current_session(client, homeserver.to_owned()) else {
            return Ok(());
        };
        account.session = persisted.keeping_endpoint_of(&account.session);
        self.save_login_tokens(account)
            .await
            .or_failed(self, "refresh_save")?;
        self.write_registry(&updated)
            .await
            .or_failed(self, "refresh_save")?;
        *accounts = Some(updated);
        Ok(())
    }

    pub(crate) async fn saved_account_client(
        self: &Arc<Self>,
        account: &PersistedAccount,
        _lease: &session::StoreLease,
    ) -> Result<matrix_sdk::Client, RpcError> {
        let cached = self
            .account_clients
            .lock()
            .await
            .get(&account.account_id)
            .cloned();
        if let Some(client) = cached {
            return Ok(client);
        }
        let persisted = account.session.clone();
        #[cfg(not(target_family = "wasm"))]
        let persisted = {
            let mut persisted = persisted;
            let tokens = match self
                .read_login_tokens(&account.account_id, persisted.credentials.device_id())
                .await
                .or_failed(self, "restore_login_tokens")?
            {
                Ok(tokens) => tokens,
                Err(missing) if missing.is_lost() => {
                    self.sign_in_again(&account.account_id, missing).await?;
                    return Err(RpcCode::NotLoggedIn.into());
                }
                Err(_) => {
                    return Err(
                        self.failed("restore_login_tokens", "saved login tokens are missing")
                    );
                }
            };
            if tokens.access_token.is_empty() {
                return Err(
                    self.failed("restore_login_tokens", "saved login access token is empty")
                );
            }
            persisted.credentials.set_tokens(tokens);
            persisted
        };
        session::validate_saved_crypto_store(&account.store_id, &persisted)
            .await
            .or_report(self, "restore_crypto_store")?;
        let client =
            session::restore_client(&account.store_id, &persisted, self.persistent_event_cache)
                .await
                .or_failed(self, "restore_build_client")?;
        self.install_credential_writer(&client, &account.session.homeserver, &account.account_id)
            .await;
        session::restore_credentials(&client, &persisted)
            .await
            .or_report(self, "restore_session")?;
        tracing::info!(refresh = %refresh_tag(&client), "session tokens: restored");
        self.account_clients
            .lock()
            .await
            .insert(account.account_id.clone(), client.clone());
        Ok(client)
    }

    async fn install_credential_writer(
        self: &Arc<Self>,
        client: &matrix_sdk::Client,
        homeserver: &str,
        account_id: &str,
    ) {
        let writer = self.next_credential_writer.fetch_add(1, Ordering::SeqCst);
        self.credential_writers
            .lock()
            .await
            .insert(account_id.to_owned(), writer);
        self.install_session_callbacks(client, homeserver, account_id, writer);
    }

    /// Closes what a push opened for an account that is not the active one. The active account's
    /// client belongs to its session.
    #[cfg(not(target_family = "wasm"))]
    pub(crate) async fn evict_idle_account_client(&self, account_id: &str) {
        let active = self
            .session
            .current(|session| session.account_id.clone())
            .is_some_and(|active| active == account_id);
        if !active {
            self.invalidate_account_client(account_id).await;
        }
    }

    pub(crate) async fn invalidate_account_client(&self, account_id: &str) {
        self.credential_writers.lock().await.remove(account_id);
        self.account_clients.lock().await.remove(account_id);
        let route = self.notification_routes.lock().await.remove(account_id);
        if let Some(route) = route {
            route.lock().take();
        }
    }

    async fn prepare_account_client(
        self: &Arc<Self>,
        client: &matrix_sdk::Client,
        homeserver: &str,
        account_id: &str,
    ) -> Result<(), RpcError> {
        let _guard = self.session_store_lock.lock().await;
        let mut accounts = self.accounts.lock().await;
        let mut updated = accounts.as_ref().ok_or(RpcCode::NotLoggedIn)?.clone();
        let account = updated
            .accounts
            .iter_mut()
            .find(|account| account.account_id == account_id && account.state.usable())
            .ok_or(RpcCode::NotLoggedIn)?;
        let mut clients = self.account_clients.lock().await;
        if !clients.contains_key(account_id) {
            self.install_credential_writer(client, homeserver, account_id)
                .await;
            clients.insert(account_id.to_owned(), client.clone());
        }
        drop(clients);
        account.session = session::current_session(client, homeserver.to_owned())
            .ok_or(RpcCode::NotLoggedIn)?
            .keeping_endpoint_of(&account.session);
        updated.active_account_id = Some(account_id.to_owned());
        self.write_registry(&updated)
            .await
            .or_failed(self, "activate_account_save")?;
        *accounts = Some(updated);
        Ok(())
    }

    pub(crate) async fn clear_persisted_session(&self) -> Result<(), RpcError> {
        let _guard = self.session_store_lock.lock().await;
        self.sessions
            .clear()
            .await
            .or_failed(self, "clear_session")?;
        self.forget_login_tokens(None).await;
        Ok(())
    }

    pub(crate) async fn mark_account_needs_reauth(
        &self,
        account_id: Option<&str>,
        device_invalidated: bool,
    ) -> Result<(), RpcError> {
        let Some(account_id) = account_id else {
            return Ok(());
        };

        let _guard = self.session_store_lock.lock().await;
        let mut accounts = self.accounts.lock().await;
        let Some(registry) = accounts.as_mut() else {
            return Err(self.failed("retire_session", "account registry is not initialized"));
        };
        let Some(account) = registry
            .accounts
            .iter_mut()
            .find(|account| account.account_id == account_id)
        else {
            return Ok(());
        };
        if device_invalidated {
            account.state = AccountState::DeviceGone;
        } else {
            account.state.require_sign_in();
        }
        if device_invalidated {
            account.session.credentials.discard_tokens();
        }

        if registry.active_account_id.as_deref() == Some(account_id) {
            registry.active_account_id = None;
        }
        self.invalidate_account_client(account_id).await;
        self.write_registry(registry)
            .await
            .or_failed(self, "retire_session_save")?;
        if device_invalidated {
            self.forget_login_tokens(Some(account_id)).await;
        }
        Ok(())
    }

    async fn remove_account(&self, account_id: Option<&str>) -> Result<(), RpcError> {
        #[cfg(not(target_family = "wasm"))]
        crate::notifications::clear_push_media(std::path::Path::new(&self.store_id)).await;
        let Some(account_id) = account_id else {
            return self.clear_persisted_session().await;
        };
        // Nothing opens the account again while its files go.
        self.mark_account_needs_reauth(Some(account_id), false)
            .await?;
        self.retire_account(account_id, None).await
    }

    async fn mark_stale_sign_ins(&self) -> Result<Vec<String>, RpcError> {
        self.accounts().await?;
        let _guard = self.session_store_lock.lock().await;
        let mut accounts = self.accounts.lock().await;
        let Some(registry) = accounts.as_ref() else {
            return Err(self.failed("mark_stale_sign_ins", "account registry is not initialized"));
        };
        let mut updated = registry.clone();
        let stale = updated.mark_stale_sign_ins();
        if stale.is_empty() {
            return Ok(stale);
        }
        self.write_registry(&updated)
            .await
            .or_failed(self, "mark_stale_sign_ins")?;
        *accounts = Some(updated);
        for account_id in &stale {
            self.invalidate_account_client(account_id).await;
        }
        Ok(stale)
    }

    /// Runs once the replacing session holds `store_id`, so no replaced store is still open. The
    /// old devices' sign-out waits on the server, so the session starts without it. A replaced
    /// account that cannot be retired, or whose session ends first, stays waiting, and the next
    /// restore retries it.
    fn retire_replaced(self: &Arc<Self>, replaced: Vec<String>, store_id: &str) {
        if replaced.is_empty() {
            return;
        }
        let Some(base) = session::base_client(store_id) else {
            tracing::error!("could not retire the replaced accounts: the new client is gone");
            return;
        };
        let core = self.clone();
        self.track_session_task(
            spawn(async move {
                for account_id in &replaced {
                    if let Err(error) = core.retire_account(account_id, Some(&base)).await {
                        tracing::warn!(
                            account_id,
                            ?error,
                            "a replaced account waits to be retired"
                        );
                    }
                }
            })
            .abort_on_drop(),
        );
    }

    /// The account leaves the registry only once nothing of it is left behind. `successor` takes
    /// the room keys only this account's store holds.
    async fn retire_account(
        &self,
        account_id: &str,
        successor: Option<&matrix_sdk_base::BaseClient>,
    ) -> Result<(), RpcError> {
        let Some(account) = self
            .accounts()
            .await?
            .accounts
            .into_iter()
            .find(|account| account.account_id == account_id)
        else {
            return Ok(());
        };
        // Another user's store must not take these keys. The sign-in stays waiting until a restore
        // of its own user retires it.
        if let Some(successor) = successor
            && successor
                .session_meta()
                .is_none_or(|meta| meta.user_id.as_str() != account.session.credentials.user_id())
        {
            return Ok(());
        }
        self.invalidate_account_client(account_id).await;
        if let Some(successor) = successor {
            match crate::store_disposal::carry_room_keys(&account.store_id, successor).await {
                Ok(imported) => tracing::info!(imported, "carried room keys to the new device"),
                // Nothing in the old store can be read anymore.
                Err(crate::store::StoreError::KeyMissing) => {}
                Err(error) => return Err(self.failed_with("retire_account_room_keys", &error)),
            }
            // A twin of the successor's own device must stay signed in.
            if !account.state.device_gone()
                && successor.session_meta().is_some_and(|meta| {
                    meta.device_id.as_str() != account.session.credentials.device_id()
                })
            {
                self.log_out_saved(&account).await;
            }
        }
        self.forget_login_tokens(Some(account_id)).await;
        if let Err(error) = self.discard_account_store(&account.store_id).await {
            // The store may be half gone, so signing in again must not reuse its device.
            self.mark_account_needs_reauth(Some(account_id), true)
                .await?;
            return Err(error);
        }
        let _guard = self.session_store_lock.lock().await;
        let mut accounts = self.accounts.lock().await;
        let Some(registry) = accounts.as_ref() else {
            return Err(self.failed("retire_account", "account registry is not initialized"));
        };
        let mut updated = registry.clone();
        updated
            .accounts
            .retain(|account| account.account_id != account_id);
        if updated.active_account_id.as_deref() == Some(account_id) {
            updated.active_account_id = None;
        }
        self.write_registry(&updated)
            .await
            .or_failed(self, "retire_account_save")?;
        *accounts = Some(updated);
        Ok(())
    }

    /// Best effort: a device the server cannot be reached for stays signed in there.
    async fn log_out_saved(&self, account: &PersistedAccount) {
        let persisted = account.session.clone();
        #[cfg(not(target_family = "wasm"))]
        let persisted = {
            let mut persisted = persisted;
            match self
                .read_login_tokens(&account.account_id, persisted.credentials.device_id())
                .await
            {
                Ok(Ok(tokens)) => persisted.credentials.set_tokens(tokens),
                Ok(Err(missing)) => {
                    tracing::warn!(
                        reason = missing.reason(),
                        "the replaced device has no saved tokens to sign out with"
                    );
                    return;
                }
                Err(error) => {
                    tracing::warn!("could not read the replaced device's tokens: {error}");
                    return;
                }
            }
            persisted
        };
        if persisted.credentials.tokens().access_token.is_empty() {
            return;
        }
        match matrix_sdk::timeout::timeout(Box::pin(session::log_out(&persisted)), LOG_OUT_TIMEOUT)
            .await
        {
            Ok(Ok(())) => tracing::info!("signed the saved device out"),
            Ok(Err(error)) => tracing::warn!("could not sign the saved device out: {error}"),
            Err(_) => tracing::warn!("signing the saved device out timed out"),
        }
    }

    pub(crate) async fn discard_account_store(&self, store_id: &str) -> Result<(), RpcError> {
        crate::store_disposal::discard(&self.store_id, store_id)
            .await
            .or_failed(self, "discard_account_store")
    }

    pub(crate) async fn take_session(&self) -> Option<Session> {
        self.detach_session().await
    }

    async fn detach_session(&self) -> Option<Session> {
        self.session_step("ending calls");
        self.end_all_calls().await;
        let client = self.session.current(|session| session.client.clone());
        if let Some(client) = client {
            self.session_step("saving the inbox");
            self.flush_inbox(&client).await;
        }
        // Lock order: room subscriptions, then the session. Opening a room reads the session under
        // the first.
        self.session_step("locking room subscriptions");
        let mut room_subscriptions = self.room_subscriptions.lock().await;
        self.session_step("locking the session");
        let mut session = self.session.write().await;
        self.session_step("clearing the session state");
        self.session_handlers.lock().clear();
        self.session_tasks.lock().clear();
        self.to_device_inbox.lock().take();
        self.search_sharing.reset_session();
        self.rtc.clear();
        self.subscriptions.lock().await.clear();
        room_subscriptions.clear();
        self.warm_rooms.lock().clear();
        self.timelines.lock().await.clear();
        self.thread_timelines.lock().await.clear();
        self.account_data_types.lock().await.clear();
        self.inbox.lock().await.reset();
        *self.pack_cache.lock().await = image_packs::PackCache::default();
        self.calendars.lock().await.clear();
        *self.push_rules.lock().await = None;
        self.set_read_room(None);
        self.probed_pinned_rooms.lock().clear();
        self.pinned_caches.lock().clear();
        *self.cosmetics.lock() = cosmetics::CosmeticsCache::default();
        self.nicknames
            .send_replace(crate::nicknames::Nicknames::default());
        *self.probed_state() = crate::probed_state::ProbedState::default();
        *self.recent_state.lock() = crate::probed_state::RecentState::default();
        self.session_step("closing the search index");
        *self.search_index.lock().await = search::MessageIndex::new();
        self.session_step("clearing the session state");
        self.search_crawl.lock().await.reset();
        self.server_search.lock().await.reset();
        session.take()
    }

    pub(crate) async fn finish_sign_in(
        self: &Arc<Self>,
        client: matrix_sdk::Client,
        account_id: String,
        store_id: &str,
        persisted: PersistedSession,
        reauth: Option<&PersistedAccount>,
    ) -> Result<SessionGeneration<'_>, RpcError> {
        self.finish_sign_in_leased(client, account_id, store_id, persisted, reauth, None)
            .await
    }

    /// `lease` is the one a caller took before building `client` on a store that may already be
    /// open, so no other client opens it in between.
    pub(crate) async fn finish_sign_in_leased(
        self: &Arc<Self>,
        client: matrix_sdk::Client,
        account_id: String,
        store_id: &str,
        persisted: PersistedSession,
        reauth: Option<&PersistedAccount>,
        lease: Option<session::StoreLease>,
    ) -> Result<SessionGeneration<'_>, RpcError> {
        if matches!(
            self.require_sliding_sync(&client).await,
            Err(RpcError {
                code: RpcCode::SlidingSyncUnsupported,
                ..
            })
        ) {
            if let Err(error) = client.logout().await {
                tracing::warn!(?error, "could not log out a session without Sliding Sync");
            }
            return Err(RpcCode::SlidingSyncUnsupported.into());
        }
        if let Err(error) = session::enable_crypto_store_lock(&client)
            .await
            .or_report(self, "enable_crypto_store_lock")
        {
            self.abandon_sign_in(&client, reauth).await;
            return Err(error);
        }
        // Pushes can find the login once it is persisted.
        #[cfg_attr(
            target_family = "wasm",
            expect(clippy::let_unit_value, reason = "the web has no store lease")
        )]
        let lease = match lease {
            Some(lease) => lease,
            None => session::store_lease(store_id).await,
        };
        let generation = self.claim_session_generation().await;
        let replaced = match self
            .persist(&account_id, store_id, &persisted, reauth)
            .await
        {
            Ok(replaced) => replaced,
            Err(error) => {
                self.abandon_sign_in(&client, reauth).await;
                return Err(error);
            }
        };
        let started = self
            .start_session(
                client.clone(),
                persisted.homeserver,
                account_id.clone(),
                &generation,
                &lease,
            )
            .await;
        if let Err(error) = started {
            // The saved login would name a device the server no longer knows.
            self.abandon_sign_in(&client, reauth).await;
            if reauth.is_none_or(|account| account.state.device_gone()) {
                if let Err(error) = self
                    .mark_account_needs_reauth(Some(&account_id), true)
                    .await
                {
                    tracing::warn!(?error, "could not retire an account that failed to start");
                }
                // Without this the user would be left with no usable sign-in at all.
                if let Err(error) = self.keep_replaced(&replaced.usable).await {
                    tracing::warn!(?error, "could not keep the sign-ins a failed one replaced");
                }
            }
            return Err(error);
        }
        self.retire_replaced(replaced.all, store_id);
        Ok(generation)
    }

    /// Best effort: a new device nothing saved would otherwise stay signed in on the server. A
    /// reauthentication that kept its device leaves it as it was.
    async fn abandon_sign_in(
        &self,
        client: &matrix_sdk::Client,
        reauth: Option<&PersistedAccount>,
    ) {
        if reauth.is_some_and(|account| !account.state.device_gone()) {
            return;
        }
        match matrix_sdk::timeout::timeout(Box::pin(client.logout()), LOG_OUT_TIMEOUT).await {
            Ok(Ok(())) => {}
            Ok(Err(error)) => tracing::warn!(?error, "could not log out an unsaved sign-in"),
            Err(_) => tracing::warn!("logging out an unsaved sign-in timed out"),
        }
    }

    pub(crate) async fn start_session(
        self: &Arc<Self>,
        client: matrix_sdk::Client,
        homeserver: String,
        account_id: String,
        claimed: &SessionGeneration<'_>,
        _lease: &session::StoreLease,
    ) -> Result<(), RpcError> {
        let generation = claimed.value();
        let oauth = client.oauth().full_session().is_some();
        self.session_step("preparing sync");
        if let Err(error) = session::repair_room_key_sharing(&client).await {
            tracing::warn!(%error, "repairing room key sharing failed");
        }

        let session_changes = client.subscribe_to_session_changes();
        let sync_service = session::build_sync(client.clone())
            .await
            .or_failed(self, "start_sync")?;

        self.session_step("swapping the session");
        let Some(swap) = claimed.swap().await else {
            sync_service.stop().await;
            return Err(RpcCode::Unavailable.into());
        };

        self.session_step("preparing the account client");
        self.prepare_account_client(&client, &homeserver, &account_id)
            .await?;

        // Do not disrupt the active session unless its replacement started
        // successfully. `take_session` also aborts its owned watcher tasks.
        if let Some(previous) = self.take_session().await {
            self.session_step("stopping the previous sync");
            previous.sync_service.stop().await;
        }

        self.session_step("starting the session");
        self.watch_ephemeral(&client, generation);
        self.watch_account_data(&client, generation);
        self.watch_incoming_calls(&client, generation);
        self.watch_incoming_verifications(&client);

        swap.commit();
        self.activity.unlock_account();
        self.emit_if_current(
            generation,
            CoreEvent::AccountLockChanged {
                account_id: account_id.clone(),
                locked: false,
            },
        );
        let mut session = self.session.write().await;
        *session = Some(Session {
            account_id: account_id.clone(),
            client: client.clone(),
            sync_service: sync_service.clone(),
            homeserver: homeserver.clone(),
            oauth,
        });
        drop(session);

        self.watch_session_changes(session_changes, generation);
        self.watch_encryption(&client, generation);
        self.watch_room_keys(&client);
        self.watch_account_data_key_sharing(&client, generation);
        self.watch_search_peers(&client, generation);
        self.watch_rtc(&client, generation);
        self.resume_dehydrated_device(&client);
        self.watch_devices(&client, generation);
        self.watch_oauth_metadata(&client, generation);
        self.watch_notifications(&client, generation).await;
        self.watch_notification_settings(generation);
        self.watch_space_sidebar(&client, generation);
        self.watch_calendars(&client, generation);
        self.watch_widget_feed(&client, generation);
        self.watch_room_widgets(&client, generation);
        self.watch_room_state(&client);
        self.watch_cosmetics(&client, generation);
        self.watch_profile_changes(&client, generation);
        self.watch_nicknames();
        self.watch_redactions(&client);
        let repair_client = client.clone();
        self.track_session_task(
            spawn(async move {
                if let Err(error) = crate::rooms::migrate_saved_tombstones(&repair_client).await {
                    tracing::warn!("could not migrate saved tombstones: {error}");
                }
            })
            .abort_on_drop(),
        );
        self.watch_bot_commands(&client, generation);
        self.watch_room_rules(&client, generation);
        self.watch_image_packs(&client, generation);
        self.watch_joined_invites(&client);
        self.watch_send_queue(&client);
        self.watch_presence(&client, generation);
        self.watch_inbox_persist(&client);
        self.prefetch_call_well_known(&client);
        let store_id = self
            .registered_store_id(&account_id)
            .await
            .unwrap_or_else(|| self.store_id.clone());
        self.watch_search_index(&client, &store_id);
        self.watch_ignored_users(&client);
        self.watch_ignored_history(&client, &sync_service);
        self.watch_sync_stall(&client, &sync_service, crate::sync_support::SYNC_STALL);
        self.watch_backup_preference(&client);
        // Before the start: the subscriber yields only changes, so it would miss the first `Running`.
        self.watch_sync_state(&client, &sync_service, generation);
        self.run_started_session(&client, &sync_service).await;
        Ok(())
    }

    async fn run_started_session(
        self: &Arc<Self>,
        client: &matrix_sdk::Client,
        sync: &matrix_sdk_ui::sync_service::SyncService,
    ) {
        self.session_step("starting sync");
        sync.start().await;

        client.send_queue().enable_upload_progress(true);
        self.session_step("resending queued messages");
        client
            .send_queue()
            .respawn_tasks_for_rooms_with_unsent_requests()
            .await;

        self.watch_activity_health();

        self.refresh_own_identity(client);

        self.session_step("applying the app activity");
        self.apply_activity_after_session_start().await;
        self.session_step("idle");
    }

    pub(crate) fn session_step(&self, step: &'static str) {
        *self.session_step.lock() = step;
    }

    /// A switch that never ends shows only a spinner, so it reports the step it is stuck on.
    fn report_stalled_switch(self: &Arc<Self>) -> impl Drop {
        let core = Arc::downgrade(self);
        spawn(async move {
            matrix_sdk::sleep::sleep(STALLED_SWITCH).await;
            if let Some(core) = core.upgrade() {
                let step = *core.session_step.lock();
                tracing::warn!(reported = true, step, "an account switch has not finished");
            }
        })
        .abort_on_drop()
    }

    /// The SDK rotates the OAuth refresh token when it refreshes. Without
    /// re-persisting, the next cold start authenticates with a spent one.
    fn install_session_callbacks(
        self: &Arc<Self>,
        client: &matrix_sdk::Client,
        homeserver: &str,
        account_id: &str,
        generation: u64,
    ) {
        let saver = Arc::downgrade(self);
        let saved_homeserver = homeserver.to_owned();
        let saved_account_id = account_id.to_owned();

        let save = move |client: matrix_sdk::Client| {
            let account_id = saved_account_id.clone();
            let homeserver = saved_homeserver.clone();
            let Some(core) = saver.upgrade() else {
                tracing::warn!("session tokens: refreshed after the session owner was dropped");
                return Err("session owner was dropped".into());
            };

            #[cfg(not(target_family = "wasm"))]
            {
                let handle = tokio::runtime::Handle::current();
                tokio::task::block_in_place(|| {
                    handle.block_on(async move {
                        core.persist_refreshed(&client, &homeserver, &account_id, generation)
                            .await
                            .map_err(|error| {
                                format!("could not persist refreshed session: {error:?}").into()
                            })
                    })
                })
            }

            #[cfg(target_family = "wasm")]
            {
                drop(spawn(async move {
                    if let Err(error) = core
                        .persist_refreshed(&client, &homeserver, &account_id, generation)
                        .await
                    {
                        tracing::error!("could not persist refreshed session: {error:?}");
                    }
                }));

                Ok(())
            }
        };

        #[cfg(not(target_family = "wasm"))]
        let loader = Arc::downgrade(self);
        #[cfg(not(target_family = "wasm"))]
        let loaded_account_id = account_id.to_owned();
        let reload = move |client: matrix_sdk::Client| {
            #[cfg(not(target_family = "wasm"))]
            {
                let _ = client;
                let core = loader.upgrade().ok_or("session owner was dropped")?;
                let handle = tokio::runtime::Handle::current();
                tokio::task::block_in_place(|| {
                    handle.block_on(core.reload_saved_tokens(&loaded_account_id, generation))
                })
                .map_err(|error| format!("could not reload saved tokens: {error:?}").into())
            }
            #[cfg(target_family = "wasm")]
            client
                .session_tokens()
                .ok_or_else(|| "no session tokens to reload".into())
        };

        if let Err(error) = client.set_session_callbacks(Box::new(reload), Box::new(save)) {
            tracing::error!("could not install session callbacks: {error}");
        }
    }

    pub(crate) fn watch_session_changes(
        self: &Arc<Self>,
        mut changes: tokio::sync::broadcast::Receiver<matrix_sdk::SessionChange>,
        generation: u64,
    ) {
        let core = self.clone();
        self.track_session_task(
            spawn(async move {
                loop {
                    match changes.recv().await {
                        Ok(change) => {
                            if core.handle_session_change(&change, generation) {
                                return;
                            }
                            core.retry_unsaved_tokens().await;
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {}
                        Err(tokio::sync::broadcast::error::RecvError::Closed) => return,
                    }
                }
            })
            .abort_on_drop(),
        );
    }

    pub(crate) fn handle_session_change(
        self: &Arc<Self>,
        change: &matrix_sdk::SessionChange,
        generation: u64,
    ) -> bool {
        let matrix_sdk::SessionChange::UnknownToken(data) = change else {
            if self.is_current(generation) {
                tracing::info!("session tokens: refreshed");
                self.emit(CoreEvent::SessionTokensRefreshed);
            }
            return false;
        };
        let soft_logout = data.soft_logout;

        if !self.is_current(generation) {
            return true;
        }

        let core = self.clone();
        drop(spawn(async move {
            let transition = core.lock_session_transition().await;
            if !core.is_current(generation) {
                return;
            }
            transition.invalidate();
            let session = core.take_session().await;
            let account_id = session.as_ref().map(|session| session.account_id.clone());
            if let Some(session) = session {
                session.sync_service.stop().await;
            }

            let outcome = match account_id.as_deref() {
                Some(account_id) => {
                    core.mark_account_needs_reauth(Some(account_id), !soft_logout)
                        .await
                }
                None if soft_logout => Ok(()),
                None => core.clear_persisted_session().await,
            };
            if let Err(error) = outcome {
                tracing::error!(soft_logout, "could not retire rejected session: {error:?}");
            }

            let reason = if soft_logout {
                "soft_logout"
            } else {
                "token_rejected"
            };
            #[cfg(not(target_family = "wasm"))]
            tracing::error!(
                reason,
                "session ended after the homeserver rejected its token"
            );

            core.emit(CoreEvent::SessionEnded {
                reason: reason.to_owned(),
            });
        }));
        true
    }
}

fn refresh_tag(client: &matrix_sdk::Client) -> String {
    use std::hash::{DefaultHasher, Hash as _, Hasher as _};

    client
        .session_tokens()
        .and_then(|tokens| tokens.refresh_token)
        .map_or_else(
            || "none".to_owned(),
            |token| {
                let mut hasher = DefaultHasher::new();
                token.hash(&mut hasher);
                format!("{:016x}", hasher.finish())
            },
        )
}

fn oauth_device_delete_url(
    metadata: &AuthorizationServerMetadata,
    device_id: &ruma::DeviceId,
) -> Result<String, RpcError> {
    use matrix_sdk::ruma::api::client::discovery::get_authorization_server_metadata::v1::{
        AccountManagementAction, AccountManagementActionData, DeviceDeleteData,
    };
    let url = if metadata
        .is_account_management_action_supported(&AccountManagementAction::DeviceDelete)
    {
        metadata.account_management_url_with_action(AccountManagementActionData::DeviceDelete(
            DeviceDeleteData::new(device_id),
        ))
    } else {
        metadata.account_management_uri.clone()
    };
    url.map(|url| url.to_string())
        .ok_or_else(|| RpcCode::Unsupported.into())
}

fn oauth_account_deactivate_url(
    metadata: &AuthorizationServerMetadata,
) -> Result<String, RpcError> {
    use matrix_sdk::ruma::api::client::discovery::get_authorization_server_metadata::v1::{
        AccountManagementAction, AccountManagementActionData,
    };
    let url = if metadata
        .is_account_management_action_supported(&AccountManagementAction::AccountDeactivate)
    {
        metadata.account_management_url_with_action(AccountManagementActionData::AccountDeactivate)
    } else {
        // Providers can offer deletion in their portal without advertising a deep-link action.
        metadata.account_management_uri.clone()
    };
    url.map(|url| url.to_string())
        .ok_or_else(|| RpcCode::Unsupported.into())
}

const LOG_OUT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);
const STALLED_SWITCH: std::time::Duration = std::time::Duration::from_secs(20);

#[cfg(not(target_family = "wasm"))]
const CACHE_DATABASES: [&str; 3] = [
    "matrix-sdk-event-cache.sqlite3",
    "matrix-sdk-media.sqlite3",
    matrix_sdk::STATE_STORE_DATABASE_NAME,
];

#[cfg(not(target_family = "wasm"))]
async fn reset_account_cache(account: &PersistedAccount) -> Result<(), crate::CoreError> {
    use crate::errors::ReportExt as _;
    use matrix_sdk_base::crypto::store::CryptoStore as _;

    let store = std::path::Path::new(&account.store_id).join("store");
    if !store.exists() {
        return Ok(());
    }

    session::validate_saved_crypto_store(&account.store_id, &account.session).await?;

    let key = crate::store_encryption::saved_key(&account.store_id)?;
    let crypto = matrix_sdk::SqliteCryptoStore::open_with_config(&crate::store_encryption::config(
        &store,
        key.as_ref(),
    ))
    .await
    .backend()?;
    crypto
        .remove_custom_value(&format!(
            "sliding_sync_store::room-list::{}::instance",
            account.session.credentials.user_id()
        ))
        .await
        .backend()?;
    drop(crypto);

    for directory in [store, std::path::Path::new(&account.store_id).join("cache")] {
        for database in CACHE_DATABASES {
            for suffix in ["", "-wal", "-shm"] {
                let path = directory.join(format!("{database}{suffix}"));
                match std::fs::remove_file(&path) {
                    Ok(()) => {}
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                    Err(source) => {
                        return Err(crate::store::StoreError::Path { path, source }.into());
                    }
                }
            }
        }
    }
    Ok(())
}

#[cfg(test)]
#[cfg(not(target_family = "wasm"))]
#[path = "accounts_tests.rs"]
mod regression_tests;
