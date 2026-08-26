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
    core: &'core Core,
    value: u64,
    committed: bool,
}

impl SessionGeneration<'_> {
    pub(crate) const fn value(&self) -> u64 {
        self.value
    }

    pub(crate) const fn commit(&mut self) {
        self.committed = true;
    }
}

impl Drop for SessionGeneration<'_> {
    fn drop(&mut self) {
        if self.committed {
            return;
        }
        let _ = self.core.session_generation.compare_exchange(
            self.value,
            self.value.saturating_sub(1),
            Ordering::SeqCst,
            Ordering::SeqCst,
        );
    }
}

impl Core {
    pub(crate) fn claim_session_generation(&self) -> SessionGeneration<'_> {
        SessionGeneration {
            core: self,
            value: self.session_generation.fetch_add(1, Ordering::SeqCst) + 1,
            committed: false,
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
        let persisted = account.session;

        let client = session::build_client(&account.store_id, &persisted.homeserver)
            .await
            .map_err(|error| self.failed("restore: build_client", error))?;

        let info = SessionInfo {
            account_id: account.account_id.clone(),
            user_id: persisted
                .credentials
                .user_id()
                .parse()
                .map_err(|error| self.failed("restore: user id", error))?,
            device_id: persisted.credentials.device_id(),
        };

        match persisted.credentials {
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

        let mut generation = self.claim_session_generation();
        self.start_session(
            client,
            persisted.homeserver,
            account.account_id,
            generation.value(),
        )
        .await?;
        generation.commit();

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
                })
            })
            .collect::<Result<Vec<_>, _>>()?;
        Ok(CommandOk::ListAccounts { accounts })
    }

    pub(crate) async fn switch_account(
        self: &Arc<Self>,
        account_id: String,
    ) -> Result<CommandOk, CommandErr> {
        let accounts = self.accounts().await?;
        let account = accounts
            .accounts
            .into_iter()
            .find(|account| account.account_id == account_id)
            .ok_or(CommandErr::NotLoggedIn)?;
        let persisted = account.session;
        let client = session::build_client(&account.store_id, &persisted.homeserver)
            .await
            .map_err(|error| self.failed("switch account: build_client", error))?;
        let info = SessionInfo {
            account_id: account.account_id.clone(),
            user_id: persisted
                .credentials
                .user_id()
                .parse()
                .map_err(|error| self.failed("switch account: user id", error))?,
            device_id: persisted.credentials.device_id(),
        };
        match persisted.credentials {
            Credentials::Password(matrix) => client
                .restore_session(matrix)
                .await
                .map_err(|error| self.failed("switch account: restore_session", error))?,
            Credentials::OAuth { client_id, user } => client
                .oauth()
                .restore_session(
                    session::oauth_session(client_id, user),
                    matrix_sdk::store::RoomLoadSettings::default(),
                )
                .await
                .map_err(|error| self.failed("switch account: restore_session: oauth", error))?,
        }

        let mut generation = self.claim_session_generation();
        self.pending_registration.lock().await.take();
        self.pending_login.lock().await.take();
        self.start_session(
            client,
            persisted.homeserver,
            account.account_id,
            generation.value(),
        )
        .await?;
        self.set_active_account(&info.account_id).await?;
        generation.commit();
        Ok(CommandOk::SwitchAccount { session: info })
    }

    pub(crate) async fn logout(self: &Arc<Self>) -> Result<CommandOk, CommandErr> {
        self.session_generation.fetch_add(1, Ordering::SeqCst);
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
        generation: u64,
    ) -> Result<(), CommandErr> {
        let _guard = self.session_store_lock.lock().await;
        if self.session_generation.load(Ordering::SeqCst) != generation {
            return Ok(());
        }
        let mut accounts = self.accounts.lock().await;
        let Some(registry) = accounts.as_mut() else {
            return Err(self.failed("persist", "account registry is not initialized"));
        };
        registry.upsert(PersistedAccount {
            account_id: account_id.to_owned(),
            store_id: store_id.to_owned(),
            session: persisted.clone(),
        });
        let bytes = serde_json::to_vec(registry)
            .map_err(|error| self.failed("persist: serialize", error))?;
        self.sessions
            .save(bytes)
            .await
            .map_err(|error| self.failed("persist: save", error))
    }

    pub(crate) async fn set_active_account(&self, account_id: &str) -> Result<(), CommandErr> {
        let _guard = self.session_store_lock.lock().await;
        let mut accounts = self.accounts.lock().await;
        let Some(registry) = accounts.as_mut() else {
            return Err(self.failed("switch account", "account registry is not initialized"));
        };
        if !registry
            .accounts
            .iter()
            .any(|account| account.account_id == account_id)
        {
            return Err(CommandErr::NotLoggedIn);
        }
        registry.active_account_id = Some(account_id.to_owned());
        let bytes = serde_json::to_vec(registry)
            .map_err(|error| self.failed("switch account: serialize", error))?;
        self.sessions
            .save(bytes)
            .await
            .map_err(|error| self.failed("switch account: save", error))
    }

    pub(crate) async fn clear_persisted_session(&self) -> Result<(), CommandErr> {
        let _guard = self.session_store_lock.lock().await;
        self.sessions
            .clear()
            .await
            .map_err(|error| self.failed("clear session", error))
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
        Ok(())
    }

    async fn take_session(&self) -> Option<Session> {
        self.end_all_calls().await;
        self.session_tasks
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clear();
        self.subscriptions.lock().await.clear();
        self.timelines.lock().await.clear();
        *self.search_index.lock().await = search::MessageIndex::new();
        self.session.write().await.take()
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

        // Event handlers do not spawn until sync starts, and are owned by the
        // client. Register them now so the first sync response cannot race us.
        self.watch_ephemeral(&client, generation);
        self.watch_incoming_calls(&client, generation);
        self.watch_incoming_verifications(&client);

        self.install_session_callbacks(&client, &homeserver, &account_id, generation);

        let sync_service = session::start_sync(client.clone())
            .await
            .map_err(|error| self.failed("start_sync", error))?;

        let _swap = self.session_swap_lock.lock().await;
        if self.session_generation.load(Ordering::SeqCst) != generation {
            sync_service.stop().await;
            return Err(CommandErr::Unavailable);
        }

        // Do not disrupt the active session unless its replacement started
        // successfully. `take_session` also aborts its owned watcher tasks.
        if let Some(previous) = self.take_session().await {
            previous.sync_service.stop().await;
        }

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

        self.watch_session_changes(&client, generation);
        self.watch_encryption(&client, generation);
        self.watch_devices(&client, generation);
        self.watch_notifications(&client, generation);
        self.watch_notification_settings(&client, generation);
        self.watch_space_sidebar(&client, generation);
        self.watch_send_queue(&client);
        self.watch_search_index(&client);
        self.watch_ignored_users(&client);

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
        let saver = self.clone();
        let saved_homeserver = homeserver.to_owned();
        let saved_account_id = account_id.to_owned();

        let save = move |client: matrix_sdk::Client| {
            let account_id = saved_account_id.clone();
            let Some(persisted) = session::current_session(&client, saved_homeserver.clone())
            else {
                return Ok(());
            };

            // The callback is synchronous and the store is not. A failure only
            // costs the next restore, so it is logged.
            let core = saver.clone();
            drop(spawn(async move {
                let store_id: Option<String> = {
                    let accounts = core.accounts.lock().await;
                    accounts
                        .as_ref()
                        .and_then(|accounts| {
                            accounts
                                .accounts
                                .iter()
                                .find(|account| account.account_id == account_id)
                        })
                        .map(|account| account.store_id.clone())
                };
                let Some(store_id) = store_id else {
                    return;
                };
                if let Err(error) = core
                    .persist(&account_id, &store_id, &persisted, generation)
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

    fn watch_session_changes(self: &Arc<Self>, client: &matrix_sdk::Client, generation: u64) {
        let core = self.clone();
        let mut changes = client.subscribe_to_session_changes();
        self.track_session_task(
            spawn(async move {
                while let Ok(change) = changes.recv().await {
                    if core.handle_session_change(&change, generation) {
                        return;
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
        if !matches!(change, matrix_sdk::SessionChange::UnknownToken(_)) {
            return false;
        }

        if self
            .session_generation
            .compare_exchange(
                generation,
                generation + 1,
                Ordering::SeqCst,
                Ordering::SeqCst,
            )
            .is_err()
        {
            return true;
        }

        let core = self.clone();
        let doomed = generation + 1;
        drop(spawn(async move {
            let _swap = core.session_swap_lock.lock().await;
            if core.session_generation.load(Ordering::SeqCst) != doomed {
                return;
            }
            let session = core.take_session().await;
            let account_id = session.as_ref().map(|session| session.account_id.clone());
            if let Some(session) = session {
                session.sync_service.stop().await;
            }
            if let Err(error) = core.remove_account(account_id.as_deref()).await {
                tracing::error!("could not clear rejected session: {error:?}");
            }
            core.emit(CoreEvent::SessionEnded {
                reason: "token_rejected".to_owned(),
            });
        }));
        true
    }
}
