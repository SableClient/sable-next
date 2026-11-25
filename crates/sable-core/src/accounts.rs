use crate::api::encryption::DeleteDeviceParams;
use crate::api::session::RemoveAccountParams;
use crate::api::session::SwitchAccountParams;
use crate::errors::CoreResultExt as _;
use std::sync::{Arc, atomic::Ordering};

use crate::tasks::JoinHandleExt;
use matrix_sdk::executor::spawn;

use matrix_sdk::ruma::api::client::discovery::get_authorization_server_metadata::v1::AuthorizationServerMetadata;
use matrix_sdk::ruma::api::client::uiaa::{AuthData, AuthType, Password, UserIdentifier};

use crate::ResultExt;
use crate::protocol::{CoreEvent, RpcCode, RpcError, SessionInfo};

use crate::session::AccountRegistry;
use crate::session::{AccountState, PersistedAccount, PersistedSession, Session};

use crate::Core;
use crate::SignedIn;
use crate::lifecycle::SessionGeneration;
use crate::search;
use crate::session;
use crate::supervisor::Supervised;

/// The other sign-ins of a user that a new one replaces.
#[derive(Debug, Default)]
pub(crate) struct ReplacedSignIns {
    pub(crate) all: Vec<String>,
    /// Those that were usable until now.
    pub(crate) usable: Vec<String>,
}

impl Core {
    pub(crate) async fn registered_store_id(&self, account_id: &str) -> Option<String> {
        self.accounts.lock().await.as_ref().and_then(|registry| {
            registry
                .accounts
                .iter()
                .find(|account| account.account_id == account_id)
                .map(|account| account.store_id.clone())
        })
    }

    pub(crate) async fn restore(self: &Arc<Self>) -> Result<Option<SessionInfo>, RpcError> {
        self.supervise("restore", |core, supervised| {
            Box::pin(async move { core.restore_supervised(&supervised).await })
        })
        .await?
    }

    async fn restore_supervised(
        self: &Arc<Self>,
        supervised: &Supervised<'_>,
    ) -> Result<Option<SessionInfo>, RpcError> {
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
        self.open_stores_for_session_start(supervised).await?;
        let client = match self.saved_account_client(supervised, &account).await {
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

        let generation = self.lifecycle.claim(supervised);
        let signed_in = self
            .start_session(
                client,
                persisted.homeserver,
                account.account_id,
                &generation,
                supervised,
            )
            .await?;
        signed_in.retire_replaced(stale, &account.store_id);

        Ok(Some(info))
    }

    #[expect(
        clippy::disallowed_methods,
        reason = "reports which account is active without acting on its session"
    )]
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
        params: SwitchAccountParams,
    ) -> Result<SessionInfo, RpcError> {
        self.supervise("switch account", |core, supervised| {
            Box::pin(async move { core.switch_supervised(&supervised, params).await })
        })
        .await?
    }

    async fn switch_supervised(
        self: &Arc<Self>,
        supervised: &Supervised<'_>,
        SwitchAccountParams { account_id }: SwitchAccountParams,
    ) -> Result<SessionInfo, RpcError> {
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
        self.open_stores_for_session_start(supervised).await?;
        self.session_step("opening the account");
        let client = self.saved_account_client(supervised, &account).await?;
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

        let generation = self.lifecycle.claim(supervised);
        self.sign_in.pending_registration.lock().take();
        self.sign_in.pending_login.lock().await.take();
        self.start_session(
            client,
            persisted.homeserver,
            account.account_id,
            &generation,
            supervised,
        )
        .await?;
        Ok(info)
    }

    pub(crate) async fn logout(self: &Arc<Self>) -> Result<(), RpcError> {
        if let Some(active) = self.active_session_info() {
            self.wait_for_lent_client(&active.account_id).await?;
        }
        let ended = self
            .supervise("end the session to log out", |core, supervised| {
                Box::pin(async move { core.end_session_for_logout(&supervised).await })
            })
            .await??;
        let Some((session, sync_stopped)) = ended else {
            return self
                .supervise("log out with no session", |core, supervised| {
                    Box::pin(async move { core.remove_account(&supervised, None).await })
                })
                .await?;
        };
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
        let signed_out =
            match matrix_sdk::timeout::timeout(Box::pin(request), LOG_OUT_TIMEOUT).await {
                Ok(Ok(())) => true,
                Ok(Err(error)) => {
                    tracing::warn!("server-side logout failed, clearing locally anyway: {error}");
                    false
                }
                Err(_) => {
                    tracing::warn!("server-side logout timed out, clearing locally anyway");
                    false
                }
            };
        if !(sync_stopped && session.state.quiesced().await) {
            if signed_out {
                // The server forgot the device, so signing in again must not reuse it.
                self.require_sign_in(&session.account_id, true).await?;
            }
            return Err(self.failed("logout", "the session's work did not stop"));
        }
        self.remove_retired(session.account_id).await
    }

    async fn end_session_for_logout(
        self: &Arc<Self>,
        supervised: &Supervised<'_>,
    ) -> Result<Option<(Session, bool)>, RpcError> {
        if let Some(active) = self.active_session_info() {
            self.wait_for_lent_client(&active.account_id).await?;
        }
        self.lifecycle.invalidate(supervised);
        self.sign_in.pending_registration.lock().take();
        self.sign_in.pending_login.lock().await.take();
        let Some(session) = self.take_session(supervised).await else {
            return Ok(None);
        };
        session.state.discarded.cancel();
        let sync_stopped = crate::sync_support::stop(&session.sync_service).await;
        self.mark_account_needs_reauth(supervised, Some(&session.account_id), false)
            .await?;
        Ok(Some((session, sync_stopped)))
    }

    async fn remove_retired(self: &Arc<Self>, account_id: String) -> Result<(), RpcError> {
        self.supervise("remove a retired account", move |core, supervised| {
            Box::pin(async move {
                let signed_in_again = core
                    .accounts()
                    .await?
                    .accounts
                    .iter()
                    .any(|account| account.account_id == account_id && account.state.usable());
                // An OAuth or SSO sign-in under way has a client on the store and no lease.
                let signing_in = core
                    .sign_in
                    .pending_login
                    .lock()
                    .await
                    .as_ref()
                    .is_some_and(|pending| pending.account_id == account_id);
                if signed_in_again || signing_in {
                    return Err(RpcCode::Unavailable.into());
                }
                core.remove_account(&supervised, Some(&account_id)).await
            })
        })
        .await?
    }

    /// The active session must be signed out through `logout` so its sync
    /// service is stopped cleanly.
    pub(crate) async fn remove_inactive_account(
        self: &Arc<Self>,
        RemoveAccountParams { account_id }: RemoveAccountParams,
    ) -> Result<(), RpcError> {
        self.wait_for_lent_client(&account_id).await?;
        let retiring = account_id.clone();
        let sign_out = self
            .supervise("retire an account to remove", move |core, supervised| {
                Box::pin(async move { core.retire_inactive(&supervised, &retiring).await })
            })
            .await??;
        if let Some(account) = sign_out {
            self.log_out_saved(&account).await;
        }
        self.remove_retired(account_id).await
    }

    async fn retire_inactive(
        &self,
        supervised: &Supervised<'_>,
        account_id: &str,
    ) -> Result<Option<PersistedAccount>, RpcError> {
        let active = self.active_session_info();
        if active.as_ref().map(|session| session.account_id.as_str()) == Some(account_id) {
            return Err(RpcCode::Denied.into());
        }
        let accounts = self.accounts().await?;
        let Some(account) = accounts
            .accounts
            .into_iter()
            .find(|account| account.account_id == account_id)
        else {
            return Err(RpcCode::NotLoggedIn.into());
        };
        // A twin of the active session's own device must stay signed in.
        let twin = active.is_some_and(|session| {
            session.user_id.as_str() == account.session.credentials.user_id()
                && session.device_id == account.session.credentials.device_id()
        });
        self.wait_for_lent_client(account_id).await?;
        self.mark_account_needs_reauth(supervised, Some(account_id), false)
            .await?;
        Ok((!account.state.device_gone() && !twin).then_some(account))
    }

    /// Stops every writer to the stores and refuses further calls, so another
    /// core can open them.
    pub async fn shutdown(self: &Arc<Self>) {
        self.shut_down.store(true, Ordering::SeqCst);
        let _ = self
            .supervise("shut down", |core, supervised| {
                Box::pin(async move {
                    core.shutdown_supervised(&supervised).await;
                })
            })
            .await;
    }

    async fn shutdown_supervised(self: &Arc<Self>, supervised: &Supervised<'_>) {
        self.lifecycle.invalidate(supervised);
        if let Some(session) = self.take_session(supervised).await {
            crate::sync_support::stop(&session.sync_service).await;
        }
        for account_id in self.clients.account_ids() {
            if self.wait_for_lent_client(&account_id).await.is_err() {
                tracing::warn!("shutting down while a push still holds a client");
            }
            self.invalidate_account_client(&account_id);
        }
    }

    #[cfg(not(target_family = "wasm"))]
    pub(crate) async fn reset_local_cache(self: &Arc<Self>) -> Result<(), RpcError> {
        self.supervise("reset local cache", |core, supervised| {
            Box::pin(async move { core.reset_local_cache_supervised(&supervised).await })
        })
        .await?
    }

    #[cfg(not(target_family = "wasm"))]
    async fn reset_local_cache_supervised(
        self: &Arc<Self>,
        supervised: &Supervised<'_>,
    ) -> Result<(), RpcError> {
        let accounts = self.accounts().await?;
        for account in &accounts.accounts {
            self.wait_for_lent_client(&account.account_id).await?;
        }
        let outcome = {
            self.lifecycle.invalidate(supervised);
            let mut quiesced = true;
            if let Some(session) = self.take_session(supervised).await {
                quiesced = crate::sync_support::stop(&session.sync_service).await
                    && session.state.quiesced().await;
            }
            let mut outcome = Ok(());
            let resettable = if quiesced {
                accounts.accounts.as_slice()
            } else {
                outcome = Err(self.failed("reset_local_cache", "the session's work did not stop"));
                &[]
            };
            for account in resettable {
                let client = self.clients.get(&account.account_id);
                self.invalidate_account_client(&account.account_id);
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
        self.restore_supervised(supervised).await?;
        outcome
    }

    pub(crate) async fn persist(
        &self,
        account_id: &str,
        store_id: &str,
        persisted: &PersistedSession,
        reauth: Option<&PersistedAccount>,
    ) -> Result<ReplacedSignIns, RpcError> {
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
        self.invalidate_account_client(account_id);
        for account_id in &replaced.all {
            self.invalidate_account_client(account_id);
        }
        *accounts = Some(updated);
        Ok(replaced)
    }

    /// The sign-in that replaced these never started, so they are the user's usable ones again.
    async fn keep_replaced(&self, account_ids: &[String]) -> Result<(), RpcError> {
        if account_ids.is_empty() {
            return Ok(());
        }
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
        let mut accounts = self.accounts.lock().await;
        if self.clients.writer(account_id) != Some(generation) {
            tracing::info!("session tokens: save skipped, another client writes this account");
            // The writer's own tokens are saved by the retry, which a refresh here may have made stale.
            self.unsaved_tokens.lock().insert(account_id.to_owned());
            return Ok(());
        }
        let saved = self
            .save_current_credentials(&mut accounts, client, homeserver, account_id)
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

    #[cfg(not(target_family = "wasm"))]
    async fn reload_saved_tokens(
        &self,
        account_id: &str,
        generation: u64,
    ) -> Result<matrix_sdk::SessionTokens, RpcError> {
        let accounts = self.accounts.lock().await;
        if self.clients.writer(account_id) != Some(generation) {
            return Err(RpcCode::NotLoggedIn.into());
        }
        let device_id = accounts
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
        let (loaded, embedded, unmoved) = tokio::task::spawn_blocking(move || {
            let mut embedded = false;
            let mut unmoved = Vec::new();
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
                    Err(error) => {
                        tracing::warn!(
                            account_id = account.account_id,
                            "saved login tokens are unavailable: {error}"
                        );
                        unmoved.push(account.account_id.clone());
                    }
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
            (loaded, embedded, unmoved)
        })
        .await
        .map_err(crate::store::StoreError::backend)?;
        self.unmoved_tokens.lock().extend(unmoved);
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
        self: &Arc<Self>,
        account: &PersistedAccount,
    ) -> Result<bool, RpcError> {
        let tokens = self
            .saved_login_tokens(account)
            .await
            .or_failed(self, "reauth_login_tokens")?;
        let Err(missing) = tokens else {
            return Ok(false);
        };
        let account_id = account.account_id.clone();
        self.supervise("retire an unusable login", move |core, supervised| {
            Box::pin(async move { core.sign_in_again(&supervised, &account_id, missing).await })
        })
        .await??;
        Ok(true)
    }

    #[cfg(not(target_family = "wasm"))]
    async fn saved_login_tokens(
        &self,
        account: &PersistedAccount,
    ) -> Result<
        Result<matrix_sdk::SessionTokens, crate::credentials::MissingTokens>,
        crate::store::StoreError,
    > {
        let device_id = account.session.credentials.device_id();
        if !self.unmoved_tokens.lock().contains(&account.account_id) {
            return self.read_login_tokens(&account.account_id, device_id).await;
        }
        let logins = crate::credentials::LoginTokens::new(std::path::Path::new(&self.store_id));
        let account_id = account.account_id.clone();
        let embedded = account.session.credentials.tokens();
        let tokens = tokio::task::spawn_blocking(move || {
            logins.read_or_migrate(&account_id, &device_id, &embedded)
        })
        .await
        .map_err(crate::store::StoreError::backend)??;
        self.unmoved_tokens.lock().remove(&account.account_id);
        Ok(tokens.map(|(tokens, _)| tokens))
    }

    pub(crate) async fn require_sign_in(
        self: &Arc<Self>,
        account_id: &str,
        device_invalidated: bool,
    ) -> Result<(), RpcError> {
        let account_id = account_id.to_owned();
        self.supervise("retire a saved login", move |core, supervised| {
            Box::pin(async move {
                core.mark_account_needs_reauth(&supervised, Some(&account_id), device_invalidated)
                    .await
            })
        })
        .await?
    }

    pub(crate) async fn release_account_client(
        self: &Arc<Self>,
        account_id: &str,
    ) -> Result<(), RpcError> {
        self.wait_for_lent_client(account_id).await?;
        let account_id = account_id.to_owned();
        self.supervise("release an account client", move |core, _| {
            Box::pin(async move {
                if core.clients.is_lent(&account_id) {
                    return Err(RpcCode::Unavailable.into());
                }
                core.invalidate_account_client(&account_id);
                Ok(())
            })
        })
        .await?
    }

    /// The account keeps its crypto store and settings until it signs in again.
    #[cfg(not(target_family = "wasm"))]
    async fn sign_in_again(
        &self,
        supervised: &Supervised<'_>,
        account_id: &str,
        missing: crate::credentials::MissingTokens,
    ) -> Result<(), RpcError> {
        tracing::warn!(
            reported = true,
            reason = missing.reason(),
            "saved login tokens cannot be used, so the account must sign in again"
        );
        self.mark_account_needs_reauth(supervised, Some(account_id), false)
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
        accounts: &mut Option<AccountRegistry>,
        client: &matrix_sdk::Client,
        homeserver: &str,
        account_id: &str,
    ) -> Result<(), RpcError> {
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

    /// The one client of the account's store in this process. A push and the session share it, so
    /// only building one takes the store's lease.
    pub(crate) async fn saved_account_client(
        self: &Arc<Self>,
        supervised: &Supervised<'_>,
        account: &PersistedAccount,
    ) -> Result<matrix_sdk::Client, RpcError> {
        #[cfg(target_family = "wasm")]
        let _ = supervised;
        if let Some(client) = self.clients.get(&account.account_id) {
            return Ok(client);
        }
        // Bounded: a sign-in holds the lease while it waits for the queue this may run on.
        let Ok(_building) = matrix_sdk::timeout::timeout(
            Box::pin(session::store_lease(&account.store_id)),
            STORE_LEASE_WAIT,
        )
        .await
        else {
            tracing::warn!("the account's store stayed busy, so its client was not opened");
            return Err(RpcCode::Unavailable.into());
        };
        let persisted = account.session.clone();
        #[cfg(not(target_family = "wasm"))]
        let persisted = {
            let mut persisted = persisted;
            let tokens = match self
                .saved_login_tokens(account)
                .await
                .or_failed(self, "restore_login_tokens")?
            {
                Ok(tokens) => tokens,
                // Token files are replaced atomically, and a login whose tokens never left the
                // registry was moved just above, so a missing file never comes back.
                Err(missing) => {
                    self.sign_in_again(supervised, &account.account_id, missing)
                        .await?;
                    return Err(RpcCode::NotLoggedIn.into());
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
        let client = {
            let _upgrading = self.supervisor.unbounded_step();
            session::restore_client(&account.store_id, &persisted, self.persistent_event_cache)
                .await
                .or_failed(self, "restore_build_client")?
        };
        self.install_credential_writer(&client, &account.session.homeserver, &account.account_id);
        session::restore_credentials(&client, &persisted)
            .await
            .or_report(self, "restore_session")?;
        tracing::info!(refresh = %refresh_tag(&client), "session tokens: restored");
        self.clients.insert(&account.account_id, client.clone());
        Ok(client)
    }

    fn install_credential_writer(
        self: &Arc<Self>,
        client: &matrix_sdk::Client,
        homeserver: &str,
        account_id: &str,
    ) {
        let writer = self.next_credential_writer.fetch_add(1, Ordering::SeqCst);
        self.clients.set_writer(account_id, writer);
        self.install_session_callbacks(client, homeserver, account_id, writer);
    }

    #[cfg(not(target_family = "wasm"))]
    #[expect(
        clippy::disallowed_methods,
        reason = "compares against the active account without acting on its session"
    )]
    pub(crate) fn evict_idle_account_client(&self, account_id: &str) {
        let active = self
            .session
            .current(|session| session.account_id.clone())
            .is_some_and(|active| active == account_id);
        if !active && !self.clients.is_lent(account_id) {
            self.clients.remove(account_id);
        }
    }

    pub(crate) async fn wait_for_lent_client(&self, account_id: &str) -> Result<(), RpcError> {
        matrix_sdk::timeout::timeout(
            self.clients.wait_until_returned(account_id),
            LENT_CLIENT_WAIT,
        )
        .await
        .map_err(|_| self.failed("wait_for_lent_client", "a push still holds the client"))
    }

    pub(crate) fn invalidate_account_client(&self, account_id: &str) {
        self.clients.remove(account_id);
    }

    async fn prepare_account_client(
        self: &Arc<Self>,
        client: &matrix_sdk::Client,
        homeserver: &str,
        account_id: &str,
    ) -> Result<(), RpcError> {
        let mut accounts = self.accounts.lock().await;
        let mut updated = accounts.as_ref().ok_or(RpcCode::NotLoggedIn)?.clone();
        let account = updated
            .accounts
            .iter_mut()
            .find(|account| account.account_id == account_id && account.state.usable())
            .ok_or(RpcCode::NotLoggedIn)?;
        if !self.clients.contains(account_id) {
            self.install_credential_writer(client, homeserver, account_id);
            self.clients.insert(account_id, client.clone());
        }
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

    async fn clear_unless_accounts_remain(&self) -> Result<(), RpcError> {
        match self.accounts().await {
            Ok(registry) if !registry.accounts.is_empty() => Ok(()),
            _ => self.clear_persisted_session().await,
        }
    }

    pub(crate) async fn clear_persisted_session(&self) -> Result<(), RpcError> {
        let _registry = self.accounts.lock().await;
        self.sessions
            .clear()
            .await
            .or_failed(self, "clear_session")?;
        self.forget_login_tokens(None).await;
        Ok(())
    }

    pub(crate) async fn mark_account_needs_reauth(
        &self,
        _: &Supervised<'_>,
        account_id: Option<&str>,
        device_invalidated: bool,
    ) -> Result<(), RpcError> {
        let Some(account_id) = account_id else {
            return Ok(());
        };

        let written = {
            // Token refreshes save under this lock from inside the SDK, so it guards only the write.
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
            self.write_registry(registry)
                .await
                .or_failed(self, "retire_session_save")
        };
        // Even a failed save retires the client, so its rejected tokens are never saved again.
        self.invalidate_account_client(account_id);
        written?;
        if device_invalidated {
            self.forget_login_tokens(Some(account_id)).await;
        }
        Ok(())
    }

    async fn remove_account(
        &self,
        supervised: &Supervised<'_>,
        account_id: Option<&str>,
    ) -> Result<(), RpcError> {
        #[cfg(not(target_family = "wasm"))]
        crate::notifications::clear_push_media(std::path::Path::new(&self.store_id)).await;
        let Some(account_id) = account_id else {
            return self.clear_unless_accounts_remain().await;
        };
        // Nothing opens the account again while its files go.
        self.mark_account_needs_reauth(supervised, Some(account_id), false)
            .await?;
        self.retire_account(supervised, account_id).await
    }

    async fn mark_stale_sign_ins(&self) -> Result<Vec<String>, RpcError> {
        self.accounts().await?;
        let stale = {
            let mut accounts = self.accounts.lock().await;
            let Some(registry) = accounts.as_ref() else {
                return Err(
                    self.failed("mark_stale_sign_ins", "account registry is not initialized")
                );
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
            stale
        };
        for account_id in &stale {
            self.invalidate_account_client(account_id);
        }
        Ok(stale)
    }

    /// The account leaves the registry only once nothing of it is left behind. `successor` takes
    /// the room keys only this account's store holds.
    async fn retire_account(
        &self,
        supervised: &Supervised<'_>,
        account_id: &str,
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
        self.wait_for_lent_client(account_id).await?;
        self.invalidate_account_client(account_id);
        // A sign-in that reuses the store holds its lease from the client it builds until its
        // session starts, and that client must not lose its files.
        let Ok(_lease) = matrix_sdk::timeout::timeout(
            Box::pin(session::store_lease(&account.store_id)),
            STORE_LEASE_WAIT,
        )
        .await
        else {
            tracing::warn!("the account's store stayed busy, so it was not removed");
            return Err(RpcCode::Unavailable.into());
        };
        // Before the files go: a store left half gone must not have its device signed in again.
        self.mark_account_needs_reauth(supervised, Some(account_id), true)
            .await?;
        self.discard_account_store(&account.store_id).await?;
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

    pub(crate) async fn retire_replaced_account(
        self: &Arc<Self>,
        account_id: &str,
        successor: &matrix_sdk_base::BaseClient,
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
        let Some(meta) = successor
            .session_meta()
            .filter(|meta| meta.user_id.as_str() == account.session.credentials.user_id())
        else {
            return Ok(());
        };
        // A twin of the successor's own device must stay signed in.
        if !account.state.device_gone()
            && meta.device_id.as_str() != account.session.credentials.device_id()
        {
            self.log_out_saved(&account).await;
        }
        self.wait_for_lent_client(account_id).await?;
        {
            let Ok(_lease) = matrix_sdk::timeout::timeout(
                Box::pin(session::store_lease(&account.store_id)),
                STORE_LEASE_WAIT,
            )
            .await
            else {
                return Err(RpcCode::Unavailable.into());
            };
            match crate::store_disposal::carry_room_keys(&account.store_id, successor).await {
                Ok(imported) => tracing::info!(imported, "carried room keys to the new device"),
                Err(crate::store::StoreError::KeyMissing) => {}
                Err(error) => return Err(self.failed_with("retire_account_room_keys", &error)),
            }
        }
        let account_id = account_id.to_owned();
        self.supervise("retire a replaced account", move |core, supervised| {
            Box::pin(async move { core.retire_account(&supervised, &account_id).await })
        })
        .await?
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

    #[expect(clippy::disallowed_methods, reason = "ends the current session")]
    pub(crate) async fn take_session(self: &Arc<Self>, _: &Supervised<'_>) -> Option<Session> {
        let ended = self.session.current(Session::clone);
        if let Some(ended) = &ended {
            ended.state.ended.cancel();
            self.session_step("ending calls");
            // Before a logout revokes the token the hang-up is sent with.
            let calls = SignedIn::new(Arc::clone(self), ended.clone());
            if matrix_sdk::timeout::timeout(Box::pin(calls.end_calls()), HANG_UP_TIMEOUT)
                .await
                .is_err()
            {
                tracing::warn!("hanging up the session's calls timed out");
            }
            self.session_step("locking room subscriptions");
            let state = &ended.state;
            let _registering = state.room_subscriptions.lock().await;
            self.session_step("clearing the session state");
            state.session_handlers.lock().clear();
            let mut tasks = std::mem::take(&mut *state.session_tasks.lock());
            tasks.extend(state.foreground_work.lock().take());
            tasks.extend(state.reopen_retry.lock().take());
            state.to_device_inbox.lock().take();
            let subscriptions = std::mem::take(&mut *state.subscriptions.lock());
            for (_, subscription) in subscriptions {
                tasks.extend(subscription.tasks);
            }
            self.session_step("stopping the session's tasks");
            let stopped = matrix_sdk::timeout::timeout(
                Box::pin(crate::tasks::stop_all(tasks)),
                TASKS_STOP_WAIT,
            )
            .await
            .is_ok();
            if !stopped {
                tracing::warn!("the session's tasks did not stop in time");
            }
            state.tasks_stopped.store(stopped, Ordering::SeqCst);
            // After the handlers that record into it stopped.
            self.session_step("saving the inbox");
            self.flush_inbox_if_open(ended).await;
            self.session.write().take();
            state.timelines.lock().clear();
            state.thread_timelines.lock().clear();
            self.session_step("closing the search index");
            *state.search_index.lock().await = search::MessageIndex::new();
        }
        self.nicknames
            .send_replace(crate::nicknames::Nicknames::default());
        ended
    }

    pub(crate) async fn finish_sign_in(
        self: &Arc<Self>,
        client: matrix_sdk::Client,
        account_id: String,
        store_id: &str,
        persisted: PersistedSession,
        reauth: Option<&PersistedAccount>,
    ) -> Result<(), RpcError> {
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
    ) -> Result<(), RpcError> {
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
        let store_id = store_id.to_owned();
        let reauth = reauth.cloned();
        self.supervise("finish sign-in", move |core, supervised| {
            Box::pin(async move {
                core.start_signed_in_session(
                    &supervised,
                    client,
                    account_id,
                    &store_id,
                    persisted,
                    reauth.as_ref(),
                    lease,
                )
                .await
            })
        })
        .await?
    }

    #[expect(
        clippy::too_many_arguments,
        reason = "the sign-in's parts, moved into its supervised job"
    )]
    async fn start_signed_in_session(
        self: &Arc<Self>,
        supervised: &Supervised<'_>,
        client: matrix_sdk::Client,
        account_id: String,
        store_id: &str,
        persisted: PersistedSession,
        reauth: Option<&PersistedAccount>,
        _lease: session::StoreLease,
    ) -> Result<(), RpcError> {
        self.open_stores_for_session_start(supervised).await?;
        let generation = self.lifecycle.claim(supervised);
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
                supervised,
            )
            .await;
        let signed_in = match started {
            Ok(signed_in) => signed_in,
            Err(error) => {
                self.abandon_sign_in(&client, reauth).await;
                if reauth.is_none_or(|account| account.state.device_gone()) {
                    if let Err(error) = self
                        .mark_account_needs_reauth(supervised, Some(&account_id), true)
                        .await
                    {
                        tracing::warn!(?error, "could not retire an account that failed to start");
                    }
                    if let Err(error) = self.keep_replaced(&replaced.usable).await {
                        tracing::warn!(?error, "could not keep the sign-ins a failed one replaced");
                    }
                }
                return Err(error);
            }
        };
        signed_in.retire_replaced(replaced.all, store_id);
        Ok(())
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

    #[expect(clippy::disallowed_methods, reason = "publishes the session it starts")]
    pub(crate) async fn start_session(
        self: &Arc<Self>,
        client: matrix_sdk::Client,
        homeserver: String,
        account_id: String,
        claimed: &SessionGeneration,
        supervised: &Supervised<'_>,
    ) -> Result<SignedIn, RpcError> {
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

        self.session_step("preparing the account client");
        self.prepare_account_client(&client, &homeserver, &account_id)
            .await?;

        // Do not disrupt the active session unless its replacement started
        // successfully. `take_session` also aborts its owned watcher tasks.
        if let Some(previous) = self.take_session(supervised).await {
            self.session_step("stopping the previous sync");
            crate::sync_support::stop(&previous.sync_service).await;
        }

        self.session_step("starting the session");
        claimed.commit(&self.lifecycle);
        self.activity.session_started(supervised, generation);
        self.emit_if_current(
            generation,
            CoreEvent::AccountLockChanged {
                account_id: account_id.clone(),
                locked: false,
            },
        );
        // Published before any watcher starts, so every task and cache of this session is its own.
        let state = Arc::<crate::SessionState>::default();
        state.generation.store(generation, Ordering::SeqCst);
        let session = Session {
            account_id: account_id.clone(),
            client: client.clone(),
            sync_service: sync_service.clone(),
            homeserver: homeserver.clone(),
            oauth,
            state,
        };
        *self.session.write() = Some(session.clone());
        let signed_in = SignedIn::new(Arc::clone(self), session);
        let tuning = *self.settings.search_tuning.lock();
        signed_in.state().search_crawl.lock().tuning = tuning;

        signed_in.watch_ephemeral(generation);
        signed_in.watch_account_data(generation);
        signed_in.watch_incoming_calls(generation);
        signed_in.watch_incoming_verifications();

        signed_in.watch_session_changes(session_changes, generation);
        signed_in.watch_encryption(generation);
        signed_in.watch_room_keys();
        signed_in.watch_account_data_key_sharing(generation);
        signed_in.watch_search_peers(generation);
        signed_in.watch_rtc(generation);
        signed_in.resume_dehydrated_device();
        signed_in.watch_devices(generation);
        signed_in.watch_oauth_metadata(generation);
        signed_in.watch_notifications(generation).await;
        signed_in.watch_notification_settings(generation);
        signed_in.watch_space_sidebar(generation);
        signed_in.watch_calendars(generation);
        signed_in.watch_widget_feed(generation);
        signed_in.watch_room_widgets(generation);
        signed_in.watch_room_state();
        signed_in.watch_cosmetics(generation);
        signed_in.watch_profile_changes(generation);
        signed_in.watch_nicknames();
        signed_in.watch_redactions();
        let repair_client = client.clone();
        signed_in.track_session_task(
            spawn(async move {
                if let Err(error) = crate::rooms::migrate_saved_tombstones(&repair_client).await {
                    tracing::warn!("could not migrate saved tombstones: {error}");
                }
            })
            .abort_on_drop(),
        );
        signed_in.watch_bot_commands(generation);
        signed_in.watch_room_rules(generation);
        signed_in.watch_image_packs(generation);
        signed_in.watch_joined_invites();
        signed_in.watch_send_queue();
        signed_in.watch_presence(generation);
        signed_in.watch_inbox_persist();
        signed_in.prefetch_call_well_known();
        let store_id = signed_in
            .core()
            .registered_store_id(&account_id)
            .await
            .unwrap_or_else(|| signed_in.core().store_id.clone());
        signed_in.watch_search_index(&store_id);
        signed_in.watch_ignored_users();
        signed_in.watch_ignored_history(&sync_service);
        signed_in.watch_sync_stall(&sync_service, crate::sync_support::SYNC_STALL);
        signed_in.watch_backup_preference();
        // Before the start: the subscriber yields only changes, so it would miss the first `Running`.
        signed_in.watch_sync_state(&sync_service, generation);
        signed_in.run_started_session(supervised).await;
        Ok(signed_in)
    }

    #[expect(
        clippy::disallowed_methods,
        reason = "identifies the current session without acting on it"
    )]
    pub(crate) fn session_marker(&self) -> Option<u64> {
        self.session
            .current(|session| session.state.generation.load(Ordering::SeqCst))
    }

    #[expect(
        clippy::disallowed_methods,
        reason = "tells whether a failed job left an ended session behind"
    )]
    pub(crate) async fn recover_after_job(
        self: &Arc<Self>,
        supervised: &Supervised<'_>,
        cancelled: bool,
        before: Option<u64>,
    ) {
        if cancelled {
            self.accounts.lock().await.take();
        }
        let ended = self
            .session
            .current(|session| session.state.ended.is_cancelled())
            .unwrap_or(false);
        let changed = cancelled && before != self.session_marker();
        if !ended && !changed {
            return;
        }
        tracing::error!(
            reported = true,
            "ending the session a failed lifecycle job left unfinished"
        );
        self.lifecycle.invalidate(supervised);
        if let Some(session) = self.take_session(supervised).await {
            crate::sync_support::stop(&session.sync_service).await;
        }
        self.emit(CoreEvent::SessionEnded {
            reason: "lifecycle_failed".to_owned(),
        });
    }

    #[expect(
        clippy::disallowed_methods,
        reason = "drops a session whose teardown could not finish"
    )]
    pub(crate) fn drop_session_after_failed_recovery(&self) {
        tracing::error!(
            reported = true,
            "a session's teardown could not finish, so it was dropped as it was"
        );
        self.session.write().take();
        self.emit(CoreEvent::SessionEnded {
            reason: "lifecycle_failed".to_owned(),
        });
    }

    pub(crate) fn session_step(&self, step: &'static str) {
        *self.session_step.lock() = step;
    }

    pub(crate) fn current_session_step(&self) -> &'static str {
        *self.session_step.lock()
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

        self.supervise_later("end rejected session", move |core, supervised| {
            Box::pin(async move {
                if !core.is_current(generation) {
                    return;
                }
                core.lifecycle.invalidate(&supervised);
                let session = core.take_session(&supervised).await;
                let account_id = session.as_ref().map(|session| session.account_id.clone());
                if let Some(session) = session {
                    crate::sync_support::stop(&session.sync_service).await;
                }

                let outcome = match account_id.as_deref() {
                    Some(account_id) => {
                        core.mark_account_needs_reauth(&supervised, Some(account_id), !soft_logout)
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
            })
        });
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
const STORE_LEASE_WAIT: std::time::Duration = std::time::Duration::from_secs(15);
const HANG_UP_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);
const LENT_CLIENT_WAIT: std::time::Duration = std::time::Duration::from_secs(30);
const TASKS_STOP_WAIT: std::time::Duration = std::time::Duration::from_secs(5);

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

impl SignedIn {
    async fn run_started_session(&self, supervised: &Supervised<'_>) {
        self.core().session_step("starting sync");
        self.session().sync_service.start().await;

        let client = self.client();
        client.send_queue().enable_upload_progress(true);
        self.core().session_step("resending queued messages");
        client
            .send_queue()
            .respawn_tasks_for_rooms_with_unsent_requests()
            .await;

        self.refresh_own_identity();

        self.core().session_step("applying the app activity");
        self.core()
            .apply_activity_after_session_start(supervised)
            .await;
    }

    pub(crate) async fn delete_device(
        &self,
        DeleteDeviceParams {
            device_id,
            password,
        }: DeleteDeviceParams,
    ) -> Result<Option<String>, RpcError> {
        let client = self.client();
        let devices = [device_id];

        if let Some(metadata) = self
            .core()
            .oauth_metadata(client, "account_management_metadata")
            .await?
        {
            return oauth_device_delete_url(&metadata, &devices[0]).map(Some);
        }

        let Err(error) = client.delete_devices(&devices, None).await else {
            return Ok(None);
        };
        let Some(uiaa) = error.as_uiaa_response() else {
            return Err(self.core().failed_with("delete_device", &error));
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
                None => self.core().failed_with("delete_device_auth", &error),
            })?;
        Ok(None)
    }

    pub(crate) async fn deactivate_account(
        &self,
        password: Option<String>,
    ) -> Result<Option<String>, RpcError> {
        let client = self.client();

        if client.oauth().full_session().is_some()
            && let Some(metadata) = self
                .core()
                .oauth_metadata(client, "deactivate_account_metadata")
                .await?
        {
            return oauth_account_deactivate_url(&metadata).map(Some);
        }

        let account = client.account();
        let Err(error) = account.deactivate(None, None, false).await else {
            return Ok(None);
        };
        let Some(uiaa) = error.as_uiaa_response() else {
            return Err(self.core().failed_with("deactivate_account", &error));
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
                None => self.core().failed_with("deactivate_account_auth", &error),
            })?;
        Ok(None)
    }

    fn refresh_own_identity(&self) {
        let client = self.client();
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

    pub(crate) fn watch_session_changes(
        &self,
        mut changes: tokio::sync::broadcast::Receiver<matrix_sdk::SessionChange>,
        generation: u64,
    ) {
        let session = self.clone();
        self.track_session_task(
            spawn(async move {
                loop {
                    match changes.recv().await {
                        Ok(change) => {
                            if session.core().handle_session_change(&change, generation) {
                                return;
                            }
                            session.retry_unsaved_tokens().await;
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {}
                        Err(tokio::sync::broadcast::error::RecvError::Closed) => return,
                    }
                }
            })
            .abort_on_drop(),
        );
    }

    /// Runs once the replacing session holds `store_id`, so no replaced store is still open.
    fn retire_replaced(&self, replaced: Vec<String>, store_id: &str) {
        if replaced.is_empty() {
            return;
        }
        let Some(base) = session::base_client(store_id) else {
            tracing::error!("could not retire the replaced accounts: the new client is gone");
            return;
        };
        let session = self.clone();
        self.track_session_task(
            spawn(async move {
                for account_id in replaced {
                    if let Err(error) = session
                        .core()
                        .retire_replaced_account(&account_id, &base)
                        .await
                    {
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

    /// The SDK only logs a failed save, and the refresh token it replaced is spent, so the next
    /// start would sign the account out.
    pub(crate) async fn retry_unsaved_tokens(&self) {
        if self.core().unsaved_tokens.lock().is_empty() {
            return;
        }
        let session = self.session();
        if !self
            .core()
            .unsaved_tokens
            .lock()
            .contains(&session.account_id)
        {
            return;
        }
        let Some(generation) = self.core().clients.writer(&session.account_id) else {
            return;
        };
        if let Err(error) = self
            .core()
            .persist_refreshed(
                &session.client,
                &session.homeserver,
                &session.account_id,
                generation,
            )
            .await
        {
            tracing::warn!("could not save the refreshed session tokens again: {error:?}");
        }
    }
}

#[cfg(test)]
impl Core {
    pub(crate) async fn end_session(self: &Arc<Self>) -> Option<Session> {
        self.supervise("test end session", |core, supervised| {
            Box::pin(async move { core.take_session(&supervised).await })
        })
        .await
        .unwrap()
    }

    pub(crate) async fn needs_reauth(
        self: &Arc<Self>,
        account_id: Option<&str>,
        device_invalidated: bool,
    ) -> Result<(), RpcError> {
        let account_id = account_id.map(ToOwned::to_owned);
        self.supervise("test retire login", move |core, supervised| {
            Box::pin(async move {
                core.mark_account_needs_reauth(
                    &supervised,
                    account_id.as_deref(),
                    device_invalidated,
                )
                .await
            })
        })
        .await
        .unwrap()
    }

    pub(crate) async fn remove_saved(
        self: &Arc<Self>,
        account_id: Option<&str>,
    ) -> Result<(), RpcError> {
        let account_id = account_id.map(ToOwned::to_owned);
        self.supervise("test remove account", move |core, supervised| {
            Box::pin(async move {
                core.remove_account(&supervised, account_id.as_deref())
                    .await
            })
        })
        .await
        .unwrap()
    }

    pub(crate) async fn open_saved_account(
        self: &Arc<Self>,
        account: &PersistedAccount,
    ) -> Result<matrix_sdk::Client, RpcError> {
        let account = account.clone();
        self.supervise("test open account", move |core, supervised| {
            Box::pin(async move { core.saved_account_client(&supervised, &account).await })
        })
        .await
        .unwrap()
    }
}

#[cfg(test)]
#[cfg(not(target_family = "wasm"))]
#[path = "accounts_tests.rs"]
mod regression_tests;

#[cfg(test)]
#[path = "lifecycle_tests.rs"]
mod lifecycle_tests;
