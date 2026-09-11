use std::sync::{Arc, atomic::Ordering};

use matrix_sdk::executor::{JoinHandleExt, spawn};
use matrix_sdk_ui::sync_service::State as SyncState;

use crate::protocol::{CommandErr, CommandOk, CoreEvent, SessionInfo};

use crate::session::{Credentials, PersistedAccount, PersistedSession, Session};

use crate::Core;
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
                .map_err(|error| self.failed("restore: user id", error))?,
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
                        .map_err(|error| self.failed("list accounts: user id", error))?,
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
                .map_err(|error| self.failed("switch account: user id", error))?,
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
        if reauth.is_some()
            && !registry
                .accounts
                .iter()
                .any(|account| account.account_id == account_id && account.needs_reauth)
        {
            return Err(CommandErr::NotLoggedIn);
        }
        let mut updated = registry.clone();
        updated.upsert(PersistedAccount {
            account_id: account_id.to_owned(),
            store_id: store_id.to_owned(),
            session: persisted.clone(),
            needs_reauth: false,
        });
        let bytes = serde_json::to_vec(&updated)
            .map_err(|error| self.failed("persist: serialize", error))?;
        self.sessions
            .save(bytes)
            .await
            .map_err(|error| self.failed("persist: save", error))?;
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
        let bytes = serde_json::to_vec(&updated)
            .map_err(|error| self.failed("refresh: serialize", error))?;
        self.sessions
            .save(bytes)
            .await
            .map_err(|error| self.failed("refresh: save", error))?;
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
        let client = session::restore_client(&account.store_id, &account.session)
            .await
            .map_err(|error| self.failed("restore: build_client", error))?;
        match account.session.credentials.clone() {
            Credentials::Password(matrix) => client
                .restore_session(matrix)
                .await
                .map_err(|error| self.failed("restore_session", error))?,
            Credentials::OAuth { client_id, user } => client
                .oauth()
                .restore_session(
                    session::oauth_session(client_id, user),
                    matrix_sdk::store::RoomLoadSettings::default(),
                )
                .await
                .map_err(|error| self.failed("restore_session: oauth", error))?,
        }
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
        let bytes = serde_json::to_vec(&updated)
            .map_err(|error| self.failed("activate account: serialize", error))?;
        self.sessions
            .save(bytes)
            .await
            .map_err(|error| self.failed("activate account: save", error))?;
        *accounts = Some(updated);
        Ok(())
    }

    pub(crate) async fn clear_persisted_session(&self) -> Result<(), CommandErr> {
        let _guard = self.session_store_lock.lock().await;
        self.sessions
            .clear()
            .await
            .map_err(|error| self.failed("clear session", error))
    }

    pub(crate) async fn mark_account_needs_reauth(
        &self,
        account_id: Option<&str>,
    ) -> Result<(), CommandErr> {
        let Some(account_id) = account_id else {
            return Ok(());
        };

        let _guard = self.session_store_lock.lock().await;
        let mut accounts = self.accounts.lock().await;
        let Some(registry) = accounts.as_mut() else {
            return Err(self.failed("soft logout", "account registry is not initialized"));
        };
        let Some(account) = registry
            .accounts
            .iter_mut()
            .find(|account| account.account_id == account_id)
        else {
            return Ok(());
        };
        self.invalidate_account_client(account_id).await;
        account.needs_reauth = true;
        if registry.active_account_id.as_deref() == Some(account_id) {
            registry.active_account_id = None;
        }
        let bytes = serde_json::to_vec(registry)
            .map_err(|error| self.failed("soft logout: serialize accounts", error))?;
        self.sessions
            .save(bytes)
            .await
            .map_err(|error| self.failed("soft logout: save accounts", error))
    }

    async fn remove_account(&self, account_id: Option<&str>) -> Result<(), CommandErr> {
        let Some(account_id) = account_id else {
            return self.clear_persisted_session().await;
        };

        let _guard = self.session_store_lock.lock().await;
        let mut accounts = self.accounts.lock().await;
        let Some(registry) = accounts.as_mut() else {
            return Err(self.failed("remove account", "account registry is not initialized"));
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
        let bytes = serde_json::to_vec(registry)
            .map_err(|error| self.failed("logout: serialize accounts", error))?;
        self.sessions
            .save(bytes)
            .await
            .map_err(|error| self.failed("logout: save accounts", error))?;
        if let Some(store_id) = store_id {
            self.discard_account_store(&store_id);
        }
        Ok(())
    }

    fn discard_account_store(&self, store_id: &str) {
        if session::removable_account_store(&self.store_id, store_id) {
            remove_store_dir(store_id);
        } else {
            tracing::warn!(store_id, "refusing to delete a shared account store");
        }
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
        self.timelines.lock().await.clear();
        self.thread_timelines.lock().await.clear();
        self.account_data_types.lock().await.clear();
        self.set_read_room(None);
        self.probed_pinned_rooms
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clear();
        *self.search_index.lock().await = search::MessageIndex::new();
        self.search_crawl.lock().await.reset();
        self.server_search.lock().await.reset();
        session.take()
    }

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
            .map_err(|error| self.failed("subscribe_event_cache", error))?;

        let session_changes = client.subscribe_to_session_changes();
        let sync_service = session::build_sync(client.clone())
            .await
            .map_err(|error| self.failed("start_sync", error))?;

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
        self.watch_notification_settings(&client, generation);
        self.watch_space_sidebar(&client, generation);
        self.watch_send_queue(&client);
        self.watch_search_index(&client);
        self.watch_ignored_users(&client);
        sync_service.start().await;

        client
            .send_queue()
            .respawn_tasks_for_rooms_with_unsent_requests()
            .await;

        let core = self.clone();
        let mut states = sync_service.state();
        let restarted = sync_service.clone();
        // `Subscriber::next` yields only on *change*, so emit the first by hand.
        core.emit_if_current(generation, CoreEvent::SyncStatus(sync_status(states.get())));
        self.track_session_task(
            spawn(async move {
                let mut failures = 0u32;
                while let Some(state) = states.next().await {
                    let stalled = matches!(
                        state,
                        SyncState::Error(_) | SyncState::Terminated | SyncState::Idle
                    );
                    core.emit_if_current(generation, CoreEvent::SyncStatus(sync_status(state)));

                    if stalled {
                        failures = failures.saturating_add(1);
                        matrix_sdk::sleep::sleep(std::time::Duration::from_secs(
                            2u64.saturating_pow(failures.min(5)),
                        ))
                        .await;
                        restarted.start().await;
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
            drop(spawn(async move {
                if let Err(error) = core
                    .persist_refreshed(&client, &homeserver, &account_id, generation)
                    .await
                {
                    tracing::error!("could not persist refreshed session: {error:?}");
                }
            }));

            Ok(())
        };

        let reload = move |client: matrix_sdk::Client| {
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

            let outcome = if soft_logout {
                core.mark_account_needs_reauth(account_id.as_deref()).await
            } else {
                core.remove_account(account_id.as_deref()).await
            };
            if let Err(error) = outcome {
                tracing::error!(soft_logout, "could not clear rejected session: {error:?}");
            }

            core.emit(CoreEvent::SessionEnded {
                reason: if soft_logout {
                    "soft_logout".to_owned()
                } else {
                    "token_rejected".to_owned()
                },
            });
        }));
        true
    }
}

#[cfg(not(target_family = "wasm"))]
fn remove_store_dir(store_id: &str) {
    if let Err(error) = std::fs::remove_dir_all(store_id)
        && error.kind() != std::io::ErrorKind::NotFound
    {
        tracing::error!(store_id, "could not delete the account store: {error}");
    }
}

#[cfg(target_family = "wasm")]
const fn remove_store_dir(_store_id: &str) {}

#[cfg(all(test, not(target_family = "wasm")))]
#[allow(clippy::large_futures)]
mod regression_tests {
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

    #[allow(clippy::unwrap_used, clippy::expect_used)]
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
        let (core, _events) = Core::new(
            "refresh-regression",
            Box::new(MemorySessionStore::default()),
        );
        let mut registry = AccountRegistry::empty();
        registry.upsert(PersistedAccount {
            account_id: "first".to_owned(),
            store_id: "unused".to_owned(),
            session: current_session(&client, server.server().uri()).unwrap(),
            needs_reauth: false,
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
        refresh.await.unwrap().unwrap();
        assert_eq!(
            resumed.session_tokens().unwrap().refresh_token.as_deref(),
            Some("new-refresh")
        );
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                let saved = core.accounts().await.unwrap();
                let stored = serde_json::to_value(&saved.accounts[0].session).unwrap();
                if stored["credentials"]["refresh_token"] == "new-refresh" {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
    }

    struct RejectSaves {
        attempts: Arc<std::sync::atomic::AtomicUsize>,
    }

    #[async_trait::async_trait]
    impl crate::store::SessionStore for RejectSaves {
        async fn load(&self) -> Result<Option<Vec<u8>>, String> {
            Ok(None)
        }
        async fn save(&self, _: Vec<u8>) -> Result<(), String> {
            self.attempts
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            Err("disk is full".to_owned())
        }
        async fn clear(&self) -> Result<(), String> {
            Ok(())
        }
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
            core.join_call(room_id, Some("https://focus.example.org".to_owned()), None)
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
