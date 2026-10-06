use std::sync::{Arc, atomic::Ordering};

use matrix_sdk::executor::{JoinHandleExt, spawn};
use matrix_sdk::ruma::OwnedDeviceId;
use matrix_sdk::ruma::api::client::uiaa::{AuthData, AuthType, Password, UserIdentifier};
use matrix_sdk_ui::sync_service::State as SyncState;

use crate::ResultExt;
use crate::protocol::{CommandErr, CommandOk, CoreEvent, SessionInfo};

#[cfg(not(target_family = "wasm"))]
use crate::session::AccountRegistry;
use crate::session::{PersistedAccount, PersistedSession, Session};

use crate::Core;
use crate::cosmetics;
use crate::image_packs;
use crate::search;
use crate::session;
use crate::watchers::sync_status;

pub(crate) struct SessionGeneration<'core> {
    value: u64,
    _guard: tokio::sync::MutexGuard<'core, ()>,
}

impl SessionGeneration<'_> {
    pub(crate) const fn value(&self) -> u64 {
        self.value
    }
}

impl Core {
    pub(crate) async fn delete_device(
        &self,
        device_id: OwnedDeviceId,
        password: Option<String>,
    ) -> Result<Option<String>, CommandErr> {
        let client = self.client().await?;
        let devices = [device_id];

        if client.oauth().full_session().is_some() {
            let metadata = client
                .oauth()
                .server_metadata()
                .await
                .or_failed(self, "delete_device_metadata")?;
            return oauth_device_delete_url(&metadata, &devices[0]).map(Some);
        }

        let Err(error) = client.delete_devices(&devices, None).await else {
            return Ok(None);
        };
        let Some(uiaa) = error.as_uiaa_response() else {
            return Err(self.failed("delete_device", error));
        };
        let password_only = uiaa
            .flows
            .iter()
            .any(|flow| flow.stages == [AuthType::Password]);
        let password = match password {
            Some(password) if password_only => password,
            _ => {
                return Err(CommandErr::InteractiveAuthRequired {
                    stages: uiaa
                        .flows
                        .iter()
                        .flat_map(|flow| &flow.stages)
                        .map(|stage| stage.as_str().to_owned())
                        .collect(),
                });
            }
        };

        let user_id = client.user_id().ok_or(CommandErr::NotLoggedIn)?.to_owned();
        let mut auth = Password::new(UserIdentifier::Matrix(user_id.into()), password);
        auth.session.clone_from(&uiaa.session);
        client
            .delete_devices(&devices, Some(AuthData::Password(auth)))
            .await
            .map_err(|error| match error.as_uiaa_response() {
                Some(_) => CommandErr::Denied,
                None => self.failed("delete_device_auth", error),
            })?;
        Ok(None)
    }

    pub(crate) async fn claim_session_generation(&self) -> SessionGeneration<'_> {
        let guard = self.session_activation_lock.lock().await;
        SessionGeneration {
            value: self
                .session_attempt_generation
                .fetch_add(1, Ordering::SeqCst)
                + 1,
            _guard: guard,
        }
    }

    pub(crate) async fn restore(self: &Arc<Self>) -> Result<CommandOk, CommandErr> {
        let _restore = self.restore_lock.lock().await;
        if let Some(session) = self.active_session_info().await {
            return Ok(CommandOk::Restore {
                session: Some(session),
            });
        }

        let accounts = self.accounts().await?;
        let Some(account_id) = accounts.active_account_id else {
            return Ok(CommandOk::Restore { session: None });
        };
        let Some(account) = accounts
            .accounts
            .into_iter()
            .find(|account| account.account_id == account_id)
        else {
            return Err(self.failed("restore", "active account is missing"));
        };
        if account.needs_reauth {
            return Ok(CommandOk::Restore { session: None });
        }
        let client = self.saved_account_client(&account).await?;
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
            generation.value(),
        )
        .await?;

        Ok(CommandOk::Restore {
            session: Some(info),
        })
    }

    async fn active_session_info(&self) -> Option<SessionInfo> {
        let session = self.session.read().await;
        let session = session.as_ref()?;
        Some(SessionInfo {
            account_id: session.account_id.clone(),
            user_id: session.client.user_id()?.to_owned(),
            device_id: session.client.device_id()?.to_string(),
            homeserver: session.homeserver.clone(),
            needs_reauth: false,
        })
    }

    pub(crate) async fn list_accounts(&self) -> Result<CommandOk, CommandErr> {
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
            .collect::<Result<Vec<_>, _>>()?;
        Ok(CommandOk::ListAccounts { accounts })
    }

    pub(crate) async fn switch_account(
        self: &Arc<Self>,
        account_id: String,
    ) -> Result<CommandOk, CommandErr> {
        let _restore = self.restore_lock.lock().await;
        if let Some(session) = self.active_session_info().await
            && session.account_id == account_id
        {
            return Ok(CommandOk::SwitchAccount { session });
        }
        let accounts = self.accounts().await?;
        let account = accounts
            .accounts
            .into_iter()
            .find(|account| account.account_id == account_id)
            .ok_or(CommandErr::NotLoggedIn)?;
        if account.needs_reauth {
            return Err(CommandErr::NotLoggedIn);
        }
        let client = self.saved_account_client(&account).await?;
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
            generation.value(),
        )
        .await?;
        Ok(CommandOk::SwitchAccount { session: info })
    }

    pub(crate) async fn logout(self: &Arc<Self>) -> Result<CommandOk, CommandErr> {
        let _activation = self.session_activation_lock.lock().await;
        let _swap = self.session_swap_lock.lock().await;
        let invalidated = self
            .session_attempt_generation
            .fetch_add(1, Ordering::SeqCst)
            + 1;
        self.session_generation.store(invalidated, Ordering::SeqCst);
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

        self.remove_account(account_id.as_deref()).await?;

        Ok(CommandOk::Logout)
    }

    /// The active session must be signed out through `logout` so its sync
    /// service is stopped cleanly.
    pub(crate) async fn remove_inactive_account(
        &self,
        account_id: String,
    ) -> Result<CommandOk, CommandErr> {
        if self
            .active_session_info()
            .await
            .as_ref()
            .map(|session| &session.account_id)
            == Some(&account_id)
        {
            return Err(CommandErr::Denied);
        }

        let accounts = self.accounts().await?;
        if !accounts
            .accounts
            .iter()
            .any(|account| account.account_id == account_id)
        {
            return Err(CommandErr::NotLoggedIn);
        }

        self.remove_account(Some(&account_id)).await?;
        Ok(CommandOk::RemoveAccount)
    }

    #[cfg(not(target_family = "wasm"))]
    pub(crate) async fn reset_local_cache(self: &Arc<Self>) -> Result<CommandOk, CommandErr> {
        let outcome = {
            let _restore = self.restore_lock.lock().await;
            let _activation = self.session_activation_lock.lock().await;
            let _swap = self.session_swap_lock.lock().await;
            let invalidated = self
                .session_attempt_generation
                .fetch_add(1, Ordering::SeqCst)
                + 1;
            self.session_generation.store(invalidated, Ordering::SeqCst);
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
                    outcome = Err(self.failed("reset_local_cache", error));
                    continue;
                }
                if let Err(error) = reset_account_cache(account).await {
                    outcome = Err(self.failed("reset_local_cache", error));
                }
            }
            outcome
        };
        self.restore().await?;
        outcome.map(|()| CommandOk::ResetLocalCache)
    }

    pub(crate) async fn persist(
        &self,
        account_id: &str,
        store_id: &str,
        persisted: &PersistedSession,
        reauth: Option<&PersistedAccount>,
    ) -> Result<(), CommandErr> {
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
            return Err(CommandErr::NotLoggedIn);
        }
        let mut updated = registry.clone();
        if let Some(expected) = reauth {
            updated
                .accounts
                .retain(|account| account.account_id != expected.account_id);
        }
        updated.upsert(PersistedAccount {
            account_id: account_id.to_owned(),
            store_id: store_id.to_owned(),
            session: persisted.clone(),
            needs_reauth: false,
            device_invalidated: false,
        });
        let bytes = serde_json::to_vec(&updated).or_failed(self, "persist_serialize")?;
        self.sessions
            .save(bytes)
            .await
            .or_failed(self, "persist_save")?;
        self.invalidate_account_client(account_id).await;
        *accounts = Some(updated);
        Ok(())
    }

    async fn persist_refreshed(
        &self,
        client: &matrix_sdk::Client,
        homeserver: &str,
        account_id: &str,
        generation: u64,
    ) -> Result<(), CommandErr> {
        let _guard = self.session_store_lock.lock().await;
        if self.credential_writers.lock().await.get(account_id) != Some(&generation) {
            return Ok(());
        }
        self.save_current_credentials(client, homeserver, account_id)
            .await
    }

    #[cfg(not(target_family = "wasm"))]
    async fn reload_saved_tokens(
        &self,
        account_id: &str,
        generation: u64,
    ) -> Result<matrix_sdk::SessionTokens, CommandErr> {
        let _guard = self.session_store_lock.lock().await;
        if self.credential_writers.lock().await.get(account_id) != Some(&generation) {
            return Err(CommandErr::NotLoggedIn);
        }
        let bytes = self
            .sessions
            .load()
            .await
            .or_failed(self, "reload_session_read")?
            .ok_or(CommandErr::NotLoggedIn)?;
        let (registry, _) = AccountRegistry::from_bytes(&bytes, &self.store_id)
            .or_failed(self, "reload_session_parse")?;
        let account = registry
            .accounts
            .into_iter()
            .find(|account| account.account_id == account_id && !account.needs_reauth)
            .ok_or(CommandErr::NotLoggedIn)?;
        Ok(account.session.credentials.tokens())
    }

    async fn save_current_credentials(
        &self,
        client: &matrix_sdk::Client,
        homeserver: &str,
        account_id: &str,
    ) -> Result<(), CommandErr> {
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
        let bytes = serde_json::to_vec(&updated).or_failed(self, "refresh_serialize")?;
        self.sessions
            .save(bytes)
            .await
            .or_failed(self, "refresh_save")?;
        *accounts = Some(updated);
        Ok(())
    }

    async fn saved_account_client(
        &self,
        account: &PersistedAccount,
    ) -> Result<matrix_sdk::Client, CommandErr> {
        let cached = self
            .account_clients
            .lock()
            .await
            .get(&account.account_id)
            .cloned();
        if let Some(client) = cached {
            return Ok(client);
        }
        session::validate_saved_crypto_store(&account.store_id, &account.session)
            .await
            .or_failed(self, "restore_crypto_store")?;
        let client = session::restore_client(
            &account.store_id,
            &account.session,
            self.persistent_event_cache,
        )
        .await
        .or_failed(self, "restore_build_client")?;
        session::restore_credentials(&client, &account.session)
            .await
            .or_failed(self, "restore_session")?;
        Ok(client)
    }

    async fn invalidate_account_client(&self, account_id: &str) {
        self.credential_writers.lock().await.remove(account_id);
        self.account_clients.lock().await.remove(account_id);
        let route = self.notification_routes.lock().await.remove(account_id);
        if let Some(route) = route {
            route
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .take();
        }
    }

    async fn prepare_account_client(
        self: &Arc<Self>,
        client: &matrix_sdk::Client,
        homeserver: &str,
        account_id: &str,
        generation: u64,
    ) -> Result<(), CommandErr> {
        let _guard = self.session_store_lock.lock().await;
        let mut accounts = self.accounts.lock().await;
        let mut updated = accounts.as_ref().ok_or(CommandErr::NotLoggedIn)?.clone();
        let account = updated
            .accounts
            .iter_mut()
            .find(|account| account.account_id == account_id && !account.needs_reauth)
            .ok_or(CommandErr::NotLoggedIn)?;
        let mut clients = self.account_clients.lock().await;
        if !clients.contains_key(account_id) {
            self.credential_writers
                .lock()
                .await
                .insert(account_id.to_owned(), generation);
            self.install_session_callbacks(client, homeserver, account_id, generation);
            clients.insert(account_id.to_owned(), client.clone());
        }
        drop(clients);
        account.session = session::current_session(client, homeserver.to_owned())
            .ok_or(CommandErr::NotLoggedIn)?
            .keeping_endpoint_of(&account.session);
        updated.active_account_id = Some(account_id.to_owned());
        let bytes = serde_json::to_vec(&updated).or_failed(self, "activate_account_serialize")?;
        self.sessions
            .save(bytes)
            .await
            .or_failed(self, "activate_account_save")?;
        *accounts = Some(updated);
        Ok(())
    }

    pub(crate) async fn clear_persisted_session(&self) -> Result<(), CommandErr> {
        let _guard = self.session_store_lock.lock().await;
        self.sessions.clear().await.or_failed(self, "clear_session")
    }

    pub(crate) async fn mark_account_needs_reauth(
        &self,
        account_id: Option<&str>,
        device_invalidated: bool,
    ) -> Result<(), CommandErr> {
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
        let bytes = serde_json::to_vec(registry).or_failed(self, "retire_session_serialize")?;
        self.invalidate_account_client(account_id).await;
        self.sessions
            .save(bytes)
            .await
            .or_failed(self, "retire_session_save")
    }

    async fn remove_account(&self, account_id: Option<&str>) -> Result<(), CommandErr> {
        let Some(account_id) = account_id else {
            return self.clear_persisted_session().await;
        };

        let _guard = self.session_store_lock.lock().await;
        let mut accounts = self.accounts.lock().await;
        let Some(registry) = accounts.as_mut() else {
            return Err(self.failed("remove_account", "account registry is not initialized"));
        };
        self.invalidate_account_client(account_id).await;
        let store_id = registry
            .accounts
            .iter()
            .find(|account| account.account_id == account_id)
            .map(|account| account.store_id.clone());
        registry
            .accounts
            .retain(|account| account.account_id != account_id);
        if registry.active_account_id.as_deref() == Some(account_id) {
            registry.active_account_id = None;
        }
        let bytes = serde_json::to_vec(registry).or_failed(self, "logout_serialize_accounts")?;
        self.sessions
            .save(bytes)
            .await
            .or_failed(self, "logout_save_accounts")?;
        if let Some(store_id) = store_id {
            self.discard_account_store(&store_id).await?;
        }
        Ok(())
    }

    pub(crate) async fn retire_replaced_store(
        &self,
        reauth: Option<&PersistedAccount>,
        store_id: &str,
    ) {
        let Some(replaced) = reauth.filter(|account| account.device_invalidated) else {
            return;
        };
        let Some(base) = session::base_client(store_id) else {
            tracing::error!("could not carry room keys: the new client is gone");
            return;
        };
        match crate::store_disposal::carry_room_keys(&replaced.store_id, &base).await {
            Ok(imported) => tracing::info!(imported, "carried room keys to the new device"),
            Err(error) => {
                tracing::error!("could not carry room keys to the new device: {error}");
                return;
            }
        }
        if let Err(error) = self.discard_account_store(&replaced.store_id).await {
            tracing::error!(?error, "could not discard the replaced account store");
        }
    }

    pub(crate) async fn discard_account_store(&self, store_id: &str) -> Result<(), CommandErr> {
        crate::store_disposal::discard(&self.store_id, store_id)
            .await
            .or_failed(self, "discard_account_store")
    }

    pub(crate) async fn take_session(&self) -> Option<Session> {
        self.end_all_calls().await;
        let client = self
            .session
            .read()
            .await
            .as_ref()
            .map(|session| session.client.clone());
        if let Some(client) = client {
            self.flush_search_index(&client).await;
        }
        let mut session = self.session.write().await;
        self.session_handlers
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clear();
        self.session_tasks
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clear();
        self.subscriptions.lock().await.clear();
        self.room_subscriptions.lock().await.clear();
        self.timelines.lock().await.clear();
        self.thread_timelines.lock().await.clear();
        self.account_data_types.lock().await.clear();
        *self.pack_cache.lock().await = image_packs::PackCache::default();
        self.calendars.lock().await.clear();
        *self.push_rules.lock().await = None;
        self.set_read_room(None);
        self.probed_pinned_rooms
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clear();
        *self
            .cosmetics
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) =
            cosmetics::CosmeticsCache::default();
        *self.search_index.lock().await = search::MessageIndex::new();
        self.search_crawl.lock().await.reset();
        self.server_search.lock().await.reset();
        session.take()
    }

    #[expect(
        clippy::too_many_lines,
        reason = "one sequential flow kept in a single function"
    )]
    pub(crate) async fn start_session(
        self: &Arc<Self>,
        client: matrix_sdk::Client,
        homeserver: String,
        account_id: String,
        generation: u64,
    ) -> Result<(), CommandErr> {
        let oauth = client.oauth().full_session().is_some();
        client
            .event_cache()
            .subscribe()
            .or_failed(self, "subscribe_event_cache")?;
        if let Err(error) = session::repair_room_key_sharing(&client).await {
            tracing::warn!(%error, "repairing room key sharing failed");
        }

        let session_changes = client.subscribe_to_session_changes();
        let sync_service = session::build_sync(client.clone())
            .await
            .or_failed(self, "start_sync")?;

        let _swap = self.session_swap_lock.lock().await;
        if self.session_attempt_generation.load(Ordering::SeqCst) != generation {
            sync_service.stop().await;
            return Err(CommandErr::Unavailable);
        }

        self.prepare_account_client(&client, &homeserver, &account_id, generation)
            .await?;

        // successfully. `take_session` also aborts its owned watcher tasks.
        if let Some(previous) = self.take_session().await {
            previous.sync_service.stop().await;
        }

        self.watch_ephemeral(&client, generation);
        self.watch_account_data(&client, generation);
        self.watch_incoming_calls(&client, generation);
        self.watch_incoming_verifications(&client);

        self.session_generation.store(generation, Ordering::SeqCst);
        self.account_locked.store(false, Ordering::SeqCst);
        self.emit_if_current(
            generation,
            CoreEvent::AccountLockChanged {
                account_id: account_id.clone(),
                locked: false,
            },
        );
        let verification_client = client.clone();
        let verification_user_id = client.user_id().map(ToOwned::to_owned);
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
        self.watch_devices(&client, generation);
        self.watch_notifications(&client, generation).await;
        self.watch_notification_settings(generation);
        self.watch_space_sidebar(&client, generation);
        self.watch_calendars(&client, generation);
        self.watch_widget_feed(&client, generation);
        self.watch_room_widgets(&client, generation);
        self.watch_cosmetics(&client, generation);
        self.watch_profile_changes(&client, generation);
        self.track_session_handler(&client, crate::rooms::repair_unreadable_tombstones(&client));
        self.watch_bot_commands(&client, generation);
        self.watch_image_packs(&client, generation);
        self.watch_joined_invites(&client);
        self.watch_send_queue(&client);
        self.watch_presence(&client, generation);
        let store_id = self
            .accounts
            .lock()
            .await
            .as_ref()
            .and_then(|registry| {
                registry
                    .accounts
                    .iter()
                    .find(|account| account.account_id == account_id)
                    .map(|account| account.store_id.clone())
            })
            .unwrap_or_else(|| self.store_id.clone());
        self.watch_search_index(&client, &store_id);
        self.watch_ignored_users(&client);
        self.watch_backup_preference(&client);
        sync_service.start().await;

        client.send_queue().enable_upload_progress(true);
        client
            .send_queue()
            .respawn_tasks_for_rooms_with_unsent_requests()
            .await;

        let core = self.clone();
        let mut states = sync_service.state();
        let restarted = sync_service.clone();
        let support_client = client.clone();
        // `Subscriber::next` yields only on *change*, so emit the first by hand.
        core.emit_if_current(generation, CoreEvent::SyncStatus(sync_status(states.get())));
        self.track_session_task(
            spawn(async move {
                let mut failures = 0u32;
                while let Some(state) = states.next().await {
                    if core.account_locked.load(Ordering::SeqCst) {
                        continue;
                    }
                    let stalled = matches!(
                        state,
                        SyncState::Error(_) | SyncState::Terminated | SyncState::Idle
                    );
                    let running = matches!(state, SyncState::Running);
                    core.emit_if_current(generation, CoreEvent::SyncStatus(sync_status(state)));
                    if running {
                        core.reconcile_memberships().await;
                        core.fill_own_members().await;
                        core.align_notification_rules().await;
                    }

                    if stalled {
                        if core.detect_account_lock(&support_client, generation).await {
                            continue;
                        }
                        if matches!(
                            core.require_sliding_sync(&support_client).await,
                            Err(CommandErr::SlidingSyncUnsupported)
                        ) {
                            restarted.stop().await;
                            core.emit_if_current(
                                generation,
                                CoreEvent::SyncStatus(crate::protocol::SyncStatus::Error {
                                    message: "This homeserver does not support Sliding Sync."
                                        .to_owned(),
                                }),
                            );
                            return;
                        }
                        failures = failures.saturating_add(1);
                        crate::watchers::retry_backoff(failures).await;
                        if !core.account_locked.load(Ordering::SeqCst) {
                            restarted.start().await;
                        }
                    } else {
                        failures = 0;
                    }
                }
            })
            .abort_on_drop(),
        );

        if let Some(user_id) = verification_user_id {
            drop(spawn(async move {
                if let Err(error) = verification_client
                    .encryption()
                    .request_user_identity(&user_id)
                    .await
                {
                    tracing::warn!(
                        operation = "verification",
                        "could not refresh own device list: {error}"
                    );
                }
            }));
        }

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
            if self.session_generation.load(Ordering::SeqCst) == generation {
                self.emit(CoreEvent::SessionTokensRefreshed);
            }
            return false;
        };
        let soft_logout = data.soft_logout;

        if self.session_generation.load(Ordering::SeqCst) != generation {
            return true;
        }

        let core = self.clone();
        drop(spawn(async move {
            let _activation = core.session_activation_lock.lock().await;
            let _swap = core.session_swap_lock.lock().await;
            if core.session_generation.load(Ordering::SeqCst) != generation {
                return;
            }
            let invalidated = core
                .session_attempt_generation
                .fetch_add(1, Ordering::SeqCst)
                + 1;
            core.session_generation.store(invalidated, Ordering::SeqCst);
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

fn oauth_device_delete_url(
    metadata: &matrix_sdk::ruma::api::client::discovery::get_authorization_server_metadata::v1::AuthorizationServerMetadata,
    device_id: &matrix_sdk::ruma::DeviceId,
) -> Result<String, CommandErr> {
    use matrix_sdk::ruma::api::client::discovery::get_authorization_server_metadata::v1::{
        AccountManagementAction, AccountManagementActionData, DeviceDeleteData,
    };
    if !metadata.is_account_management_action_supported(&AccountManagementAction::DeviceDelete) {
        return Err(CommandErr::Unsupported);
    }
    metadata
        .account_management_url_with_action(AccountManagementActionData::DeviceDelete(
            DeviceDeleteData::new(device_id),
        ))
        .map(|url| url.to_string())
        .ok_or(CommandErr::Unsupported)
}

#[cfg(not(target_family = "wasm"))]
const CACHE_DATABASES: [&str; 2] = ["matrix-sdk-event-cache.sqlite3", "matrix-sdk-media.sqlite3"];

#[cfg(not(target_family = "wasm"))]
async fn reset_account_cache(account: &PersistedAccount) -> Result<(), crate::CoreError> {
    use matrix_sdk_base::crypto::store::CryptoStore as _;

    let store = std::path::Path::new(&account.store_id).join("store");
    if !store.exists() {
        return Ok(());
    }

    session::validate_saved_crypto_store(&account.store_id, &account.session).await?;

    let crypto = matrix_sdk::SqliteCryptoStore::open(&store, None)
        .await
        .map_err(crate::CoreError::backend)?;
    crypto
        .remove_custom_value(&format!(
            "sliding_sync_store::room-list::{}::instance",
            account.session.credentials.user_id()
        ))
        .await
        .map_err(crate::CoreError::backend)?;
    drop(crypto);

    search::reset_state_cache(&store).await?;

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

#[cfg(all(test, not(target_family = "wasm")))]
mod regression_tests {
    use crate::session::{self, Credentials};
    use std::sync::Arc;

    use matrix_sdk::{
        Room,
        ruma::{event_id, events::room::message::RoomMessageEventContent, room_id},
        test_utils::mocks::MatrixMockServer,
    };
    use matrix_sdk_ui::sync_service::SyncService;
    use wiremock::ResponseTemplate;

    use crate::{
        CachedTimeline, Core, protocol::CommandErr, session::Session, store::MemorySessionStore,
    };

    struct DelayedSecondSave {
        attempts: Arc<std::sync::atomic::AtomicUsize>,
        bytes: Arc<std::sync::Mutex<Option<Vec<u8>>>>,
        started: Arc<tokio::sync::Notify>,
        release: Arc<tokio::sync::Notify>,
    }

    #[async_trait::async_trait]
    impl crate::store::SessionStore for DelayedSecondSave {
        async fn load(&self) -> Result<Option<Vec<u8>>, crate::store::StoreError> {
            Ok(self
                .bytes
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .clone())
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
            *self
                .bytes
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(bytes);
            Ok(())
        }

        async fn clear(&self) -> Result<(), crate::store::StoreError> {
            Ok(())
        }
    }

    #[expect(clippy::unwrap_used, reason = "test code")]
    async fn core_with_room() -> (MatrixMockServer, Arc<Core>, Room) {
        let server = MatrixMockServer::new().await;
        server
            .mock_versions()
            .with_feature("org.matrix.msc4140", true)
            .ok()
            .mount()
            .await;
        let client = server.client_builder().no_server_versions().build().await;
        client.event_cache().subscribe().unwrap();
        let room = server
            .sync_joined_room(&client, room_id!("!regression:example.org"))
            .await;
        let sync_service = Arc::new(SyncService::builder(client.clone()).build().await.unwrap());
        let (core, _events) = Core::new("regression", Box::new(MemorySessionStore::default()));
        *core.session.write().await = Some(Session {
            account_id: "first".to_owned(),
            client,
            sync_service,
            homeserver: server.server().uri(),
            oauth: false,
        });
        (server, core, room)
    }

    #[test]
    fn oauth_device_deletion_requires_an_advertised_management_action() {
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
        assert!(matches!(
            super::oauth_device_delete_url(&metadata, device),
            Err(CommandErr::Unsupported)
        ));
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
            Err(CommandErr::Unsupported)
        ));
    }

    #[tokio::test]
    async fn overlapping_failed_attempts_leave_committed_generation_unchanged() {
        use std::sync::atomic::Ordering;
        let (core, _events) = Core::new("attempts", Box::new(MemorySessionStore::default()));
        let first = core.claim_session_generation().await;
        let second = core.claim_session_generation();
        tokio::pin!(second);
        assert!(futures_util::poll!(second.as_mut()).is_pending());
        assert_eq!(core.session_generation.load(Ordering::SeqCst), 1);
        drop(first);
        let second = second.await;
        assert_eq!(second.value(), 3);
        assert_eq!(core.session_generation.load(Ordering::SeqCst), 1);
        drop(second);
        assert_eq!(core.session_generation.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn unknown_token_during_failed_preparation_still_ends_the_active_session() {
        use crate::session::{AccountRegistry, PersistedAccount, current_session};
        let (server, core, room) = core_with_room().await;
        let mut registry = AccountRegistry::empty();
        registry.active_account_id = Some("first".to_owned());
        registry.upsert(PersistedAccount {
            account_id: "first".to_owned(),
            store_id: "regression".to_owned(),
            session: current_session(&room.client(), server.server().uri()).unwrap(),
            needs_reauth: false,
            device_invalidated: false,
        });
        *core.accounts.lock().await = Some(registry);
        let pending = core.claim_session_generation().await;
        let mut rejected = matrix_sdk::ruma::api::error::UnknownTokenErrorData::new();
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
                assert!(account.session.credentials.tokens().access_token.is_empty());
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
        let (server, core, room) = core_with_room().await;
        let mut registry = AccountRegistry::empty();
        registry.active_account_id = Some("first".to_owned());
        registry.upsert(PersistedAccount {
            account_id: "first".to_owned(),
            store_id: "regression".to_owned(),
            session: current_session(&room.client(), server.server().uri()).unwrap(),
            needs_reauth: false,
            device_invalidated: false,
        });
        *core.accounts.lock().await = Some(registry);
        let rejected = matrix_sdk::ruma::api::error::UnknownTokenErrorData::new();
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
    async fn switching_back_to_a_cached_client_rebuilds_one_set_of_handlers() {
        use crate::session::{AccountRegistry, PersistedAccount, current_session};
        let (server, core, room) = core_with_room().await;
        let client = room.client();
        let mut registry = AccountRegistry::empty();
        registry.upsert(PersistedAccount {
            account_id: "first".to_owned(),
            store_id: "regression".to_owned(),
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
                generation.value(),
            )
            .await
            .unwrap();
            handler_counts.push(core.session_handlers.lock().unwrap().len());
            assert_eq!(core.account_clients.lock().await.len(), 1);
            assert_eq!(core.credential_writers.lock().await.len(), 1);
        }
        assert!(handler_counts[0] > 0);
        assert_eq!(handler_counts[0], handler_counts[1]);
        let session = core.take_session().await.unwrap();
        session.sync_service.stop().await;
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
                    "version": 5, "derived": 1, "next_chunk": 2, "edits": [],
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
                .search(
                    "archaeology",
                    &crate::protocol::SearchFilter::default(),
                    crate::protocol::SearchOrder::Rank,
                    10,
                    0
                )
                .len(),
            2
        );
        Ok(())
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_cache_reset_keeps_the_login_keys_and_search_index_but_not_the_sync_position() {
        use crate::session::{AccountRegistry, Credentials, PersistedAccount, PersistedSession};
        use matrix_sdk_base::crypto::store::CryptoStore as _;

        let server = MatrixMockServer::new().await;
        let base = std::env::temp_dir().join(format!(
            "sable-reset-{}",
            matrix_sdk::ruma::TransactionId::new()
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
        let search_values = seed_search_index(&client).await.unwrap();
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
        let persisted = Arc::new(std::sync::Mutex::new(None));
        let persistence_started = Arc::new(tokio::sync::Notify::new());
        let release_persistence = Arc::new(tokio::sync::Notify::new());
        let (core, _events) = Core::new(
            "refresh-regression",
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
        core.prepare_account_client(&client, &server.server().uri(), "first", 1)
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
        let wait = std::sync::Mutex::new(wait);
        let received = arrived.clone();
        Mock::given(method("POST"))
            .and(path("/_matrix/client/v3/refresh"))
            .respond_with(move |_: &wiremock::Request| {
                received.notify_one();
                wait.lock()
                    .unwrap()
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
        core.session_generation
            .store(2, std::sync::atomic::Ordering::SeqCst);
        let previous = core.take_session().await.unwrap();
        previous.sync_service.stop().await;
        let account = core.accounts().await.unwrap().accounts.remove(0);
        let resumed = core.saved_account_client(&account).await.unwrap();
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
        let bytes = persisted
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
            .unwrap();
        let stored: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(
            stored["accounts"][0]["session"]["credentials"]["refresh_token"],
            "new-refresh"
        );
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
        let (server, _, room) = core_with_room().await;
        let (core, _) = Core::new(
            "retire-regression",
            Box::new(RejectSaves {
                attempts: Arc::new(std::sync::atomic::AtomicUsize::new(0)),
            }),
        );
        let mut registry = AccountRegistry::empty();
        registry.active_account_id = Some("first".to_owned());
        registry.upsert(PersistedAccount {
            account_id: "first".to_owned(),
            store_id: "unused".to_owned(),
            session: current_session(&room.client(), server.server().uri()).unwrap(),
            needs_reauth: false,
            device_invalidated: false,
        });
        *core.accounts.lock().await = Some(registry);
        core.credential_writers
            .lock()
            .await
            .insert("first".into(), 1);
        core.mark_account_needs_reauth(Some("first"), true)
            .await
            .unwrap_err();
        let accounts = core.accounts().await.unwrap();
        assert!(accounts.active_account_id.is_none());
        assert!(accounts.accounts[0].needs_reauth);
        assert!(accounts.accounts[0].device_invalidated);
        assert!(core.credential_writers.lock().await.is_empty());
    }

    #[tokio::test]
    async fn failed_switch_persistence_keeps_the_previous_session() {
        use crate::session::{AccountRegistry, PersistedAccount, current_session};
        let (server, previous_core, _) = core_with_room().await;
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
            generation.value(),
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
        assert_eq!(
            core.session_generation
                .load(std::sync::atomic::Ordering::SeqCst),
            1
        );
    }

    #[tokio::test]
    async fn token_reload_reads_the_durable_session_and_refuses_retired_writers() {
        use crate::session::{AccountRegistry, PersistedAccount, current_session};
        let (server, core, room) = core_with_room().await;
        let client = room.client();
        let mut registry = AccountRegistry::empty();
        let mut saved = current_session(&client, server.server().uri()).unwrap();
        if let Credentials::Password(session) = &mut saved.credentials {
            session.tokens.access_token = "rotated-access".into();
            session.tokens.refresh_token = Some("rotated-refresh".into());
        }
        registry.upsert(PersistedAccount {
            account_id: "first".into(),
            store_id: "unused".into(),
            session: saved,
            needs_reauth: false,
            device_invalidated: false,
        });
        core.sessions
            .save(serde_json::to_vec(&registry).unwrap())
            .await
            .unwrap();
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
        core.credential_writers.lock().await.remove("first");
        assert!(matches!(
            core.reload_saved_tokens("first", 1).await,
            Err(CommandErr::NotLoggedIn)
        ));
    }

    #[tokio::test]
    async fn outgoing_credentials_survive_switch_without_resurrecting_accounts() {
        use crate::session::{AccountRegistry, Credentials, PersistedAccount, current_session};
        use std::sync::atomic::Ordering;

        let (_server, core, room) = core_with_room().await;
        let client = room.client();
        let fresh = current_session(&client, "example.org".to_owned()).unwrap();
        let mut stale = fresh.clone();
        if let Credentials::Password(matrix) = &mut stale.credentials {
            matrix.tokens.access_token = "stale".to_owned();
        }
        let mut registry = AccountRegistry::empty();
        registry.upsert(PersistedAccount {
            account_id: "first".to_owned(),
            store_id: "regression".to_owned(),
            session: stale.clone(),
            needs_reauth: false,
            device_invalidated: false,
        });
        *core.accounts.lock().await = Some(registry);
        core.credential_writers
            .lock()
            .await
            .insert("first".to_owned(), 1);
        core.session_generation.store(2, Ordering::SeqCst);
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
        let (server, core, room) = core_with_room().await;
        server.mock_room_state_encryption().plain().mount().await;
        let room_id = room.room_id().to_owned();
        let thread_root = event_id!("$thread").to_owned();
        let timeline = core.timeline(&room_id).await.unwrap();
        core.thread_timelines.lock().await.insert(
            (room_id.clone(), thread_root.clone()),
            CachedTimeline {
                timeline: timeline.clone(),
                hidden_events: false,
                last_access: 0,
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
            Err(CommandErr::NotLoggedIn)
        ));
    }

    #[tokio::test]
    async fn session_teardown_waits_for_in_flight_timeline_builders() {
        let (server, core, room) = core_with_room().await;
        server.mock_room_state_encryption().plain().mount().await;
        let room_id = room.room_id().to_owned();
        let cache = core.timelines.lock().await;
        let mut build = std::pin::pin!(core.live_timeline(&room_id, false));
        assert!(futures_util::poll!(build.as_mut()).is_pending());
        drop(cache);

        let mut teardown = std::pin::pin!(core.take_session());
        assert!(futures_util::poll!(teardown.as_mut()).is_pending());
        build.await.unwrap();
        assert!(teardown.await.is_some());
        assert!(core.timelines.lock().await.is_empty());
    }

    #[tokio::test]
    async fn confirmed_unencrypted_rooms_still_allow_plaintext_operations() {
        let (server, core, room) = core_with_room().await;
        server.mock_room_state_encryption().plain().mount().await;
        assert!(!core.room_is_encrypted(&room).await.unwrap());
    }

    #[tokio::test]
    async fn encryption_lookup_failure_prevents_plaintext_operations() {
        let (server, core, room) = core_with_room().await;
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

        let scheduled = core
            .schedule_message(
                &room_id,
                RoomMessageEventContent::text_plain("secret"),
                1000,
            )
            .await;
        assert!(
            matches!(scheduled, Err(CommandErr::Denied)),
            "{scheduled:?}"
        );
        assert!(matches!(
            core.set_bookmark(&room_id, &event_id!("$secret").to_owned(), true, 1000)
                .await,
            Err(CommandErr::Denied)
        ));
        assert!(matches!(
            core.join_call(
                room_id,
                Some("https://focus.example.org".to_owned()),
                None,
                None
            )
            .await,
            Err(CommandErr::Denied)
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
