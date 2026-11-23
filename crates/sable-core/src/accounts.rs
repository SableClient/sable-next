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
use crate::session::{PersistedAccount, PersistedSession, Session};

use crate::Core;
use crate::cosmetics;
use crate::image_packs;
use crate::lifecycle::SessionGeneration;
use crate::search;
use crate::session;

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
        if account.needs_reauth {
            return Ok(None);
        }
        let lease = session::store_lease(&account.store_id).await;
        let client =
            match self.saved_account_client(&account, &lease).await {
                Ok(client) => client,
                Err(error) => {
                    let retired =
                        self.accounts().await?.accounts.iter().any(|saved| {
                            saved.account_id == account.account_id && saved.needs_reauth
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
                    needs_reauth: account.needs_reauth,
                })
            })
            .collect::<Result<Vec<_>, RpcError>>()?;
        Ok(accounts)
    }

    pub(crate) async fn switch_account(
        self: &Arc<Self>,
        SwitchAccountParams { account_id }: SwitchAccountParams,
    ) -> Result<SessionInfo, RpcError> {
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
        if account.needs_reauth {
            return Err(RpcCode::NotLoggedIn.into());
        }
        let lease = session::store_lease(&account.store_id).await;
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
            let result = if session.oauth {
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
            };

            if let Err(error) = result {
                tracing::warn!("server-side logout failed, clearing locally anyway: {error}");
            }

            session.sync_service.stop().await;
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
        if !accounts
            .accounts
            .iter()
            .any(|account| account.account_id == account_id)
        {
            return Err(RpcCode::NotLoggedIn.into());
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
        self.settle_retired_search(None).await;
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
            self.settle_retired_search(None).await;
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
    ) -> Result<Vec<String>, RpcError> {
        let _guard = self.session_store_lock.lock().await;
        let mut accounts = self.accounts.lock().await;
        let Some(registry) = accounts.as_ref() else {
            return Err(self.failed("persist", "account registry is not initialized"));
        };
        if let Some(expected) = reauth
            && !registry.accounts.iter().any(|account| {
                account.account_id == expected.account_id
                    && account.needs_reauth
                    && account.device_invalidated == expected.device_invalidated
            })
        {
            return Err(RpcCode::NotLoggedIn.into());
        }
        let mut updated = registry.clone();
        let user_id = persisted.credentials.user_id();
        let mut replaced = Vec::new();
        for account in &mut updated.accounts {
            if account.account_id != account_id && account.session.credentials.user_id() == user_id
            {
                account.needs_reauth = true;
                replaced.push(account.account_id.clone());
            }
        }
        let account = PersistedAccount {
            account_id: account_id.to_owned(),
            store_id: store_id.to_owned(),
            session: persisted.clone(),
            needs_reauth: false,
            device_invalidated: false,
        };
        self.save_login_tokens(&account)
            .await
            .or_failed(self, "persist_tokens")?;
        updated.upsert(account);
        self.write_registry(&updated)
            .await
            .or_failed(self, "persist_save")?;
        self.invalidate_account_client(account_id).await;
        for account_id in &replaced {
            self.invalidate_account_client(account_id).await;
        }
        *accounts = Some(updated);
        Ok(replaced)
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
            return Ok(());
        }
        self.save_current_credentials(client, homeserver, account_id)
            .await?;
        tracing::info!(refresh = %refresh_tag(client), "session tokens: save finished");
        Ok(())
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
                    .find(|account| account.account_id == account_id && !account.needs_reauth)
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
                .filter(|account| !account.needs_reauth)
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
        if account.needs_reauth {
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

    async fn invalidate_account_client(&self, account_id: &str) {
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
            .find(|account| account.account_id == account_id && !account.needs_reauth)
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
        account.needs_reauth = true;
        account.device_invalidated = device_invalidated;
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
        self.settle_retired_search(Some(account_id)).await;
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
        self.invalidate_account_client(account_id).await;
        if let Some(successor) = successor {
            match crate::store_disposal::carry_room_keys(&account.store_id, successor).await {
                Ok(imported) => tracing::info!(imported, "carried room keys to the new device"),
                // Nothing in the old store can be read anymore.
                Err(crate::store::StoreError::KeyMissing) => {}
                Err(error) => return Err(self.failed_with("retire_account_room_keys", &error)),
            }
            // A twin of the successor's own device must stay signed in.
            if !account.device_invalidated
                && successor.session_meta().is_some_and(|meta| {
                    meta.device_id.as_str() != account.session.credentials.device_id()
                })
            {
                self.log_out_replaced(&account).await;
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
    async fn log_out_replaced(&self, account: &PersistedAccount) {
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
            Ok(Ok(())) => tracing::info!("signed the replaced device out"),
            Ok(Err(error)) => tracing::warn!("could not sign the replaced device out: {error}"),
            Err(_) => tracing::warn!("signing the replaced device out timed out"),
        }
    }

    pub(crate) async fn discard_account_store(&self, store_id: &str) -> Result<(), RpcError> {
        crate::store_disposal::discard(&self.store_id, store_id)
            .await
            .or_failed(self, "discard_account_store")
    }

    pub(crate) async fn take_session(&self) -> Option<Session> {
        let (session, index) = self.detach_session().await;
        if let Some(session) = &session {
            search::save_index(&session.client, index).await;
        }
        session
    }

    async fn retire_session(&self) -> Option<Session> {
        let (session, index) = self.detach_session().await;
        if let Some(session) = &session {
            self.retire_search_index(&session.account_id, &session.client, index)
                .await;
        }
        session
    }

    async fn detach_session(&self) -> (Option<Session>, search::MessageIndex) {
        self.end_all_calls().await;
        let client = self.session.current(|session| session.client.clone());
        if let Some(client) = client {
            self.flush_inbox(&client).await;
        }
        // Lock order: room subscriptions, then the session, then the search flush. Opening a room
        // reads the session under the first, a search copy saves under the second.
        let mut room_subscriptions = self.room_subscriptions.lock().await;
        let mut session = self.session.write().await;
        // An aborted task must not be holding a flush it took from the index.
        let flushing = self.search_flush.lock().await;
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
        let index = std::mem::replace(
            &mut *self.search_index.lock().await,
            search::MessageIndex::new(),
        );
        drop(flushing);
        self.search_crawl.lock().await.reset();
        self.server_search.lock().await.reset();
        (session.take(), index)
    }

    pub(crate) async fn finish_sign_in(
        self: &Arc<Self>,
        client: matrix_sdk::Client,
        account_id: String,
        store_id: &str,
        persisted: PersistedSession,
        reauth: Option<&PersistedAccount>,
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
        session::enable_crypto_store_lock(&client)
            .await
            .or_report(self, "enable_crypto_store_lock")?;
        // Pushes can find the login once it is persisted.
        let lease = session::store_lease(store_id).await;
        let generation = self.claim_session_generation().await;
        let replaced = self
            .persist(&account_id, store_id, &persisted, reauth)
            .await?;
        self.start_session(
            client,
            persisted.homeserver,
            account_id,
            &generation,
            &lease,
        )
        .await?;
        self.retire_replaced(replaced, store_id);
        Ok(generation)
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
        if let Err(error) = session::repair_room_key_sharing(&client).await {
            tracing::warn!(%error, "repairing room key sharing failed");
        }

        let session_changes = client.subscribe_to_session_changes();
        let sync_service = session::build_sync(client.clone())
            .await
            .or_failed(self, "start_sync")?;

        let Some(swap) = claimed.swap().await else {
            sync_service.stop().await;
            return Err(RpcCode::Unavailable.into());
        };

        self.prepare_account_client(&client, &homeserver, &account_id)
            .await?;

        // Do not disrupt the active session unless its replacement started
        // successfully. `retire_session` also aborts its owned watcher tasks.
        if let Some(previous) = self.retire_session().await {
            previous.sync_service.stop().await;
        }

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
        self.watch_search_index(&account_id, &client, &store_id);
        self.watch_ignored_users(&client);
        self.watch_ignored_history(&client, &sync_service);
        self.watch_sync_stall(&client, &sync_service, crate::sync_support::SYNC_STALL);
        self.watch_backup_preference(&client);
        sync_service.start().await;

        client.send_queue().enable_upload_progress(true);
        client
            .send_queue()
            .respawn_tasks_for_rooms_with_unsent_requests()
            .await;

        self.watch_sync_state(&client, &sync_service, generation);
        self.watch_activity_health();

        self.refresh_own_identity(&client);

        // `Suspended` found no session to stop while this one was still starting.
        self.apply_app_activity(false).await;
        Ok(())
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
                return Ok(());
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

#[cfg(not(target_family = "wasm"))]
const CACHE_DATABASES: [&str; 2] = ["matrix-sdk-event-cache.sqlite3", "matrix-sdk-media.sqlite3"];

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

    search::reset_state_cache(&store, key.as_ref()).await?;

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
mod regression_tests {
    use crate::api::encryption::DeleteDeviceParams;
    use crate::session::{self, Credentials, PersistedAccount};
    use crate::test_support::wait_until_retired;
    use std::sync::Arc;

    use matrix_sdk::{
        Room,
        ruma::{event_id, events::room::message::RoomMessageEventContent, room_id},
        test_utils::mocks::MatrixMockServer,
    };
    use matrix_sdk_ui::sync_service::SyncService;
    use wiremock::ResponseTemplate;

    use crate::{
        CachedTimeline, Core,
        protocol::{RpcCode, RpcError},
        session::Session,
        store::MemorySessionStore,
    };

    struct DelayedSecondSave {
        attempts: Arc<std::sync::atomic::AtomicUsize>,
        bytes: Arc<parking_lot::Mutex<Option<Vec<u8>>>>,
        started: Arc<tokio::sync::Notify>,
        release: Arc<tokio::sync::Notify>,
    }

    #[async_trait::async_trait]
    impl crate::store::SessionStore for DelayedSecondSave {
        async fn load(&self) -> Result<Option<Vec<u8>>, crate::store::StoreError> {
            Ok(self.bytes.lock().clone())
        }

        async fn save(&self, bytes: Vec<u8>) -> Result<(), crate::store::StoreError> {
            if self
                .attempts
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst)
                == 1
            {
                self.started.notify_one();
                self.release.notified().await;
            }
            *self.bytes.lock() = Some(bytes);
            Ok(())
        }

        async fn clear(&self) -> Result<(), crate::store::StoreError> {
            Ok(())
        }
    }
    async fn core_with_room() -> (tempfile::TempDir, MatrixMockServer, Arc<Core>, Room) {
        let server = MatrixMockServer::new().await;
        server
            .mock_versions()
            .with_feature("org.matrix.msc4140", true)
            .ok()
            .mount()
            .await;
        let client = server.client_builder().no_server_versions().build().await;
        let room = server
            .sync_joined_room(&client, room_id!("!regression:example.org"))
            .await;
        let sync_service = Arc::new(SyncService::builder(client.clone()).build().await.unwrap());
        let base = tempfile::tempdir().unwrap();
        let (core, _events) = Core::new(
            base.path().to_str().unwrap(),
            Box::new(MemorySessionStore::default()),
        );
        *core.session.write().await = Some(Session {
            account_id: "first".to_owned(),
            client,
            sync_service,
            homeserver: server.server().uri(),
            oauth: false,
        });
        (base, server, core, room)
    }

    #[tokio::test]
    async fn left_rooms_names_only_the_rooms_the_account_left() {
        let (_store, server, core, room) = core_with_room().await;
        server
            .sync_room(
                &room.client(),
                matrix_sdk_test::LeftRoomBuilder::new(room_id!("!gone:example.org")),
            )
            .await;

        let (user_id, rooms) = core.left_rooms().await.unwrap();
        assert_eq!(user_id, room.client().user_id().unwrap().to_string());
        assert_eq!(rooms, ["!gone:example.org"]);
    }

    #[test]
    fn oauth_account_deactivation_uses_the_provider_portal_without_a_direct_action() {
        use matrix_sdk::ruma::api::client::discovery::get_authorization_server_metadata::v1::AuthorizationServerMetadata;
        for actions in [
            serde_json::json!([]),
            serde_json::json!(["org.matrix.profile"]),
        ] {
            let metadata: AuthorizationServerMetadata = serde_json::from_value(serde_json::json!({
                "issuer": "https://id.example.org/",
                "authorization_endpoint": "https://id.example.org/authorize",
                "token_endpoint": "https://id.example.org/token",
                "revocation_endpoint": "https://id.example.org/revoke",
                "response_types_supported": ["code"],
                "response_modes_supported": ["query", "fragment"],
                "grant_types_supported": ["authorization_code", "refresh_token"],
                "code_challenge_methods_supported": ["S256"],
                "account_management_uri": "https://id.example.org/account?lang=en#profile",
                "account_management_actions_supported": actions,
            }))
            .unwrap();
            assert_eq!(
                super::oauth_account_deactivate_url(&metadata).unwrap(),
                "https://id.example.org/account?lang=en#profile"
            );
        }
    }

    #[test]
    fn oauth_account_deactivation_prefers_the_advertised_direct_action() {
        use matrix_sdk::ruma::api::client::discovery::get_authorization_server_metadata::v1::{
            AccountManagementAction, AuthorizationServerMetadata,
        };
        let metadata: AuthorizationServerMetadata = serde_json::from_value(serde_json::json!({
            "issuer": "https://id.example.org/",
            "authorization_endpoint": "https://id.example.org/authorize",
            "token_endpoint": "https://id.example.org/token",
            "revocation_endpoint": "https://id.example.org/revoke",
            "response_types_supported": ["code"],
            "response_modes_supported": ["query", "fragment"],
            "grant_types_supported": ["authorization_code", "refresh_token"],
            "code_challenge_methods_supported": ["S256"],
            "account_management_uri": "https://id.example.org/account",
            "account_management_actions_supported": [AccountManagementAction::AccountDeactivate.as_str()],
        })).unwrap();
        let url =
            url::Url::parse(&super::oauth_account_deactivate_url(&metadata).unwrap()).unwrap();
        assert!(url.query_pairs().any(|(key, value)| key == "action"
            && value == AccountManagementAction::AccountDeactivate.as_str()));
    }

    #[test]
    fn oauth_account_deactivation_requires_a_provider_portal() {
        use matrix_sdk::ruma::api::client::discovery::get_authorization_server_metadata::v1::AuthorizationServerMetadata;
        let metadata: AuthorizationServerMetadata = serde_json::from_value(serde_json::json!({
            "issuer": "https://id.example.org/",
            "authorization_endpoint": "https://id.example.org/authorize",
            "token_endpoint": "https://id.example.org/token",
            "revocation_endpoint": "https://id.example.org/revoke",
            "response_types_supported": ["code"],
            "response_modes_supported": ["query", "fragment"],
            "grant_types_supported": ["authorization_code", "refresh_token"],
            "code_challenge_methods_supported": ["S256"],
        }))
        .unwrap();
        assert!(matches!(
            super::oauth_account_deactivate_url(&metadata),
            Err(RpcError {
                code: RpcCode::Unsupported,
                ..
            })
        ));
    }

    #[test]
    fn oauth_device_deletion_uses_supported_actions_or_the_management_page() {
        use matrix_sdk::ruma::api::client::discovery::get_authorization_server_metadata::v1::AuthorizationServerMetadata;
        let mut value = serde_json::json!({
            "issuer": "https://id.example.org/", "authorization_endpoint": "https://id.example.org/authorize",
            "token_endpoint": "https://id.example.org/token", "revocation_endpoint": "https://id.example.org/revoke",
            "response_types_supported": ["code"], "response_modes_supported": ["query", "fragment"],
            "grant_types_supported": ["authorization_code", "refresh_token"], "code_challenge_methods_supported": ["S256"],
            "account_management_uri": "https://id.example.org/account"
        });
        let device = matrix_sdk::ruma::device_id!("DEVICE");
        let metadata: AuthorizationServerMetadata = serde_json::from_value(value.clone()).unwrap();
        assert_eq!(
            super::oauth_device_delete_url(&metadata, device).unwrap(),
            "https://id.example.org/account"
        );
        for action in ["org.matrix.device_delete", "org.matrix.session_end"] {
            value["account_management_actions_supported"] = serde_json::json!([action]);
            let metadata: AuthorizationServerMetadata =
                serde_json::from_value(value.clone()).unwrap();
            let url = url::Url::parse(&super::oauth_device_delete_url(&metadata, device).unwrap())
                .unwrap();
            assert!(
                url.query_pairs()
                    .any(|(key, value)| key == "action" && value == action)
            );
            assert!(
                url.query_pairs()
                    .any(|(key, value)| key == "device_id" && value == "DEVICE")
            );
        }
        value
            .as_object_mut()
            .unwrap()
            .remove("account_management_uri");
        let metadata: AuthorizationServerMetadata = serde_json::from_value(value).unwrap();
        assert!(matches!(
            super::oauth_device_delete_url(&metadata, device),
            Err(RpcError {
                code: RpcCode::Unsupported,
                ..
            })
        ));
    }

    #[tokio::test]
    async fn legacy_sessions_use_server_device_management() {
        let (_store, server, core, room) = core_with_room().await;
        assert!(room.client().oauth().full_session().is_none());
        server
            .oauth()
            .mock_server_metadata()
            .ok_https()
            .expect(1)
            .mount()
            .await;
        server.mock_devices().ok().mount().await;

        let base = server.server().uri().replace("http://", "https://");
        let url = core
            .delete_device(DeleteDeviceParams {
                device_id: "OTHER".into(),
                password: None,
            })
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            url,
            format!("{base}/account?action=org.matrix.session_end&device_id=OTHER")
        );
    }

    #[tokio::test]
    async fn servers_without_oauth_keep_legacy_device_deletion() {
        let (_store, server, core, _room) = core_with_room().await;
        server
            .oauth()
            .mock_server_metadata()
            .error_unrecognized()
            .expect(1)
            .mount()
            .await;
        server.mock_devices().ok().mount().await;
        wiremock::Mock::given(wiremock::matchers::method("POST"))
            .and(wiremock::matchers::path(
                "/_matrix/client/v3/delete_devices",
            ))
            .and(wiremock::matchers::body_json(
                serde_json::json!({"devices": ["OTHER"]}),
            ))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({})))
            .expect(1)
            .mount(server.server())
            .await;

        assert!(
            core.delete_device(DeleteDeviceParams {
                device_id: "OTHER".into(),
                password: None,
            })
            .await
            .unwrap()
            .is_none()
        );
    }

    #[tokio::test]
    async fn invalid_metadata_does_not_use_legacy_device_deletion() {
        let (_store, server, core, _room) = core_with_room().await;
        server
            .oauth()
            .mock_server_metadata()
            .ok_json(serde_json::json!({"issuer": "https://id.example.org"}))
            .expect(1)
            .mount()
            .await;

        core.delete_device(DeleteDeviceParams {
            device_id: "OTHER".into(),
            password: None,
        })
        .await
        .unwrap_err();
        assert!(
            server
                .server()
                .received_requests()
                .await
                .unwrap()
                .iter()
                .all(|request| !request.url.path().ends_with("/delete_devices"))
        );
    }

    #[tokio::test]
    async fn overlapping_failed_attempts_leave_committed_generation_unchanged() {
        let (core, _events) = Core::new("attempts", Box::new(MemorySessionStore::default()));
        let first = core.claim_session_generation().await;
        let second = core.claim_session_generation();
        tokio::pin!(second);
        assert!(futures_util::poll!(second.as_mut()).is_pending());
        assert_eq!(core.lifecycle.current(), 1);
        drop(first);
        let second = second.await;
        assert_eq!(second.value(), 3);
        assert_eq!(core.lifecycle.current(), 1);
        drop(second);
        assert_eq!(core.lifecycle.current(), 1);
    }

    #[tokio::test]
    async fn unknown_token_during_failed_preparation_still_ends_the_active_session() {
        use crate::session::{AccountRegistry, PersistedAccount, current_session};
        let (_store, server, core, room) = core_with_room().await;
        let mut registry = AccountRegistry::empty();
        registry.active_account_id = Some("first".to_owned());
        registry.upsert(PersistedAccount {
            account_id: "first".to_owned(),
            store_id: core.store_id.clone(),
            session: current_session(&room.client(), server.server().uri()).unwrap(),
            needs_reauth: false,
            device_invalidated: false,
        });
        *core.accounts.lock().await = Some(registry);
        let pending = core.claim_session_generation().await;
        let mut rejected = ruma::api::error::UnknownTokenErrorData::new();
        rejected.soft_logout = true;
        assert!(core.handle_session_change(&matrix_sdk::SessionChange::UnknownToken(rejected), 1));
        tokio::task::yield_now().await;
        assert!(core.session.read().await.is_some());
        drop(pending);
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                if core.accounts().await.unwrap().accounts[0].needs_reauth {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert!(core.session.read().await.is_none());
    }

    #[tokio::test]
    async fn rejected_devices_discard_credentials_but_keep_their_stores() {
        use crate::session::{AccountRegistry, PersistedAccount, current_session};
        for hard in [false, true] {
            let server = MatrixMockServer::new().await;
            let directory = tempfile::tempdir().unwrap();
            let base = directory.path().join("sable");
            let base = base.to_str().unwrap();
            let store_id = session::account_store_id(base, "a1");
            let client = server
                .client_builder()
                .on_builder(|builder| {
                    builder.sqlite_store_with_cache_path(
                        std::path::Path::new(&store_id).join("store"),
                        std::path::Path::new(&store_id).join("cache"),
                        None,
                    )
                })
                .build()
                .await;
            client
                .encryption()
                .wait_for_e2ee_initialization_tasks()
                .await;
            let saved = current_session(&client, server.server().uri()).unwrap();
            let (core, _events) = Core::new(base, Box::new(MemorySessionStore::default()));
            let mut registry = AccountRegistry::empty();
            registry.active_account_id = Some("a1".to_owned());
            registry.upsert(PersistedAccount {
                account_id: "a1".to_owned(),
                store_id: store_id.clone(),
                session: saved.clone(),
                needs_reauth: false,
                device_invalidated: false,
            });
            *core.accounts.lock().await = Some(registry);
            core.account_clients
                .lock()
                .await
                .insert("a1".to_owned(), client.clone());
            let database = std::path::Path::new(&store_id).join("store/matrix-sdk-crypto.sqlite3");
            assert!(database.exists());
            core.mark_account_needs_reauth(Some("a1"), hard)
                .await
                .unwrap();
            assert!(database.exists());
            let bytes = core.sessions.load().await.unwrap().unwrap();
            let (registry, _) = AccountRegistry::from_bytes(&bytes, base).unwrap();
            let account = &registry.accounts[0];
            assert!(account.needs_reauth);
            assert_eq!(account.device_invalidated, hard);
            assert_eq!(
                account.session.credentials.user_id(),
                saved.credentials.user_id()
            );
            assert_eq!(
                account.session.credentials.device_id(),
                saved.credentials.device_id()
            );
            if hard {
                assert_eq!(account.session.credentials.tokens().access_token, "");
                assert!(account.session.credentials.tokens().refresh_token.is_none());
            } else {
                assert_eq!(
                    account.session.credentials.tokens(),
                    saved.credentials.tokens()
                );
            }
        }
    }

    #[tokio::test]
    async fn a_hard_token_rejection_keeps_the_account() {
        use crate::session::{AccountRegistry, PersistedAccount, current_session};
        let (_store, server, core, room) = core_with_room().await;
        let mut registry = AccountRegistry::empty();
        registry.active_account_id = Some("first".to_owned());
        registry.upsert(PersistedAccount {
            account_id: "first".to_owned(),
            store_id: core.store_id.clone(),
            session: current_session(&room.client(), server.server().uri()).unwrap(),
            needs_reauth: false,
            device_invalidated: false,
        });
        *core.accounts.lock().await = Some(registry);
        let rejected = ruma::api::error::UnknownTokenErrorData::new();
        assert!(core.handle_session_change(&matrix_sdk::SessionChange::UnknownToken(rejected), 1));
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                let accounts = core.accounts().await.unwrap().accounts;
                if accounts.first().is_some_and(|account| account.needs_reauth) {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        let accounts = core.accounts().await.unwrap().accounts;
        assert_eq!(accounts.len(), 1);
        assert_eq!(accounts[0].account_id, "first");
        assert!(accounts[0].device_invalidated);
    }

    #[tokio::test]
    async fn looking_up_the_session_never_waits_for_a_pending_teardown() {
        use futures_util::FutureExt;

        let (_store, _server, core, _room) = core_with_room().await;
        let pinned = core.session.read().await;
        let ending = core.take_session();
        tokio::pin!(ending);
        assert!(futures_util::poll!(ending.as_mut()).is_pending());

        assert!(
            core.client()
                .now_or_never()
                .is_some_and(|client| client.is_ok())
        );
        assert!(core.sync_service().now_or_never().is_some());
        drop(pinned);
        assert!(ending.await.is_some());
        core.client().await.unwrap_err();
    }

    #[tokio::test]
    async fn a_session_ending_while_a_room_opens_does_not_deadlock() {
        let (_store, _server, core, _room) = core_with_room().await;
        let opening = core.room_subscriptions.lock().await;
        let ending = core.take_session();
        tokio::pin!(ending);
        assert!(futures_util::poll!(ending.as_mut()).is_pending());

        tokio::time::timeout(std::time::Duration::from_secs(5), core.sync_service())
            .await
            .expect("opening a room must be able to read the session")
            .unwrap();
        drop(opening);
        assert!(ending.await.is_some());
    }

    #[tokio::test]
    async fn becoming_active_starts_an_idle_sync_service_and_hiding_stops_it() {
        use matrix_sdk_ui::sync_service::State;

        let (_store, _server, core, _room) = core_with_room().await;
        let sync_service = core.sync_service().await.unwrap();
        assert!(matches!(sync_service.state().get(), State::Idle));

        core.update_app_active(true).await;
        assert!(!matches!(sync_service.state().get(), State::Idle));
        assert!(!core.activity.sync_suspended());

        core.update_app_active(false).await;
        assert!(matches!(sync_service.state().get(), State::Idle));
        assert!(core.activity.sync_suspended());
    }

    #[tokio::test]
    async fn resuming_without_a_network_waits_for_one_to_start_sync() {
        use matrix_sdk_ui::sync_service::State;

        let (_store, _server, core, _room) = core_with_room().await;
        let sync_service = core.sync_service().await.unwrap();
        core.update_network_conditions(false, true).await;

        core.update_app_active(true).await;
        assert!(matches!(sync_service.state().get(), State::Idle));

        core.update_network_conditions(true, true).await;
        assert!(!matches!(sync_service.state().get(), State::Idle));
    }

    #[tokio::test]
    async fn a_network_coming_back_in_the_background_does_not_start_sync() {
        use matrix_sdk_ui::sync_service::State;

        let (_store, _server, core, _room) = core_with_room().await;
        let sync_service = core.sync_service().await.unwrap();
        core.update_app_active(false).await;
        core.update_network_conditions(false, true).await;

        core.update_network_conditions(true, true).await;
        assert!(matches!(sync_service.state().get(), State::Idle));
    }

    #[tokio::test]
    async fn foregrounding_without_a_session_clears_the_previous_pause() {
        let (_store, _server, core, _room) = core_with_room().await;
        core.update_app_active(false).await;
        assert!(core.sync_paused());
        core.take_session().await;

        core.update_app_active(true).await;

        assert!(!core.sync_paused());
    }

    #[tokio::test]
    async fn unlocking_an_account_keeps_a_background_sync_paused() {
        use matrix_sdk_ui::sync_service::State;
        use std::time::Duration;

        let (_store, server, core, room) = core_with_room().await;
        server
            .mock_who_am_i()
            .ok_with_user_id(room.client().user_id().unwrap())
            .mount()
            .await;
        server
            .mock_sliding_sync()
            .with_delay(Duration::from_secs(1))
            .ok_json(serde_json::json!({"pos": "p", "lists": {}, "rooms": {}}))
            .mount()
            .await;
        core.lock_account(core.lifecycle.current());
        core.update_app_active(false).await;

        tokio::time::timeout(Duration::from_secs(35), async {
            while core.activity.account_locked() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        let _transition = core.lock_session_transition().await;
        assert!(matches!(
            core.sync_service().await.unwrap().state().get(),
            State::Idle
        ));
    }

    #[tokio::test]
    async fn an_ignore_change_restarts_an_idle_foreground_sync() {
        use matrix_sdk_test::event_factory::EventFactory;
        use matrix_sdk_ui::sync_service::State;
        use std::time::Duration;

        let (_store, server, core, room) = core_with_room().await;
        let client = room.client();
        let sync = core.sync_service().await.unwrap();
        server
            .mock_sliding_sync()
            .with_delay(Duration::from_secs(1))
            .ok_json(serde_json::json!({"pos": "p", "lists": {}, "rooms": {}}))
            .mount()
            .await;
        core.watch_ignored_history(&client, &sync);

        server
            .mock_sync()
            .ok_and_run(&client, |response| {
                response.add_global_account_data(EventFactory::new().ignored_user_list([
                    matrix_sdk::ruma::user_id!("@ignored:example.org").to_owned(),
                ]));
            })
            .await;

        tokio::time::timeout(Duration::from_secs(2), async {
            while !matches!(sync.state().get(), State::Running) {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn queued_sync_recovery_cannot_undo_a_background_pause() {
        use matrix_sdk_ui::sync_service::State;

        let (_store, _server, core, _room) = core_with_room().await;
        let sync = core.sync_service().await.unwrap();
        sync.start().await;
        let serial = core.activity.transition().await;
        core.set_app_active(false);
        let mut pause = std::pin::pin!(core.apply_app_activity(false));
        assert!(futures_util::poll!(&mut pause).is_pending());
        let mut recovery = std::pin::pin!(core.resume_sync(&sync));
        assert!(futures_util::poll!(&mut recovery).is_pending());
        drop(serial);

        tokio::join!(pause, recovery);

        assert!(matches!(sync.state().get(), State::Idle));
    }

    #[tokio::test]
    async fn a_stale_pause_cannot_stop_a_new_background_interval() {
        use matrix_sdk_ui::sync_service::State;

        let (_store, _server, core, _room) = core_with_room().await;
        core.update_app_active(true).await;
        let sync = core.sync_service().await.unwrap();

        let serial = core.activity.transition().await;
        let old_revision = core.set_app_active(false);
        let old_core = core.clone();
        let old_pause = tokio::spawn(async move {
            old_core
                .apply_app_activity_if_current(false, old_revision)
                .await;
        });
        core.set_app_active(true);
        let revision = core.set_app_active(false);
        drop(serial);
        old_pause.await.unwrap();

        assert!(!matches!(sync.state().get(), State::Idle));
        core.apply_app_activity_if_current(false, revision).await;
        assert!(matches!(sync.state().get(), State::Idle));
    }

    #[tokio::test]
    async fn a_sync_that_never_answers_is_restarted() {
        use std::time::Duration;

        use matrix_sdk_ui::sync_service::State;

        let (_store, server, core, _room) = core_with_room().await;
        server
            .mock_sliding_sync()
            .with_delay(Duration::from_secs(60))
            .ok_json(serde_json::json!({ "pos": "0", "lists": {}, "rooms": {}, "extensions": {} }))
            .mount()
            .await;
        let client = core.client().await.unwrap();
        let sync_service = core.sync_service().await.unwrap();
        sync_service.start().await;
        let mut states = sync_service.state();

        core.watch_sync_stall(&client, &sync_service, Duration::from_millis(200));

        // The subscriber merges the restart's brief `Idle` into `Running`.
        let restarted = tokio::time::timeout(Duration::from_secs(5), states.next())
            .await
            .expect("a stalled sync is restarted");
        assert!(matches!(restarted, Some(State::Running)));
    }

    #[tokio::test]
    async fn a_manual_retry_starts_sync_on_a_network_reported_gone() {
        use matrix_sdk_ui::sync_service::State;

        let (_store, _server, core, _room) = core_with_room().await;
        let sync_service = core.sync_service().await.unwrap();
        core.update_network_conditions(false, true).await;
        core.update_app_active(true).await;
        assert!(matches!(sync_service.state().get(), State::Idle));
        assert!(matches!(
            core.shown_sync_status(sync_service.state().get()),
            crate::protocol::SyncStatus::Offline
        ));

        core.retry_sync(&sync_service).await;

        assert!(!matches!(sync_service.state().get(), State::Idle));
    }

    #[tokio::test]
    async fn a_reachable_server_overrules_a_network_reported_gone() {
        use std::time::Duration;

        use matrix_sdk_ui::sync_service::State;

        let (_store, server, core, _room) = core_with_room().await;
        server.mock_versions().ok().mount().await;
        let client = core.client().await.unwrap();
        let sync_service = core.sync_service().await.unwrap();
        core.update_network_conditions(false, true).await;
        core.update_app_active(true).await;
        assert!(matches!(sync_service.state().get(), State::Idle));
        let mut states = sync_service.state();

        core.watch_sync_stall(&client, &sync_service, Duration::from_millis(200));

        tokio::time::timeout(Duration::from_secs(5), states.next())
            .await
            .expect("sync starts once the server answers");
        assert!(core.activity.network_available());
    }

    #[tokio::test]
    async fn a_shut_down_core_stops_its_session_and_refuses_calls() {
        let (_store, _server, core, _room) = core_with_room().await;

        core.shutdown().await;

        assert!(core.session.read().await.is_none());
        assert!(core.account_clients.lock().await.is_empty());
        assert!(matches!(
            core.call("session.restore", "{}").await,
            Err(RpcError {
                code: RpcCode::Unavailable,
                ..
            })
        ));
    }

    #[tokio::test]
    async fn switching_back_to_a_cached_client_rebuilds_one_set_of_handlers() {
        use crate::session::{AccountRegistry, PersistedAccount, current_session};
        let (_store, server, core, room) = core_with_room().await;
        let client = room.client();
        let mut registry = AccountRegistry::empty();
        registry.upsert(PersistedAccount {
            account_id: "first".to_owned(),
            store_id: core.store_id.clone(),
            session: current_session(&client, server.server().uri()).unwrap(),
            needs_reauth: false,
            device_invalidated: false,
        });
        *core.accounts.lock().await = Some(registry);
        let mut handler_counts = Vec::new();
        for _ in 0..2 {
            let previous = core.take_session().await.unwrap();
            previous.sync_service.stop().await;
            let generation = core.claim_session_generation().await;
            core.start_session(
                client.clone(),
                server.server().uri(),
                "first".to_owned(),
                &generation,
                &session::store_lease(&core.store_id).await,
            )
            .await
            .unwrap();
            handler_counts.push(core.session_handlers.lock().len());
            assert_eq!(core.account_clients.lock().await.len(), 1);
            assert_eq!(core.credential_writers.lock().await.len(), 1);
        }
        assert!(handler_counts[0] > 0);
        assert_eq!(handler_counts[0], handler_counts[1]);
        let session = core.take_session().await.unwrap();
        session.sync_service.stop().await;
    }

    #[tokio::test]
    async fn a_foreground_session_starts_while_the_activity_lock_is_busy() {
        use crate::session::{AccountRegistry, PersistedAccount, current_session};
        use std::time::Duration;

        let (_store, server, core, room) = core_with_room().await;
        let client = room.client();
        let mut registry = AccountRegistry::empty();
        registry.upsert(PersistedAccount {
            account_id: "first".to_owned(),
            store_id: core.store_id.clone(),
            session: current_session(&client, server.server().uri()).unwrap(),
            needs_reauth: false,
            device_invalidated: false,
        });
        *core.accounts.lock().await = Some(registry);
        drop(core.take_session().await);
        core.set_app_active(true);

        let _activity = core.activity.transition().await;
        let generation = core.claim_session_generation().await;
        tokio::time::timeout(
            Duration::from_secs(1),
            core.start_session(
                client,
                server.server().uri(),
                "first".to_owned(),
                &generation,
                &session::store_lease(&core.store_id).await,
            ),
        )
        .await
        .expect("startup blocked on the activity lock")
        .unwrap();
    }

    #[tokio::test]
    async fn a_session_started_while_hidden_stays_suspended() {
        use crate::session::{AccountRegistry, PersistedAccount, current_session};
        use matrix_sdk_ui::sync_service::State;

        let (_store, server, core, room) = core_with_room().await;
        let client = room.client();
        let mut registry = AccountRegistry::empty();
        registry.upsert(PersistedAccount {
            account_id: "first".to_owned(),
            store_id: core.store_id.clone(),
            session: current_session(&client, server.server().uri()).unwrap(),
            needs_reauth: false,
            device_invalidated: false,
        });
        *core.accounts.lock().await = Some(registry);
        drop(core.take_session().await);
        core.set_app_active(false);

        let generation = core.claim_session_generation().await;
        core.start_session(
            client,
            server.server().uri(),
            "first".to_owned(),
            &generation,
            &session::store_lease(&core.store_id).await,
        )
        .await
        .unwrap();

        let sync_service = core.sync_service().await.unwrap();
        assert!(matches!(sync_service.state().get(), State::Idle));
        assert!(core.activity.sync_suspended());
    }

    async fn seed_search_index(
        client: &matrix_sdk::Client,
    ) -> Result<Vec<(Vec<u8>, Vec<u8>)>, Box<dyn std::error::Error>> {
        let room_id = room_id!("!indexed:example.org").to_owned();
        let search_values = [
            (
                b"sable.search.rooms".to_vec(),
                serde_json::to_vec(&vec![&room_id])?,
            ),
            (
                format!("sable.search.room.{room_id}").into_bytes(),
                serde_json::to_vec(&serde_json::json!({
                    "version": 5, "derived": 2, "next_chunk": 2, "edits": [],
                    "chunks": [
                        { "id": 0, "start": 0, "bytes": 100, "count": 1 },
                        { "id": 1, "start": 200, "bytes": 100, "count": 1 }
                    ]
                }))?,
            ),
            (
                b"sable.search.crawl".to_vec(),
                serde_json::to_vec(&serde_json::json!({
                    "version": 3,
                    "rooms": { room_id.to_string(): { "token": "older-page", "reached_start": false } }
                }))?,
            ),
        ];
        for (key, value) in &search_values {
            client
                .state_store()
                .set_custom_value(key, value.clone())
                .await?;
        }
        let mut chunks = Vec::new();
        for (id, timestamp) in [(0, 100), (1, 200)] {
            let key = format!("sable.search.chunk.{room_id}.{id}").into_bytes();
            let value = serde_json::to_vec(&serde_json::json!({
                "version": 5,
                "documents": [{
                    "event_id": format!("$indexed-{id}"), "body": "retained archaeology",
                    "sender": "@alice:example.org", "origin_server_ts": timestamp,
                    "attachments": [], "has_link": false, "mentions": [], "in_thread": false
                }],
                "classified": [[format!("$indexed-{id}"), timestamp]]
            }))?;
            client
                .state_store()
                .set_custom_value(&key, value.clone())
                .await?;
            chunks.push((key, value));
        }
        Ok(search_values.into_iter().chain(chunks).collect())
    }

    async fn assert_search_index_restored(core: &Core) -> Result<(), tokio::time::error::Elapsed> {
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            while core.search_index.lock().await.documents() != 2 {
                tokio::task::yield_now().await;
            }
        })
        .await?;
        assert_eq!(
            core.search_index
                .lock()
                .await
                .search_pinned(
                    "archaeology",
                    &crate::search::IndexFilter::default(),
                    std::collections::HashSet::new(),
                    crate::api::search::SearchOrder::Rank,
                    10,
                    0
                )
                .await
                .len(),
            2,
            "both restored documents should match"
        );
        Ok(())
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_saved_session_restores_while_the_homeserver_is_down() {
        use crate::session::{AccountRegistry, Credentials, PersistedAccount, PersistedSession};

        let server = MatrixMockServer::new().await;
        let base =
            std::env::temp_dir().join(format!("sable-offline-{}", ruma::TransactionId::new()));
        let base_id = base.to_str().unwrap().to_owned();
        let (core, _events) = Core::new(base_id.clone(), Box::new(MemorySessionStore::default()));
        let mut registry = AccountRegistry::empty();
        let (account_id, store_id) = registry.allocate_account(&base_id);
        registry.active_account_id = Some(account_id.clone());
        let mut session = PersistedSession {
            oauth_issuer: None,
            oauth_redirect_uri: None,
            resolved_homeserver: None,
            homeserver: server.server().uri(),
            credentials: Credentials::Password(
                serde_json::from_value(serde_json::json!({
                    "user_id": "@alice:example.org",
                    "device_id": "DEVICE",
                    "access_token": "token"
                }))
                .unwrap(),
            ),
        };
        let client = session::restore_client(&store_id, &session, true)
            .await
            .unwrap();
        session::restore_credentials(&client, &session)
            .await
            .unwrap();
        drop(client);
        session.homeserver = "offline.invalid".to_owned();
        session.resolved_homeserver = Some(url::Url::parse("http://127.0.0.1:9").unwrap());
        registry.upsert(PersistedAccount {
            account_id,
            store_id,
            session,
            needs_reauth: false,
            device_invalidated: false,
        });
        core.sessions
            .save(serde_json::to_vec(&registry).unwrap())
            .await
            .unwrap();
        drop(server);

        let restored = core.restore().await.unwrap().unwrap();
        assert_eq!(restored.user_id.as_str(), "@alice:example.org");
        drop(core);
        let _ = std::fs::remove_dir_all(base);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_cache_reset_keeps_the_login_keys_and_search_index_but_not_the_sync_position() {
        use crate::session::{AccountRegistry, Credentials, PersistedAccount, PersistedSession};
        use matrix_sdk_base::crypto::store::CryptoStore as _;

        let server = MatrixMockServer::new().await;
        let base = std::env::temp_dir().join(format!("sable-reset-{}", ruma::TransactionId::new()));
        let base_id = base.to_str().unwrap().to_owned();
        let (core, _events) = Core::new(base_id.clone(), Box::new(MemorySessionStore::default()));
        let mut registry = AccountRegistry::empty();
        let (account_id, store_id) = registry.allocate_account(&base_id);
        registry.active_account_id = Some(account_id.clone());
        registry.upsert(PersistedAccount {
            account_id,
            store_id: store_id.clone(),
            session: PersistedSession {
                oauth_issuer: None,
                oauth_redirect_uri: None,
                resolved_homeserver: None,
                homeserver: server.server().uri(),
                credentials: Credentials::Password(
                    serde_json::from_value(serde_json::json!({
                        "user_id": "@alice:example.org",
                        "device_id": "DEVICE",
                        "access_token": "token"
                    }))
                    .unwrap(),
                ),
            },
            needs_reauth: false,
            device_invalidated: false,
        });
        core.sessions
            .save(serde_json::to_vec(&registry).unwrap())
            .await
            .unwrap();
        let client = session::restore_client(&store_id, &registry.accounts[0].session, true)
            .await
            .unwrap();
        session::restore_credentials(&client, &registry.accounts[0].session)
            .await
            .unwrap();
        // Seeded before the session starts its search indexer, which would overwrite it.
        let search_values = seed_search_index(&client).await.unwrap();
        drop(client);
        core.restore().await.unwrap();

        let client = core.client().await.unwrap();
        let identity = client.encryption().ed25519_key().await;
        assert!(identity.is_some());
        client
            .state_store()
            .set_custom_value(b"marker", b"cached".to_vec())
            .await
            .unwrap();
        let store = std::path::Path::new(&store_id).join("store");
        let pos = "sliding_sync_store::room-list::@alice:example.org::instance";
        matrix_sdk::SqliteCryptoStore::open(&store, None)
            .await
            .unwrap()
            .set_custom_value(pos, br#"{"pos":"stale"}"#.to_vec())
            .await
            .unwrap();
        drop(client);

        core.reset_local_cache().await.unwrap();

        let client = core.client().await.unwrap();
        for (key, value) in &search_values {
            assert_eq!(
                client
                    .state_store()
                    .get_custom_value(key)
                    .await
                    .unwrap()
                    .as_ref(),
                Some(value)
            );
        }
        assert_search_index_restored(&core).await.unwrap();
        assert!(
            client
                .state_store()
                .get_custom_value(b"marker")
                .await
                .unwrap()
                .is_none()
        );
        assert_eq!(client.encryption().ed25519_key().await, identity);
        assert!(
            matrix_sdk::SqliteCryptoStore::open(&store, None)
                .await
                .unwrap()
                .get_custom_value(pos)
                .await
                .unwrap()
                .is_none()
        );

        let session = core.take_session().await.unwrap();
        session.sync_service.stop().await;
        drop((session, client));
        std::fs::remove_dir_all(&store_id).unwrap();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn late_refresh_persists_after_teardown_and_reuses_live_client() {
        use crate::session::{AccountRegistry, PersistedAccount, current_session};
        use wiremock::{
            Mock,
            matchers::{method, path},
        };
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().unlogged().build().await;
        let matrix: matrix_sdk::authentication::matrix::MatrixSession = serde_json::from_value(serde_json::json!({
            "user_id": "@alice:example.org", "device_id": "DEVICE", "access_token": "old-access", "refresh_token": "old-refresh"
        })).unwrap();
        client.restore_session(matrix).await.unwrap();
        let sync_service = Arc::new(SyncService::builder(client.clone()).build().await.unwrap());
        let persisted = Arc::new(parking_lot::Mutex::new(None));
        let persistence_started = Arc::new(tokio::sync::Notify::new());
        let release_persistence = Arc::new(tokio::sync::Notify::new());
        let base = tempfile::tempdir().unwrap();
        let (core, _events) = Core::new(
            base.path().to_str().unwrap(),
            Box::new(DelayedSecondSave {
                attempts: Arc::new(std::sync::atomic::AtomicUsize::new(0)),
                bytes: persisted.clone(),
                started: persistence_started.clone(),
                release: release_persistence.clone(),
            }),
        );
        let mut registry = AccountRegistry::empty();
        registry.upsert(PersistedAccount {
            account_id: "first".to_owned(),
            store_id: "unused".to_owned(),
            session: current_session(&client, server.server().uri()).unwrap(),
            needs_reauth: false,
            device_invalidated: false,
        });
        *core.accounts.lock().await = Some(registry);
        core.prepare_account_client(&client, &server.server().uri(), "first")
            .await
            .unwrap();
        *core.session.write().await = Some(Session {
            account_id: "first".to_owned(),
            client: client.clone(),
            sync_service,
            homeserver: server.server().uri(),
            oauth: false,
        });

        let arrived = Arc::new(tokio::sync::Notify::new());
        let (release, wait) = std::sync::mpsc::sync_channel(1);
        let wait = parking_lot::Mutex::new(wait);
        let received = arrived.clone();
        Mock::given(method("POST"))
            .and(path("/_matrix/client/v3/refresh"))
            .respond_with(move |_: &wiremock::Request| {
                received.notify_one();
                wait.lock()
                    .recv_timeout(std::time::Duration::from_secs(10))
                    .unwrap();
                ResponseTemplate::new(200).set_body_json(
                    serde_json::json!({"access_token":"new-access", "refresh_token":"new-refresh"}),
                )
            })
            .expect(1)
            .mount(server.server())
            .await;
        let refreshing_client = client.clone();
        let refresh =
            tokio::spawn(
                async move { refreshing_client.matrix_auth().refresh_access_token().await },
            );
        tokio::time::timeout(std::time::Duration::from_secs(5), arrived.notified())
            .await
            .unwrap();
        core.lifecycle.set_current(2);
        let previous = core.take_session().await.unwrap();
        previous.sync_service.stop().await;
        let account = core.accounts().await.unwrap().accounts.remove(0);
        let lease = session::store_lease(&account.store_id).await;
        let resumed = core.saved_account_client(&account, &lease).await.unwrap();
        release.send(()).unwrap();
        tokio::time::timeout(
            std::time::Duration::from_secs(5),
            persistence_started.notified(),
        )
        .await
        .unwrap();
        assert!(!refresh.is_finished());
        release_persistence.notify_one();
        refresh.await.unwrap().unwrap();
        assert_eq!(
            resumed.session_tokens().unwrap().refresh_token.as_deref(),
            Some("new-refresh")
        );
        assert_eq!(
            saved_refresh_token(&core, &account).as_deref(),
            Some("new-refresh")
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_refresh_during_an_abandoned_restore_is_saved() {
        use crate::session::{AccountRegistry, Credentials, PersistedAccount, PersistedSession};
        use wiremock::{
            Mock,
            matchers::{method, path_regex},
        };

        let server = MatrixMockServer::new().await;
        server.mock_versions().ok().mount().await;
        let base = std::env::temp_dir().join(format!(
            "sable-restore-refresh-{}",
            ruma::TransactionId::new()
        ));
        let base_id = base.to_str().unwrap().to_owned();
        let (core, _events) = Core::new(base_id.clone(), Box::new(MemorySessionStore::default()));
        let mut registry = AccountRegistry::empty();
        let (account_id, store_id) = registry.allocate_account(&base_id);
        registry.active_account_id = Some(account_id.clone());
        registry.upsert(PersistedAccount {
            account_id,
            store_id: store_id.clone(),
            session: PersistedSession {
                oauth_issuer: None,
                oauth_redirect_uri: None,
                resolved_homeserver: None,
                homeserver: server.server().uri(),
                credentials: Credentials::Password(
                    serde_json::from_value(serde_json::json!({
                        "user_id": "@alice:example.org",
                        "device_id": "DEVICE",
                        "access_token": "old-access",
                        "refresh_token": "old-refresh"
                    }))
                    .unwrap(),
                ),
            },
            needs_reauth: false,
            device_invalidated: false,
        });
        core.sessions
            .save(serde_json::to_vec(&registry).unwrap())
            .await
            .unwrap();
        let seeded = session::restore_client(&store_id, &registry.accounts[0].session, true)
            .await
            .unwrap();
        session::restore_credentials(&seeded, &registry.accounts[0].session)
            .await
            .unwrap();
        drop(seeded);

        Mock::given(method("POST"))
            .and(path_regex("/refresh$"))
            .respond_with(ResponseTemplate::new(200).set_body_json(
                serde_json::json!({"access_token": "new-access", "refresh_token": "new-refresh"}),
            ))
            .mount(server.server())
            .await;
        let account = core.accounts().await.unwrap().accounts.remove(0);
        let lease = session::store_lease(&account.store_id).await;
        let client = core.saved_account_client(&account, &lease).await.unwrap();
        client.refresh_access_token().await.unwrap();

        assert_eq!(
            saved_refresh_token(&core, &account).as_deref(),
            Some("new-refresh")
        );
        drop(client);
        std::fs::remove_dir_all(&store_id).unwrap();
    }
    async fn logged_in_core() -> (tempfile::TempDir, Arc<Core>, PersistedAccount) {
        use crate::session::{AccountRegistry, current_session};
        let (_store, server, _, room) = core_with_room().await;
        let base = tempfile::tempdir().unwrap();
        let (core, _) = Core::new(
            base.path().to_str().unwrap(),
            Box::new(MemorySessionStore::default()),
        );
        *core.accounts.lock().await = Some(AccountRegistry::empty());
        let persisted = current_session(&room.client(), server.server().uri()).unwrap();
        core.persist("first", &core.store_id, &persisted, None)
            .await
            .unwrap();
        let account = core.accounts().await.unwrap().accounts.remove(0);
        (base, core, account)
    }

    fn has_login_file(base: &tempfile::TempDir, account: &PersistedAccount) -> bool {
        crate::credentials::LoginTokens::new(base.path())
            .read(
                &account.account_id,
                &account.session.credentials.device_id(),
            )
            .is_ok_and(|tokens| tokens.is_ok())
    }
    async fn restorable_core() -> (
        MatrixMockServer,
        tempfile::TempDir,
        Arc<Core>,
        PersistedAccount,
        tokio::sync::mpsc::UnboundedReceiver<crate::protocol::CoreEvent>,
    ) {
        let (_store, server, _, room) = core_with_room().await;
        let base = tempfile::tempdir().unwrap();
        let (core, events) = Core::new(
            base.path().join("data").to_str().unwrap(),
            Box::new(MemorySessionStore::default()),
        );
        let account = PersistedAccount {
            account_id: "first".to_owned(),
            store_id: session::account_store_id(&core.store_id, "first"),
            session: session::current_session(&room.client(), server.server().uri()).unwrap(),
            needs_reauth: false,
            device_invalidated: false,
        };
        let seeded = session::restore_client(&account.store_id, &account.session, true)
            .await
            .unwrap();
        session::restore_credentials(&seeded, &account.session)
            .await
            .unwrap();
        drop(seeded);
        let mut registry = session::AccountRegistry::empty();
        registry.active_account_id = Some(account.account_id.clone());
        registry.upsert(account.clone());
        core.save_login_tokens(&account).await.unwrap();
        core.write_registry(&registry).await.unwrap();
        (server, base, core, account, events)
    }

    #[tokio::test]
    async fn tokens_sealed_with_another_key_ask_to_sign_in_again_once() {
        let (_server, _base, core, account, mut events) = restorable_core().await;
        let device_id = account.session.credentials.device_id();
        crate::test_support::plant_tokens_sealed_with_another_key(
            std::path::Path::new(&core.store_id),
            &account.account_id,
            &device_id,
            &account.session.credentials.tokens(),
        );
        let logs = crate::test_support::TestWriter::default();
        let capture = tracing::subscriber::set_default(
            tracing_subscriber::fmt()
                .with_ansi(false)
                .with_max_level(tracing::Level::WARN)
                .with_writer({
                    let logs = logs.clone();
                    move || logs.clone()
                })
                .finish(),
        );

        assert!(core.restore().await.unwrap().is_none());
        assert!(core.restore().await.unwrap().is_none());
        core.switch_account(crate::api::session::SwitchAccountParams {
            account_id: account.account_id.clone(),
        })
        .await
        .unwrap_err();

        drop(capture);
        let accounts = core.accounts().await.unwrap();
        assert!(accounts.accounts[0].needs_reauth);
        assert!(!accounts.accounts[0].device_invalidated);
        assert_eq!(accounts.accounts[0].store_id, account.store_id);
        assert!(std::path::Path::new(&account.store_id).exists());
        let lines: Vec<_> = String::from_utf8_lossy(&logs.0.lock())
            .lines()
            .map(ToOwned::to_owned)
            .collect();
        assert!(
            lines.iter().all(|line| !line.contains("ERROR")),
            "{lines:?}"
        );
        assert_eq!(lines.len(), 1, "{lines:?}");
        assert!(lines[0].contains("sealed_with_another_key"), "{lines:?}");
        while let Ok(event) = events.try_recv() {
            assert!(
                !matches!(event, crate::protocol::CoreEvent::Failure { .. }),
                "{event:?}"
            );
        }
        core.shutdown().await;
    }

    #[tokio::test]
    async fn missing_login_tokens_preserve_the_registry_until_storage_recovers() {
        use crate::session::AccountRegistry;
        let (_server, _base, core, account, _events) = restorable_core().await;
        let bytes = core.sessions.load().await.unwrap().unwrap();
        let (mut registry, _) = AccountRegistry::from_bytes(&bytes, &core.store_id).unwrap();
        assert_eq!(
            registry.accounts[0]
                .session
                .credentials
                .tokens()
                .access_token,
            ""
        );
        let logins = crate::credentials::LoginTokens::new(std::path::Path::new(&core.store_id));
        core.accounts().await.unwrap();
        logins.forget(&account.account_id);

        assert!(!core.load_login_tokens(&mut registry).await.unwrap());
        core.restore().await.unwrap_err();
        assert_eq!(core.list_accounts().await.unwrap().len(), 1);
        assert_eq!(serde_json::to_vec(&registry).unwrap(), bytes);
        assert_eq!(core.sessions.load().await.unwrap().unwrap(), bytes);

        core.save_login_tokens(&account).await.unwrap();
        core.load_login_tokens(&mut registry).await.unwrap();
        assert_eq!(
            registry.accounts[0].session.credentials.tokens(),
            account.session.credentials.tokens()
        );
        assert_eq!(core.restore().await.unwrap().unwrap().account_id, "first");
        core.shutdown().await;
    }

    #[tokio::test]
    async fn unreadable_login_tokens_never_fall_back_to_stale_embedded_tokens() {
        let (_server, _base, core, account, _events) = restorable_core().await;
        let mut registry = core.accounts().await.unwrap();
        let before = core.sessions.load().await.unwrap().unwrap();
        let path = std::fs::read_dir(std::path::Path::new(&core.store_id).join("login-tokens"))
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .find(|path| {
                path.extension()
                    .is_some_and(|extension| extension == "tokens")
            })
            .unwrap();
        std::fs::write(&path, b"unreadable tokens").unwrap();

        assert!(!core.load_login_tokens(&mut registry).await.unwrap());
        core.restore().await.unwrap_err();
        assert_eq!(core.sessions.load().await.unwrap().unwrap(), before);
        assert_eq!(std::fs::read(&path).unwrap(), b"unreadable tokens");
        assert!(!core.accounts().await.unwrap().accounts[0].needs_reauth);

        core.save_login_tokens(&account).await.unwrap();
        assert_eq!(core.restore().await.unwrap().unwrap().account_id, "first");
        core.shutdown().await;
    }

    #[tokio::test]
    async fn restoring_an_account_retires_a_stale_sign_in_of_the_same_user() {
        let (_server, _base, core, first, _events) = restorable_core().await;
        let stale = PersistedAccount {
            account_id: "stale".to_owned(),
            store_id: session::account_store_id(&core.store_id, "stale"),
            ..first.clone()
        };
        std::fs::create_dir_all(std::path::Path::new(&stale.store_id).join("store")).unwrap();
        let mut registry = core.accounts().await.unwrap();
        registry.accounts.insert(0, stale.clone());
        core.write_registry(&registry).await.unwrap();
        *core.accounts.lock().await = Some(registry);

        assert_eq!(core.restore().await.unwrap().unwrap().account_id, "first");
        wait_until_retired(&core, "stale").await;

        let accounts = core.list_accounts().await.unwrap();
        assert_eq!(accounts.len(), 1);
        assert_eq!(accounts[0].account_id, "first");
        assert!(!std::path::Path::new(&stale.store_id).exists());
        core.shutdown().await;
    }

    #[tokio::test]
    async fn restoring_a_stale_active_sign_in_starts_the_newer_one_instead() {
        let (_server, _base, core, first, _events) = restorable_core().await;
        let newer = PersistedAccount {
            account_id: "newer".to_owned(),
            store_id: session::account_store_id(&core.store_id, "newer"),
            ..first.clone()
        };
        let seeded = session::restore_client(&newer.store_id, &newer.session, true)
            .await
            .unwrap();
        session::restore_credentials(&seeded, &newer.session)
            .await
            .unwrap();
        drop(seeded);
        let mut registry = core.accounts().await.unwrap();
        registry.upsert(newer.clone());
        core.save_login_tokens(&newer).await.unwrap();
        core.write_registry(&registry).await.unwrap();
        *core.accounts.lock().await = Some(registry);

        assert_eq!(core.restore().await.unwrap().unwrap().account_id, "newer");
        wait_until_retired(&core, "first").await;

        let accounts = core.list_accounts().await.unwrap();
        assert_eq!(accounts.len(), 1);
        assert_eq!(accounts[0].account_id, "newer");
        assert!(!std::path::Path::new(&first.store_id).exists());
        assert!(std::path::Path::new(&newer.store_id).exists());
        core.shutdown().await;
    }

    /// Replaced sign-ins retire in the background once the new session is up.
    /// Another sign-in of `first`'s user, on its own device and store.
    fn other_sign_in(core: &Core, first: &PersistedAccount, account_id: &str) -> PersistedAccount {
        let mut persisted = serde_json::to_value(&first.session).unwrap();
        persisted["credentials"]["device_id"] = format!("{account_id}-device").into();
        persisted["credentials"]["access_token"] = format!("{account_id}-token").into();
        let account = PersistedAccount {
            account_id: account_id.to_owned(),
            store_id: session::account_store_id(&core.store_id, account_id),
            session: serde_json::from_value(persisted).unwrap(),
            ..first.clone()
        };
        std::fs::create_dir_all(std::path::Path::new(&account.store_id).join("store")).unwrap();
        account
    }

    #[tokio::test]
    async fn a_stale_sign_in_stays_until_a_started_session_retires_it() {
        let (_server, _base, core, first, _events) = restorable_core().await;
        let stale = other_sign_in(&core, &first, "stale");
        let mut registry = core.accounts().await.unwrap();
        registry.accounts.insert(0, stale.clone());
        registry.active_account_id = None;
        core.write_registry(&registry).await.unwrap();
        *core.accounts.lock().await = Some(registry);

        assert!(core.restore().await.unwrap().is_none());

        let accounts = core.accounts().await.unwrap().accounts;
        assert!(accounts.iter().any(|account| account.account_id == "stale"));
        assert!(std::path::Path::new(&stale.store_id).exists());

        let mut registry = core.accounts().await.unwrap();
        registry.active_account_id = Some("first".to_owned());
        *core.accounts.lock().await = Some(registry);
        assert_eq!(core.restore().await.unwrap().unwrap().account_id, "first");
        wait_until_retired(&core, "stale").await;

        let accounts = core.list_accounts().await.unwrap();
        assert_eq!(accounts.len(), 1);
        assert_eq!(accounts[0].account_id, "first");
        assert!(!std::path::Path::new(&stale.store_id).exists());
        core.shutdown().await;
    }

    #[tokio::test]
    async fn a_stale_sign_in_whose_room_keys_cannot_be_carried_stays_registered() {
        let (_server, _base, core, first, _events) = restorable_core().await;
        let stale = other_sign_in(&core, &first, "stale");
        std::fs::write(
            std::path::Path::new(&stale.store_id).join("store/matrix-sdk-crypto.sqlite3"),
            b"not a database",
        )
        .unwrap();
        // Retired after the stale one, so its retirement shows the stale one's attempt is over.
        let later = other_sign_in(&core, &first, "later");
        let mut registry = core.accounts().await.unwrap();
        registry.accounts.insert(0, later);
        registry.accounts.insert(0, stale.clone());
        core.write_registry(&registry).await.unwrap();
        *core.accounts.lock().await = Some(registry);

        assert_eq!(core.restore().await.unwrap().unwrap().account_id, "first");
        wait_until_retired(&core, "later").await;

        let accounts = core.accounts().await.unwrap().accounts;
        let kept = accounts
            .iter()
            .find(|account| account.account_id == "stale")
            .expect("the stale sign-in waits for a later retry");
        assert!(kept.needs_reauth);
        assert!(std::path::Path::new(&stale.store_id).exists());
        core.shutdown().await;
    }

    #[tokio::test]
    async fn retiring_a_stale_sign_in_signs_its_own_device_out() {
        use wiremock::{
            Mock, ResponseTemplate,
            matchers::{method, path},
        };
        let (server, _base, core, first, _events) = restorable_core().await;
        Mock::given(method("POST"))
            .and(path("/_matrix/client/v3/logout"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({})))
            .expect(1)
            .mount(server.server())
            .await;
        let stale = other_sign_in(&core, &first, "stale");
        let twin = PersistedAccount {
            session: first.session.clone(),
            ..other_sign_in(&core, &first, "twin")
        };
        let mut registry = core.accounts().await.unwrap();
        for account in [&twin, &stale] {
            registry.accounts.insert(0, account.clone());
            core.save_login_tokens(account).await.unwrap();
        }
        core.write_registry(&registry).await.unwrap();
        *core.accounts.lock().await = Some(registry);

        assert_eq!(core.restore().await.unwrap().unwrap().account_id, "first");
        wait_until_retired(&core, "stale").await;
        wait_until_retired(&core, "twin").await;

        assert_eq!(core.list_accounts().await.unwrap().len(), 1);
        server.server().verify().await;
        core.shutdown().await;
    }

    #[tokio::test]
    async fn restoring_does_not_wait_for_a_replaced_device_to_sign_out() {
        use wiremock::{
            Mock, ResponseTemplate,
            matchers::{method, path},
        };
        let (server, _base, core, first, _events) = restorable_core().await;
        Mock::given(method("POST"))
            .and(path("/_matrix/client/v3/logout"))
            .respond_with(ResponseTemplate::new(200).set_delay(std::time::Duration::from_secs(60)))
            .mount(server.server())
            .await;
        let stale = other_sign_in(&core, &first, "stale");
        let mut registry = core.accounts().await.unwrap();
        registry.accounts.insert(0, stale.clone());
        core.save_login_tokens(&stale).await.unwrap();
        core.write_registry(&registry).await.unwrap();
        *core.accounts.lock().await = Some(registry);

        assert_eq!(core.restore().await.unwrap().unwrap().account_id, "first");
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            while !server
                .server()
                .received_requests()
                .await
                .unwrap()
                .iter()
                .any(|request| request.url.path() == "/_matrix/client/v3/logout")
            {
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("the old device's sign-out reaches the server");

        let logins = crate::credentials::LoginTokens::new(std::path::Path::new(&core.store_id));
        let device_id = stale.session.credentials.device_id();
        assert!(matches!(logins.read("stale", &device_id), Ok(Ok(_))));
        assert!(std::path::Path::new(&stale.store_id).exists());
        core.shutdown().await;
    }

    #[tokio::test]
    async fn an_account_whose_store_cannot_be_deleted_stays_listed_for_another_removal() {
        use crate::api::session::RemoveAccountParams;
        let (_server, _base, core, first, _events) = restorable_core().await;
        let mut persisted = serde_json::to_value(&first.session).unwrap();
        persisted["credentials"]["user_id"] = "@second:example.org".into();
        let second = PersistedAccount {
            session: serde_json::from_value(persisted).unwrap(),
            ..other_sign_in(&core, &first, "second")
        };
        // Disposal refuses a store outside the allocated ones.
        let unrelated = PersistedAccount {
            store_id: format!("{}-elsewhere", core.store_id),
            ..second.clone()
        };
        let mut registry = core.accounts().await.unwrap();
        registry.upsert(unrelated);
        core.save_login_tokens(&second).await.unwrap();
        core.write_registry(&registry).await.unwrap();
        *core.accounts.lock().await = Some(registry);
        let remove = || {
            core.remove_inactive_account(RemoveAccountParams {
                account_id: "second".to_owned(),
            })
        };

        remove().await.unwrap_err();

        let mut registry = core.accounts().await.unwrap();
        let kept = registry
            .accounts
            .iter_mut()
            .find(|account| account.account_id == "second")
            .expect("an account whose store is left stays listed");
        assert!(kept.needs_reauth);
        kept.store_id.clone_from(&second.store_id);
        *core.accounts.lock().await = Some(registry);
        remove().await.unwrap();
        let accounts = core.accounts().await.unwrap().accounts;
        assert!(
            accounts
                .iter()
                .all(|account| account.account_id != "second")
        );
        assert!(!std::path::Path::new(&second.store_id).exists());
        core.shutdown().await;
    }

    #[tokio::test]
    async fn a_new_sign_in_keeps_the_one_it_replaces_until_it_is_retired() {
        let (_server, _base, core, first, _events) = restorable_core().await;
        core.accounts().await.unwrap();
        let newer = other_sign_in(&core, &first, "newer");

        core.persist(&newer.account_id, &newer.store_id, &newer.session, None)
            .await
            .unwrap();

        let accounts = core.accounts().await.unwrap().accounts;
        let replaced = accounts
            .iter()
            .find(|account| account.account_id == "first")
            .expect("the replaced sign-in stays until its session is retired");
        assert!(replaced.needs_reauth);
        assert!(std::path::Path::new(&first.store_id).exists());
        core.shutdown().await;
    }

    #[tokio::test]
    async fn unreadable_inactive_tokens_do_not_block_other_accounts_or_removal() {
        use crate::api::session::{RemoveAccountParams, SwitchAccountParams};
        let (_server, _base, core, first, _events) = restorable_core().await;
        let mut persisted = serde_json::to_value(&first.session).unwrap();
        persisted["credentials"]["user_id"] = "@second:example.org".into();
        let second = PersistedAccount {
            account_id: "second".to_owned(),
            store_id: session::account_store_id(&core.store_id, "second"),
            session: serde_json::from_value(persisted).unwrap(),
            ..first.clone()
        };
        let mut registry = core.accounts().await.unwrap();
        registry.upsert(second.clone());
        core.save_login_tokens(&second).await.unwrap();
        core.write_registry(&registry).await.unwrap();
        *core.accounts.lock().await = None;
        let path = std::fs::read_dir(std::path::Path::new(&core.store_id).join("login-tokens"))
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .find(|path| {
                path.file_name()
                    .unwrap()
                    .to_str()
                    .unwrap()
                    .starts_with("second.")
            })
            .unwrap();
        std::fs::write(&path, b"unreadable tokens").unwrap();
        let before = core.sessions.load().await.unwrap().unwrap();
        assert_eq!(core.list_accounts().await.unwrap().len(), 2);
        assert_eq!(core.restore().await.unwrap().unwrap().account_id, "first");
        core.switch_account(SwitchAccountParams {
            account_id: "second".to_owned(),
        })
        .await
        .unwrap_err();
        assert_eq!(core.active_session_info().unwrap().account_id, "first");
        assert_eq!(core.sessions.load().await.unwrap().unwrap(), before);
        assert_eq!(std::fs::read(&path).unwrap(), b"unreadable tokens");
        assert!(!core.accounts().await.unwrap().accounts[1].needs_reauth);

        core.remove_inactive_account(RemoveAccountParams {
            account_id: "second".to_owned(),
        })
        .await
        .unwrap();
        assert_eq!(core.list_accounts().await.unwrap().len(), 1);
        assert!(!path.exists());
        crate::credentials::LoginTokens::new(std::path::Path::new(&core.store_id))
            .read(&first.account_id, &first.session.credentials.device_id())
            .unwrap()
            .unwrap();
        core.shutdown().await;
    }

    #[tokio::test]
    async fn a_registry_drops_only_the_tokens_a_login_file_holds() {
        let (base, core, account) = logged_in_core().await;
        let mut registry = core.accounts().await.unwrap();
        registry.upsert(PersistedAccount {
            account_id: "unmoved".to_owned(),
            ..account.clone()
        });
        let mut empty = account.session.credentials.tokens();
        empty.access_token.clear();
        crate::credentials::LoginTokens::new(base.path())
            .save("unmoved", &account.session.credentials.device_id(), &empty)
            .unwrap();
        core.write_registry(&registry).await.unwrap();

        let saved = core.sessions.load().await.unwrap().unwrap();
        let (saved, _) = session::AccountRegistry::from_bytes(&saved, &core.store_id).unwrap();
        let tokens = |id: &str| {
            saved
                .accounts
                .iter()
                .find(|account| account.account_id == id)
                .unwrap()
                .session
                .credentials
                .tokens()
                .access_token
        };
        assert!(has_login_file(&base, &account));
        assert_eq!(tokens("first"), "");
        assert_eq!(
            tokens("unmoved"),
            account.session.credentials.tokens().access_token
        );
    }

    #[tokio::test]
    async fn retiring_a_device_and_removing_an_account_forget_its_login_file() {
        let (base, core, account) = logged_in_core().await;
        core.mark_account_needs_reauth(Some("first"), false)
            .await
            .unwrap();
        assert!(has_login_file(&base, &account));
        core.mark_account_needs_reauth(Some("first"), true)
            .await
            .unwrap();
        assert!(!has_login_file(&base, &account));

        let (base, core, account) = logged_in_core().await;
        core.remove_account(Some("first")).await.unwrap();
        assert!(!has_login_file(&base, &account));
    }

    fn saved_refresh_token(core: &Core, account: &PersistedAccount) -> Option<String> {
        crate::credentials::LoginTokens::new(std::path::Path::new(&core.store_id))
            .read(
                &account.account_id,
                &account.session.credentials.device_id(),
            )
            .ok()?
            .ok()?
            .refresh_token
    }

    struct RejectSaves {
        attempts: Arc<std::sync::atomic::AtomicUsize>,
    }

    #[async_trait::async_trait]
    impl crate::store::SessionStore for RejectSaves {
        async fn load(&self) -> Result<Option<Vec<u8>>, crate::store::StoreError> {
            Ok(None)
        }
        async fn save(&self, _: Vec<u8>) -> Result<(), crate::store::StoreError> {
            self.attempts
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            Err(crate::store::StoreError::Message("disk is full".to_owned()))
        }
        async fn clear(&self) -> Result<(), crate::store::StoreError> {
            Ok(())
        }
    }

    #[tokio::test]
    async fn rejected_tokens_stay_retired_when_the_registry_write_fails() {
        use crate::session::{AccountRegistry, PersistedAccount, current_session};
        let (_store, server, _, room) = core_with_room().await;
        let base = tempfile::tempdir().unwrap();
        let (core, _) = Core::new(
            base.path().to_str().unwrap(),
            Box::new(RejectSaves {
                attempts: Arc::new(std::sync::atomic::AtomicUsize::new(0)),
            }),
        );
        let mut registry = AccountRegistry::empty();
        registry.active_account_id = Some("first".to_owned());
        let account = PersistedAccount {
            account_id: "first".to_owned(),
            store_id: "unused".to_owned(),
            session: current_session(&room.client(), server.server().uri()).unwrap(),
            needs_reauth: false,
            device_invalidated: false,
        };
        core.save_login_tokens(&account).await.unwrap();
        let device_id = account.session.credentials.device_id();
        registry.upsert(account);
        *core.accounts.lock().await = Some(registry);
        core.credential_writers
            .lock()
            .await
            .insert("first".into(), 1);
        core.mark_account_needs_reauth(Some("first"), true)
            .await
            .unwrap_err();
        crate::credentials::LoginTokens::new(base.path())
            .read("first", &device_id)
            .unwrap()
            .unwrap();
        let accounts = core.accounts().await.unwrap();
        assert!(accounts.active_account_id.is_none());
        assert!(accounts.accounts[0].needs_reauth);
        assert!(accounts.accounts[0].device_invalidated);
        assert!(core.credential_writers.lock().await.is_empty());
    }

    #[tokio::test]
    async fn failed_switch_persistence_keeps_the_previous_session() {
        use crate::session::{AccountRegistry, PersistedAccount, current_session};
        let (_store, server, previous_core, _) = core_with_room().await;
        let previous = previous_core.take_session().await.unwrap();
        let client = previous.client.clone();
        let sync_service = previous.sync_service.clone();
        let attempts = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let (core, _events) = Core::new(
            "failure-regression",
            Box::new(RejectSaves {
                attempts: attempts.clone(),
            }),
        );
        let mut registry = AccountRegistry::empty();
        registry.active_account_id = Some("first".to_owned());
        for account_id in ["first", "second"] {
            registry.upsert(PersistedAccount {
                account_id: account_id.to_owned(),
                store_id: "unused".to_owned(),
                session: current_session(&client, server.server().uri()).unwrap(),
                needs_reauth: false,
                device_invalidated: false,
            });
        }
        *core.accounts.lock().await = Some(registry);
        *core.session.write().await = Some(previous);
        let generation = core.claim_session_generation().await;
        core.start_session(
            client,
            server.server().uri(),
            "second".to_owned(),
            &generation,
            &session::store_lease("unused").await,
        )
        .await
        .expect_err("switch must report the failed registry write");
        assert_eq!(attempts.load(std::sync::atomic::Ordering::SeqCst), 1);
        let session = core.session.read().await;
        let session = session.as_ref().unwrap();
        assert_eq!(session.account_id, "first");
        assert!(Arc::ptr_eq(&session.sync_service, &sync_service));
        assert_eq!(
            core.accounts().await.unwrap().active_account_id.as_deref(),
            Some("first")
        );
        drop(generation);
        assert_eq!(core.lifecycle.current(), 1);
    }

    #[tokio::test]
    async fn token_reload_reads_the_durable_session_and_refuses_retired_writers() {
        use crate::session::{AccountRegistry, PersistedAccount, current_session};
        let (_store, server, core, room) = core_with_room().await;
        let client = room.client();
        let mut registry = AccountRegistry::empty();
        let mut saved = current_session(&client, server.server().uri()).unwrap();
        if let Credentials::Password(session) = &mut saved.credentials {
            session.tokens.access_token = "rotated-access".into();
            session.tokens.refresh_token = Some("rotated-refresh".into());
        }
        let account = PersistedAccount {
            account_id: "first".into(),
            store_id: "unused".into(),
            session: saved,
            needs_reauth: false,
            device_invalidated: false,
        };
        core.save_login_tokens(&account).await.unwrap();
        registry.upsert(account);
        *core.accounts.lock().await = Some(registry);
        core.credential_writers
            .lock()
            .await
            .insert("first".into(), 1);
        let tokens = core.reload_saved_tokens("first", 1).await.unwrap();
        assert_eq!(tokens.access_token, "rotated-access");
        assert_eq!(tokens.refresh_token.as_deref(), Some("rotated-refresh"));
        assert_ne!(
            tokens.access_token,
            client.session_tokens().unwrap().access_token
        );
        let mut empty = core.accounts().await.unwrap().accounts.remove(0);
        empty.session.credentials.discard_tokens();
        core.save_login_tokens(&empty).await.unwrap();
        core.reload_saved_tokens("first", 1).await.unwrap_err();
        core.credential_writers.lock().await.remove("first");
        assert!(matches!(
            core.reload_saved_tokens("first", 1).await,
            Err(RpcError {
                code: RpcCode::NotLoggedIn,
                ..
            })
        ));
    }

    #[tokio::test]
    async fn outgoing_credentials_survive_switch_without_resurrecting_accounts() {
        use crate::session::{AccountRegistry, Credentials, PersistedAccount, current_session};

        let (_store, _server, core, room) = core_with_room().await;
        let client = room.client();
        let fresh = current_session(&client, "example.org".to_owned()).unwrap();
        let mut stale = fresh.clone();
        if let Credentials::Password(matrix) = &mut stale.credentials {
            matrix.tokens.access_token = "stale".to_owned();
        }
        let mut registry = AccountRegistry::empty();
        registry.upsert(PersistedAccount {
            account_id: "first".to_owned(),
            store_id: core.store_id.clone(),
            session: stale.clone(),
            needs_reauth: false,
            device_invalidated: false,
        });
        *core.accounts.lock().await = Some(registry);
        core.credential_writers
            .lock()
            .await
            .insert("first".to_owned(), 1);
        core.lifecycle.set_current(2);
        core.persist_refreshed(&client, "example.org", "first", 1)
            .await
            .unwrap();
        let saved = core.accounts().await.unwrap();
        assert_eq!(
            serde_json::to_value(&saved.accounts[0].session).unwrap(),
            serde_json::to_value(&fresh).unwrap()
        );

        core.accounts.lock().await.as_mut().unwrap().accounts[0].session = stale.clone();
        core.credential_writers
            .lock()
            .await
            .insert("first".to_owned(), 3);
        core.persist_refreshed(&client, "example.org", "first", 1)
            .await
            .unwrap();
        assert_eq!(
            serde_json::to_value(&core.accounts().await.unwrap().accounts[0].session).unwrap(),
            serde_json::to_value(&stale).unwrap()
        );

        core.remove_account(Some("first")).await.unwrap();
        core.persist_refreshed(&client, "example.org", "first", 3)
            .await
            .unwrap();
        assert!(core.accounts().await.unwrap().accounts.is_empty());
    }

    #[tokio::test]
    async fn session_teardown_removes_thread_timelines() {
        let (_store, server, core, room) = core_with_room().await;
        server.mock_room_state_encryption().plain().mount().await;
        let room_id = room.room_id().to_owned();
        let thread_root = event_id!("$thread").to_owned();
        let timeline = core.timeline(&room_id).await.unwrap();
        core.thread_timelines.lock().await.insert(
            (room_id.clone(), thread_root.clone()),
            CachedTimeline {
                timeline: timeline.clone(),
                hidden_events: false,
            },
        );
        assert!(Arc::ptr_eq(
            &core.thread_timeline(&room_id, &thread_root).await.unwrap(),
            &timeline
        ));

        core.take_session().await;

        assert!(core.thread_timelines.lock().await.is_empty());
        assert!(matches!(
            core.thread_timeline(&room_id, &thread_root).await,
            Err(RpcError {
                code: RpcCode::NotLoggedIn,
                ..
            })
        ));
    }

    #[tokio::test]
    async fn a_slow_timeline_build_blocks_neither_another_room_nor_the_teardown() {
        let (_store, server, core, room) = core_with_room().await;
        let slow = room.room_id().to_owned();
        let fast = room_id!("!fast:example.org").to_owned();
        server.sync_joined_room(&room.client(), &fast).await;
        let requests = std::sync::atomic::AtomicUsize::new(0);
        server
            .mock_room_state_encryption()
            .respond_with(move |_: &wiremock::Request| {
                let response = ResponseTemplate::new(404).set_body_json(
                    serde_json::json!({"errcode":"M_NOT_FOUND", "error":"not found"}),
                );
                if requests.fetch_add(1, std::sync::atomic::Ordering::SeqCst) == 0 {
                    response.set_delay(std::time::Duration::from_secs(3))
                } else {
                    response
                }
            })
            .mount()
            .await;

        let mut slow_build = std::pin::pin!(core.live_timeline(&slow, false));
        assert!(futures_util::poll!(slow_build.as_mut()).is_pending());

        tokio::time::timeout(
            std::time::Duration::from_secs(5),
            core.live_timeline(&fast, false),
        )
        .await
        .expect("another room must open while one builds")
        .unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(5), core.take_session())
            .await
            .expect("the teardown must not wait for a build")
            .unwrap();

        assert!(matches!(
            slow_build.await,
            Err(RpcError {
                code: RpcCode::NotLoggedIn,
                ..
            })
        ));
        assert!(core.timelines.lock().await.is_empty());
    }

    #[tokio::test]
    async fn confirmed_unencrypted_rooms_still_allow_plaintext_operations() {
        let (_store, server, core, room) = core_with_room().await;
        server.mock_room_state_encryption().plain().mount().await;
        assert!(!core.room_is_encrypted(&room).await.unwrap());
    }

    #[tokio::test]
    async fn a_bookmark_in_an_encrypted_room_stores_no_message_details() {
        let (_store, server, core, room) = core_with_room().await;
        let room_id = room.room_id().to_owned();
        server
            .mock_room_state_encryption()
            .encrypted()
            .mount()
            .await;
        wiremock::Mock::given(wiremock::matchers::method("GET"))
            .and(wiremock::matchers::path_regex(r"/event/"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "type": "m.room.message",
                "event_id": "$secret",
                "room_id": room_id,
                "sender": "@alice:example.org",
                "origin_server_ts": 5,
                "content": { "msgtype": "m.image", "body": "holiday.png" },
            })))
            .mount(server.server())
            .await;
        wiremock::Mock::given(wiremock::matchers::method("GET"))
            .and(wiremock::matchers::path_regex(r"/account_data/"))
            .respond_with(
                ResponseTemplate::new(404).set_body_json(
                    serde_json::json!({"errcode":"M_NOT_FOUND", "error":"not found"}),
                ),
            )
            .mount(server.server())
            .await;
        wiremock::Mock::given(wiremock::matchers::method("PUT"))
            .and(wiremock::matchers::path_regex(r"/account_data/"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({})))
            .mount(server.server())
            .await;

        core.set_bookmark(&room_id, &event_id!("$secret").to_owned(), true, 1000)
            .await
            .unwrap();

        let requests = server.server().received_requests().await.unwrap();
        let item = requests
            .iter()
            .find(|request| {
                request.method.as_str() == "PUT"
                    && request.url.path().contains("pl.chrome.bookmark.")
            })
            .expect("bookmark item written");
        let body: serde_json::Value = serde_json::from_slice(&item.body).unwrap();
        assert!(body["uri"].as_str().unwrap().contains("?via="), "{body}");
        assert_eq!(body["msgtype"], serde_json::Value::Null, "{body}");
        assert_eq!(body["body_preview"], serde_json::Value::Null, "{body}");
    }

    #[tokio::test]
    async fn encryption_lookup_failure_prevents_plaintext_operations() {
        let (_store, server, core, room) = core_with_room().await;
        let room_id = room.room_id().to_owned();
        assert!(room.encryption_state().is_unknown());
        server
            .mock_room_state_encryption()
            .respond_with(ResponseTemplate::new(403).set_body_json(
                serde_json::json!({"errcode":"M_FORBIDDEN", "error":"state unavailable"}),
            ))
            .expect(3)
            .mount()
            .await;
        wiremock::Mock::given(wiremock::matchers::method("GET"))
            .and(wiremock::matchers::path_regex(r"/account_data/"))
            .respond_with(
                ResponseTemplate::new(404).set_body_json(
                    serde_json::json!({"errcode":"M_NOT_FOUND", "error":"not found"}),
                ),
            )
            .mount(server.server())
            .await;

        let scheduled = core
            .schedule_message(
                &room_id,
                RoomMessageEventContent::text_plain("secret"),
                1000,
                None,
            )
            .await;
        assert!(
            matches!(
                scheduled,
                Err(RpcError {
                    code: RpcCode::Denied,
                    ..
                })
            ),
            "{scheduled:?}"
        );
        assert!(matches!(
            core.set_bookmark(&room_id, &event_id!("$secret").to_owned(), true, 1000)
                .await,
            Err(RpcError {
                code: RpcCode::Denied,
                ..
            })
        ));
        assert!(matches!(
            core.join_call(
                room_id,
                Some("https://focus.example.org".to_owned()),
                None,
                None
            )
            .await,
            Err(RpcError {
                code: RpcCode::Denied,
                ..
            })
        ));

        let requests = server.server().received_requests().await.unwrap();
        let writes: Vec<_> = requests
            .iter()
            .filter(|request| matches!(request.method.as_str(), "PUT" | "POST"))
            .map(|request| request.url.path())
            .filter(|path| {
                path.contains("/rooms/")
                    || path.contains("/account_data/")
                    || path.ends_with("/openid/request_token")
            })
            .collect();
        assert!(
            writes.is_empty(),
            "unexpected plaintext operation: {writes:?}"
        );
    }
}
