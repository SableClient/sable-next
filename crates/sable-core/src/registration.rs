use super::{
    AuthData, AuthFlow, AuthType, ClientSecret, CommandErr, CommandOk, Core, Credentials,
    EmailIdentity, ErrorKind, IdentityServerInfo, MatrixUserIdentifier, OwnedClientSecret,
    OwnedSessionId, Password, PersistedSession, RegistrationEmailRequest, RegistrationRequest,
    RegistrationResultView, RetryAfter, ThirdpartyIdCredentials, UInt, UiaaInfo, UserIdentifier,
    protocol, session,
};
use serde::Deserialize;
use std::sync::{Arc, atomic::Ordering};
use url::Url;

#[derive(Debug, Deserialize)]
struct EmailSubmitResponse {
    success: bool,
}

#[derive(Debug, Deserialize)]
struct MatrixEmailError {
    errcode: Option<String>,
}

fn map_email_submit_error(body: &[u8]) -> CommandErr {
    match serde_json::from_slice::<MatrixEmailError>(body)
        .ok()
        .and_then(|error| error.errcode)
        .as_deref()
    {
        Some("M_THREEPID_IN_USE") => CommandErr::InvalidEmail,
        Some("M_THREEPID_AUTH_FAILED" | "M_INVALID_PARAM") | None => {
            CommandErr::EmailVerificationFailed
        }
        Some(_) => CommandErr::EmailVerificationFailed,
    }
}

pub(super) struct PendingRegistration {
    account_id: String,
    store_id: String,
    attempt_id: u64,
    homeserver: String,
    client: matrix_sdk::Client,
    username: String,
    password: String,
    registration_email: Option<String>,
    registration_token: Option<String>,
    session: String,
    flows: Vec<Vec<String>>,
    completed: Vec<String>,
    email: Option<PendingEmail>,
}

struct PendingEmail {
    address: Option<String>,
    client_secret: Option<OwnedClientSecret>,
    sid: Option<OwnedSessionId>,
    submit_url: Option<String>,
    can_complete_out_of_band: bool,
    send_attempt: u32,
    id_server: Option<String>,
    id_access_token: Option<String>,
    verified: bool,
}

enum RegistrationAction {
    Submit {
        auth: AuthData,
        used_fallback_acknowledgement: bool,
    },
    View(RegistrationResultView),
}

pub(super) fn registration_request(
    username: &str,
    password: &str,
    auth: Option<AuthData>,
) -> RegistrationRequest {
    let mut request = RegistrationRequest::new();
    request.username = Some(username.to_owned());
    request.password = Some(password.to_owned());
    request.initial_device_display_name = Some("Sable".to_owned());
    request.refresh_token = true;
    request.auth = auth;
    request
}

pub(super) fn registration_flows(
    flows: &[AuthFlow],
    registration_email: bool,
    registration_token: bool,
) -> Vec<Vec<String>> {
    let mut selected = flows
        .iter()
        .map(|flow| {
            flow.stages
                .iter()
                .map(ToString::to_string)
                .collect::<Vec<_>>()
        })
        .collect::<Vec<_>>();
    selected.sort_by_key(|stages| {
        let email_mismatch =
            stages.iter().any(|stage| stage == "m.login.email.identity") != registration_email;
        let token_mismatch = stages
            .iter()
            .any(|stage| stage == "m.login.registration_token")
            != registration_token;
        (
            usize::from(email_mismatch) + usize::from(token_mismatch),
            stages.len(),
        )
    });
    selected
}

pub(super) fn registration_requirement(
    flows: &[AuthFlow],
    stage: &AuthType,
) -> protocol::RegistrationRequirementView {
    let flow_count = flows.len();
    let matching_flow_count = flows
        .iter()
        .filter(|flow| flow.stages.contains(stage))
        .count();
    if matching_flow_count == 0 {
        return protocol::RegistrationRequirementView::Unavailable;
    }
    if matching_flow_count == flow_count {
        protocol::RegistrationRequirementView::Required
    } else {
        protocol::RegistrationRequirementView::Optional
    }
}

fn email_params(info: &UiaaInfo) -> (Option<String>, Option<String>) {
    info.params::<IdentityServerInfo>(&AuthType::EmailIdentity)
        .ok()
        .flatten()
        .map_or((None, None), |params| {
            (Some(params.id_server), Some(params.id_access_token))
        })
}

fn trusted_submit_url(pending: &PendingRegistration, submit_url: &str) -> Option<Url> {
    let identity_host = pending
        .email
        .as_ref()
        .and_then(|email| email.id_server.as_deref())
        .and_then(|id_server| Url::parse(&format!("https://{id_server}")).ok())
        .and_then(|url| url.host_str().map(ToOwned::to_owned));

    let url = Url::parse(submit_url).ok()?;
    let allowed = url.scheme() == "https"
        && url.host_str().is_some_and(|host| {
            pending.client.homeserver().host_str() == Some(host)
                || identity_host.as_deref() == Some(host)
        });

    allowed.then_some(url)
}

fn can_complete_email_out_of_band(versions: &matrix_sdk::ruma::api::SupportedVersions) -> bool {
    versions
        .versions
        .iter()
        .any(|version| *version >= matrix_sdk::ruma::api::MatrixVersion::V1_0)
}

impl Core {
    async fn restore_pending_registration(&self, pending: PendingRegistration) {
        let mut slot = self.pending_registration.lock().await;
        if self.next_registration_attempt.load(Ordering::Acquire) == pending.attempt_id {
            *slot = Some(pending);
        }
    }

    async fn finish_registration(
        self: &Arc<Self>,
        client: matrix_sdk::Client,
        homeserver: String,
        account_id: String,
        store_id: String,
    ) -> Result<RegistrationResultView, CommandErr> {
        let matrix = client
            .matrix_auth()
            .session()
            .ok_or_else(|| self.failed("register", "no session after a successful registration"))?;
        let user_id = matrix.meta.user_id.clone();
        let generation = self.session_generation.fetch_add(1, Ordering::SeqCst) + 1;
        self.persist(
            &account_id,
            &store_id,
            &PersistedSession {
                homeserver: homeserver.clone(),
                credentials: Credentials::Password(matrix),
            },
            generation,
        )
        .await?;
        self.start_session(client, homeserver, account_id.clone(), generation)
            .await?;
        self.set_active_account(&account_id).await?;
        Ok(RegistrationResultView::Complete { user_id })
    }

    fn registration_error(&self, error: matrix_sdk::Error) -> CommandErr {
        match error.client_api_error_kind() {
            Some(ErrorKind::Forbidden | ErrorKind::ThreepidDenied) => {
                CommandErr::RegistrationUnavailable
            }
            Some(ErrorKind::UserInUse) => CommandErr::UsernameTaken,
            Some(ErrorKind::InvalidUsername) => CommandErr::InvalidUsername,
            Some(ErrorKind::ThreepidInUse) => CommandErr::InvalidEmail,
            Some(ErrorKind::ThreepidAuthFailed) => CommandErr::EmailVerificationFailed,
            Some(ErrorKind::WeakPassword) => CommandErr::WeakPassword,
            Some(ErrorKind::LimitExceeded(limit)) => CommandErr::RateLimited {
                retry_after_ms: limit.retry_after.as_ref().and_then(|retry_after| {
                    let RetryAfter::Delay(delay) = retry_after else {
                        return None;
                    };
                    delay.as_millis().try_into().ok()
                }),
            },
            _ => match error {
                matrix_sdk::Error::Http(error) => self.homeserver_http_error("register", *error),
                _ => self.failed("register", error),
            },
        }
    }

    fn registration_step(
        &self,
        pending: &PendingRegistration,
    ) -> Result<RegistrationResultView, CommandErr> {
        let Some(stages) = pending.flows.first() else {
            return Err(self.failed("register", "homeserver returned no registration flows"));
        };
        let Some(stage) = stages.iter().find(|stage| {
            !pending
                .completed
                .iter()
                .any(|completed| completed == *stage)
        }) else {
            return Err(self.failed("register", "registration flow did not complete"));
        };

        let mut fallback_url = pending
            .client
            .homeserver()
            .join("_matrix/client/v3/auth/")
            .map_err(|error| self.failed("register: fallback URL", error))?;
        fallback_url
            .path_segments_mut()
            .map_err(|()| self.failed("register: fallback URL", "invalid homeserver URL"))?
            .push(stage)
            .push("fallback")
            .push("web");
        fallback_url
            .query_pairs_mut()
            .append_pair("session", &pending.session);

        Ok(RegistrationResultView::Fallback {
            stage: stage.clone(),
            fallback_url: fallback_url.to_string(),
            completed: pending.completed.clone(),
            total_stages: stages.len(),
        })
    }

    fn registration_email_step(
        &self,
        pending: &PendingRegistration,
    ) -> Result<RegistrationResultView, CommandErr> {
        let Some(stages) = pending.flows.first() else {
            return Err(self.failed("register", "homeserver returned no registration flows"));
        };
        let Some(email) = pending.email.as_ref() else {
            return Err(self.failed("register", "email UIAA state was not initialized"));
        };

        Ok(RegistrationResultView::Email {
            email: email.address.clone(),
            submit_url: email.submit_url.clone(),
            can_complete_out_of_band: email.can_complete_out_of_band,
            verified: email.verified,
            completed: pending.completed.clone(),
            total_stages: stages.len(),
        })
    }

    fn update_registration_email_params(pending: &mut PendingRegistration, info: &UiaaInfo) {
        let (id_server, id_access_token) = email_params(info);
        if pending.email.is_none()
            && pending
                .flows
                .iter()
                .any(|flow| flow.iter().any(|stage| stage == "m.login.email.identity"))
        {
            pending.email = Some(PendingEmail {
                address: None,
                client_secret: None,
                sid: None,
                submit_url: None,
                can_complete_out_of_band: false,
                send_attempt: 0,
                id_server: id_server.clone(),
                id_access_token: id_access_token.clone(),
                verified: false,
            });
        }
        let Some(email) = pending.email.as_mut() else {
            return;
        };
        if id_server.is_some() {
            email.id_server = id_server;
            email.id_access_token = id_access_token;
        }
    }

    fn registration_email_auth(pending: &PendingRegistration) -> Option<AuthData> {
        let email = pending.email.as_ref()?;
        let sid = email.sid.as_ref()?.clone();
        let client_secret = email.client_secret.as_ref()?.clone();
        let mut credentials = ThirdpartyIdCredentials::new(sid, client_secret);
        credentials.id_server.clone_from(&email.id_server);
        credentials
            .id_access_token
            .clone_from(&email.id_access_token);
        let identity: EmailIdentity = serde_json::from_value(serde_json::json!({
            "threepid_creds": credentials,
            "session": pending.session.clone(),
        }))
        .ok()?;
        Some(AuthData::EmailIdentity(identity))
    }

    pub(super) fn registration_password_auth(
        username: &str,
        password_value: &str,
        session: &str,
    ) -> AuthData {
        let mut password = Password::new(
            UserIdentifier::Matrix(MatrixUserIdentifier::new(username.to_owned())),
            password_value.to_owned(),
        );
        password.session = Some(session.to_owned());
        AuthData::Password(password)
    }

    pub(super) async fn register(
        self: &Arc<Self>,
        homeserver: String,
        username: String,
        password: String,
        registration_email: Option<String>,
        registration_token: Option<String>,
    ) -> Result<CommandOk, CommandErr> {
        let attempt_id = self
            .next_registration_attempt
            .fetch_add(1, Ordering::AcqRel)
            + 1;
        self.pending_registration.lock().await.take();
        let (account_id, store_id) = self.allocate_account().await?;
        let client = session::build_client(&store_id, &homeserver)
            .await
            .map_err(|error| self.failed("register: build_client", error))?;

        let registration_email = registration_email
            .map(|email| email.trim().to_owned())
            .filter(|email| !email.is_empty());
        let registration_token = registration_token
            .map(|token| token.trim().to_owned())
            .filter(|token| !token.is_empty());

        let auth = registration_token.as_ref().map(|token| {
            AuthData::RegistrationToken(
                matrix_sdk::ruma::api::client::uiaa::RegistrationToken::new(token.clone()),
            )
        });
        let request = registration_request(&username, &password, auth);

        match client.matrix_auth().register(request).await {
            Ok(_) => self
                .finish_registration(client, homeserver, account_id, store_id)
                .await
                .map(|result| CommandOk::Register { result }),
            Err(error) => {
                let Some(info) = error.as_uiaa_response().cloned() else {
                    return Err(self.registration_error(error));
                };
                let Some(session) = info.session.clone() else {
                    return Err(self.failed("register", "UIAA response had no session"));
                };
                let flows = registration_flows(
                    &info.flows,
                    registration_email.is_some(),
                    registration_token.is_some(),
                );
                if flows.is_empty() {
                    return Err(self.failed("register", "UIAA response had no flows"));
                }
                let has_email_stage = flows
                    .iter()
                    .any(|flow| flow.iter().any(|stage| stage == "m.login.email.identity"));
                let (id_server, id_access_token) = email_params(&info);
                *self.pending_registration.lock().await = Some(PendingRegistration {
                    account_id,
                    store_id,
                    attempt_id,
                    homeserver,
                    client,
                    username,
                    password,
                    registration_email,
                    registration_token,
                    session,
                    flows,
                    completed: info.completed.iter().map(ToString::to_string).collect(),
                    email: has_email_stage.then_some(PendingEmail {
                        address: None,
                        client_secret: None,
                        sid: None,
                        submit_url: None,
                        can_complete_out_of_band: false,
                        send_attempt: 0,
                        id_server,
                        id_access_token,
                        verified: false,
                    }),
                });
                self.continue_registration(false).await
            }
        }
    }

    fn registration_action(
        &self,
        pending: &mut PendingRegistration,
        stage: &str,
        acknowledge_fallback: &mut bool,
    ) -> Result<RegistrationAction, CommandErr> {
        let can_acknowledge_email = stage == "m.login.email.identity"
            && *acknowledge_fallback
            && pending.email.as_ref().is_some_and(|email| {
                email.submit_url.is_none() && email.sid.is_some() && email.can_complete_out_of_band
            });
        if can_acknowledge_email && let Some(email) = pending.email.as_mut() {
            email.verified = true;
        }

        let used_fallback_acknowledgement = *acknowledge_fallback
            && !matches!(
                stage,
                "m.login.dummy"
                    | "m.login.registration_token"
                    | "m.login.password"
                    | "m.login.email.identity"
            );
        let auth = match stage {
            "m.login.dummy" => {
                let mut dummy = matrix_sdk::ruma::api::client::uiaa::Dummy::new();
                dummy.session = Some(pending.session.clone());
                Some(AuthData::Dummy(dummy))
            }
            "m.login.registration_token" => pending.registration_token.as_ref().map(|token| {
                let mut registration_token =
                    matrix_sdk::ruma::api::client::uiaa::RegistrationToken::new(token.clone());
                registration_token.session = Some(pending.session.clone());
                AuthData::RegistrationToken(registration_token)
            }),
            "m.login.password" => Some(Self::registration_password_auth(
                &pending.username,
                &pending.password,
                &pending.session,
            )),
            "m.login.email.identity"
                if pending.email.as_ref().is_some_and(|email| email.verified) =>
            {
                Self::registration_email_auth(pending)
            }
            "m.login.email.identity" => None,
            _ if *acknowledge_fallback => {
                *acknowledge_fallback = false;
                Some(AuthData::fallback_acknowledgement(pending.session.clone()))
            }
            _ => None,
        };

        if let Some(auth) = auth {
            return Ok(RegistrationAction::Submit {
                auth,
                used_fallback_acknowledgement,
            });
        }

        let result = if stage == "m.login.email.identity" {
            self.registration_email_step(pending)?
        } else {
            self.registration_step(pending)?
        };
        Ok(RegistrationAction::View(result))
    }

    fn update_registration_from_error(
        &self,
        pending: &mut PendingRegistration,
        error: matrix_sdk::Error,
        submitted_stage: &str,
    ) -> Result<bool, CommandErr> {
        let Some(info) = error.as_uiaa_response().cloned() else {
            return Err(self.registration_error(error));
        };
        if let Some(session) = info.session.clone() {
            pending.session = session;
        }
        pending.completed = info.completed.iter().map(ToString::to_string).collect();
        if !info.flows.is_empty() {
            pending.flows = registration_flows(
                &info.flows,
                pending.registration_email.is_some(),
                pending.registration_token.is_some(),
            );
        }
        Self::update_registration_email_params(pending, &info);
        Ok(pending
            .completed
            .iter()
            .any(|completed| completed == submitted_stage))
    }

    pub(super) async fn continue_registration(
        self: &Arc<Self>,
        acknowledge_fallback: bool,
    ) -> Result<CommandOk, CommandErr> {
        let mut acknowledge_fallback = acknowledge_fallback;
        let mut pending = self
            .pending_registration
            .lock()
            .await
            .take()
            .ok_or(CommandErr::Unavailable)?;

        loop {
            let Some(stages) = pending.flows.first() else {
                self.restore_pending_registration(pending).await;
                return Err(self.failed("register", "missing selected UIAA flow"));
            };
            let Some(stage) = stages
                .iter()
                .find(|stage| {
                    !pending
                        .completed
                        .iter()
                        .any(|completed| completed == *stage)
                })
                .cloned()
            else {
                self.restore_pending_registration(pending).await;
                return Err(self.failed("register", "registration flow did not complete"));
            };

            let submitted_stage = stage.clone();
            let action =
                match self.registration_action(&mut pending, &stage, &mut acknowledge_fallback) {
                    Ok(action) => action,
                    Err(error) => {
                        self.restore_pending_registration(pending).await;
                        return Err(error);
                    }
                };
            let (auth, used_fallback_acknowledgement) = match action {
                RegistrationAction::Submit {
                    auth,
                    used_fallback_acknowledgement,
                } => (auth, used_fallback_acknowledgement),
                RegistrationAction::View(result) => {
                    self.restore_pending_registration(pending).await;
                    return Ok(CommandOk::ContinueRegistration { result });
                }
            };
            let request = registration_request(&pending.username, &pending.password, Some(auth));

            match pending.client.matrix_auth().register(request).await {
                Ok(_) => {
                    let client = pending.client.clone();
                    let homeserver = pending.homeserver.clone();
                    let account_id = pending.account_id.clone();
                    let store_id = pending.store_id.clone();
                    return match self
                        .finish_registration(client, homeserver, account_id, store_id)
                        .await
                    {
                        Ok(result) => Ok(CommandOk::ContinueRegistration { result }),
                        Err(error) => {
                            self.restore_pending_registration(pending).await;
                            Err(error)
                        }
                    };
                }
                Err(error) => {
                    let progressed = match self.update_registration_from_error(
                        &mut pending,
                        error,
                        &submitted_stage,
                    ) {
                        Ok(progressed) => progressed,
                        Err(error) => {
                            self.restore_pending_registration(pending).await;
                            return Err(error);
                        }
                    };
                    if !progressed {
                        if used_fallback_acknowledgement {
                            let result = match self.registration_step(&pending) {
                                Ok(result) => result,
                                Err(error) => {
                                    self.restore_pending_registration(pending).await;
                                    return Err(error);
                                }
                            };
                            self.restore_pending_registration(pending).await;
                            return Ok(CommandOk::ContinueRegistration { result });
                        }
                        self.restore_pending_registration(pending).await;
                        return Err(CommandErr::RegistrationStageFailed {
                            stage: submitted_stage,
                        });
                    }
                }
            }
        }
    }

    #[allow(deprecated)]
    pub(super) async fn request_registration_email(
        self: &Arc<Self>,
        address: String,
    ) -> Result<CommandOk, CommandErr> {
        let mut pending = self
            .pending_registration
            .lock()
            .await
            .take()
            .ok_or(CommandErr::Unavailable)?;
        let is_email_stage = pending
            .flows
            .first()
            .and_then(|stages| {
                stages.iter().find(|stage| {
                    !pending
                        .completed
                        .iter()
                        .any(|completed| completed == *stage)
                })
            })
            .is_some_and(|stage| stage == "m.login.email.identity");
        if !is_email_stage {
            self.restore_pending_registration(pending).await;
            return Err(CommandErr::Unavailable);
        }

        let address = address.trim().to_owned();
        if address.is_empty() || !address.contains('@') {
            self.restore_pending_registration(pending).await;
            return Err(CommandErr::InvalidEmail);
        }

        let Some(email) = pending.email.as_mut() else {
            self.restore_pending_registration(pending).await;
            return Err(self.failed("register email", "email UIAA state was not initialized"));
        };
        let client_secret = email
            .client_secret
            .get_or_insert_with(ClientSecret::new)
            .clone();
        email.send_attempt = email.send_attempt.saturating_add(1).max(1);
        let send_attempt = UInt::from(email.send_attempt);
        let identity_server = email
            .id_server
            .clone()
            .zip(email.id_access_token.clone())
            .map(|(id_server, id_access_token)| {
                IdentityServerInfo::new(id_server, id_access_token)
            });
        let mut request =
            RegistrationEmailRequest::new(client_secret, address.clone(), send_attempt);
        request.identity_server_info = identity_server;

        let response = match pending.client.send(request).await {
            Ok(response) => response,
            Err(error) => {
                self.restore_pending_registration(pending).await;
                return Err(self.registration_error(error.into()));
            }
        };
        {
            let Some(email) = pending.email.as_mut() else {
                self.restore_pending_registration(pending).await;
                return Err(self.failed("register email", "email UIAA state was lost"));
            };
            email.address = Some(address);
            email.sid = Some(response.sid);
        }
        let can_complete_out_of_band = response.submit_url.is_none()
            && pending
                .client
                .supported_versions()
                .await
                .is_ok_and(|versions| can_complete_email_out_of_band(&versions));
        let Some(email) = pending.email.as_mut() else {
            self.restore_pending_registration(pending).await;
            return Err(self.failed("register email", "email UIAA state was lost"));
        };
        email.submit_url = response.submit_url;
        email.can_complete_out_of_band = can_complete_out_of_band;
        email.verified = false;
        let result = match self.registration_email_step(&pending) {
            Ok(result) => result,
            Err(error) => {
                self.restore_pending_registration(pending).await;
                return Err(error);
            }
        };
        self.restore_pending_registration(pending).await;
        Ok(CommandOk::RequestRegistrationEmail { result })
    }

    pub(super) async fn submit_registration_email(
        self: &Arc<Self>,
        token: String,
    ) -> Result<CommandOk, CommandErr> {
        let mut pending = self
            .pending_registration
            .lock()
            .await
            .take()
            .ok_or(CommandErr::Unavailable)?;
        let (submit_url, sid, client_secret) = {
            let Some(email) = pending.email.as_ref() else {
                self.restore_pending_registration(pending).await;
                return Err(self.failed("register email", "email UIAA state was not initialized"));
            };
            let Some(submit_url) = email.submit_url.clone() else {
                self.restore_pending_registration(pending).await;
                return Err(CommandErr::Unavailable);
            };
            let Some(sid) = email.sid.as_ref().map(ToString::to_string) else {
                self.restore_pending_registration(pending).await;
                return Err(CommandErr::Unavailable);
            };
            let Some(client_secret) = email.client_secret.as_ref().map(ToString::to_string) else {
                self.restore_pending_registration(pending).await;
                return Err(CommandErr::Unavailable);
            };
            (submit_url, sid, client_secret)
        };
        let Some(submit_url) = trusted_submit_url(&pending, &submit_url) else {
            self.restore_pending_registration(pending).await;
            return Err(CommandErr::EmailVerificationFailed);
        };
        if token.is_empty() || token.chars().count() > 255 {
            self.restore_pending_registration(pending).await;
            return Err(CommandErr::EmailVerificationFailed);
        }

        let Ok(payload) = serde_json::to_vec(&serde_json::json!({
            "sid": sid,
            "client_secret": client_secret,
            "token": token,
        })) else {
            self.restore_pending_registration(pending).await;
            return Err(CommandErr::EmailVerificationFailed);
        };
        let builder = matrix_sdk::reqwest::Client::builder();
        #[cfg(not(target_family = "wasm"))]
        let builder = builder
            .redirect(matrix_sdk::reqwest::redirect::Policy::none())
            .timeout(std::time::Duration::from_secs(15));
        let Ok(client) = builder.build() else {
            self.restore_pending_registration(pending).await;
            return Err(CommandErr::EmailVerificationFailed);
        };
        let Ok(response) = client
            .post(submit_url)
            .header("content-type", "application/json")
            .body(payload)
            .send()
            .await
        else {
            self.restore_pending_registration(pending).await;
            return Err(CommandErr::Unavailable);
        };
        let response_success = response.status().is_success();
        let Ok(body) = response.bytes().await else {
            self.restore_pending_registration(pending).await;
            return Err(CommandErr::EmailVerificationFailed);
        };
        if !response_success {
            let error = map_email_submit_error(&body);
            self.restore_pending_registration(pending).await;
            return Err(error);
        }
        let Ok(verification) = serde_json::from_slice::<EmailSubmitResponse>(&body) else {
            self.restore_pending_registration(pending).await;
            return Err(CommandErr::EmailVerificationFailed);
        };
        if !verification.success {
            self.restore_pending_registration(pending).await;
            return Err(CommandErr::EmailVerificationFailed);
        }
        if let Some(email) = pending.email.as_mut() {
            email.verified = true;
        }
        let result = match self.registration_email_step(&pending) {
            Ok(result) => result,
            Err(error) => {
                self.restore_pending_registration(pending).await;
                return Err(error);
            }
        };
        self.restore_pending_registration(pending).await;
        Ok(CommandOk::SubmitRegistrationEmail { result })
    }

    pub(super) async fn discover_registration_flows(
        self: &Arc<Self>,
        homeserver: String,
    ) -> Result<CommandOk, CommandErr> {
        let client = session::discovery_client(&homeserver)
            .await
            .map_err(|error| self.discovery_error(error))?;

        let error = client
            .matrix_auth()
            .register(RegistrationRequest::new())
            .await
            .err()
            .ok_or_else(|| {
                self.failed(
                    "registration_flows",
                    "homeserver registered an account without UIAA or account fields",
                )
            })?;
        let Some(info) = error.as_uiaa_response() else {
            return Err(self.registration_error(error));
        };
        if info.flows.is_empty() {
            return Err(self.failed(
                "registration_flows",
                "homeserver returned no registration flows",
            ));
        }

        Ok(CommandOk::RegistrationFlows {
            flows: protocol::RegistrationFlowsView {
                uiaa: !info.flows.is_empty(),
                email: registration_requirement(&info.flows, &AuthType::EmailIdentity),
                registration_token: registration_requirement(
                    &info.flows,
                    &AuthType::RegistrationToken,
                ),
            },
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    #[test]
    fn registration_flows_choose_shortest_flow_stably() {
        let flows = vec![
            AuthFlow::new(vec![AuthType::Dummy, AuthType::Terms]),
            AuthFlow::new(vec![AuthType::Password]),
            AuthFlow::new(vec![AuthType::Dummy]),
            AuthFlow::new(vec![AuthType::Sso]),
        ];

        assert_eq!(
            registration_flows(&flows, false, false),
            vec![
                vec!["m.login.password"],
                vec!["m.login.dummy"],
                vec!["m.login.sso"],
                vec!["m.login.dummy", "m.login.terms"],
            ]
        );
    }

    #[test]
    fn registration_flows_prefer_the_fields_the_user_supplied() {
        let flows = vec![
            AuthFlow::new(vec![AuthType::RegistrationToken]),
            AuthFlow::new(vec![AuthType::EmailIdentity]),
            AuthFlow::new(vec![AuthType::Dummy]),
        ];

        assert_eq!(
            registration_flows(&flows, true, false)[0],
            vec!["m.login.email.identity"]
        );
        assert_eq!(
            registration_flows(&flows, false, true)[0],
            vec!["m.login.registration_token"]
        );
        assert_eq!(
            registration_flows(&flows, false, false)[0],
            vec!["m.login.dummy"]
        );
    }

    #[test]
    fn registration_requirements_distinguish_optional_and_required_stages() {
        let flows = vec![
            AuthFlow::new(vec![AuthType::RegistrationToken, AuthType::EmailIdentity]),
            AuthFlow::new(vec![AuthType::EmailIdentity, AuthType::Dummy]),
            AuthFlow::new(vec![AuthType::Sso]),
        ];

        assert_eq!(
            registration_requirement(&flows, &AuthType::RegistrationToken),
            protocol::RegistrationRequirementView::Optional
        );
        assert_eq!(
            registration_requirement(&flows, &AuthType::EmailIdentity),
            protocol::RegistrationRequirementView::Optional
        );
        assert_eq!(
            registration_requirement(&flows, &AuthType::Terms),
            protocol::RegistrationRequirementView::Unavailable
        );
    }

    #[test]
    fn registration_request_contains_account_and_device_fields() {
        let request = registration_request("alice", "correct horse", None);

        assert_eq!(request.username.as_deref(), Some("alice"));
        assert_eq!(request.password.as_deref(), Some("correct horse"));
        assert_eq!(
            request.initial_device_display_name.as_deref(),
            Some("Sable")
        );
        assert!(request.refresh_token);
        assert!(request.auth.is_none());
    }

    #[test]
    fn registration_request_serializes_token_and_fallback_auth() -> Result<(), serde_json::Error> {
        let mut token =
            matrix_sdk::ruma::api::client::uiaa::RegistrationToken::new("invite-123".to_owned());
        token.session = Some("session-1".to_owned());
        let request = registration_request(
            "alice",
            "correct horse",
            Some(AuthData::RegistrationToken(token)),
        );
        let value = serde_json::to_value(request.auth)?;
        assert_eq!(value["type"], "m.login.registration_token");
        assert_eq!(value["token"], "invite-123");
        assert_eq!(value["session"], "session-1");

        let fallback =
            serde_json::to_value(AuthData::fallback_acknowledgement("session-1".to_owned()))?;
        assert_eq!(fallback["session"], "session-1");
        assert!(fallback.get("type").is_none());
        Ok(())
    }

    #[test]
    fn registration_password_auth_contains_session_and_localpart() -> Result<(), serde_json::Error>
    {
        let value = serde_json::to_value(Core::registration_password_auth(
            "alice",
            "correct horse",
            "session-1",
        ))?;
        assert_eq!(value["type"], "m.login.password");
        assert_eq!(value["identifier"]["type"], "m.id.user");
        assert_eq!(value["identifier"]["user"], "alice");
        assert_eq!(value["password"], "correct horse");
        assert_eq!(value["session"], "session-1");
        Ok(())
    }

    #[test]
    fn out_of_band_email_completion_requires_r0_5_or_newer() {
        let unknown = matrix_sdk::ruma::api::SupportedVersions::from_parts(
            &["r0.4.0".to_owned()],
            &BTreeMap::new(),
        );
        let legacy = matrix_sdk::ruma::api::SupportedVersions::from_parts(
            &["r0.5.0".to_owned()],
            &BTreeMap::new(),
        );
        let stable = matrix_sdk::ruma::api::SupportedVersions::from_parts(
            &["v1.1".to_owned()],
            &BTreeMap::new(),
        );

        assert!(!can_complete_email_out_of_band(&unknown));
        assert!(can_complete_email_out_of_band(&legacy));
        assert!(can_complete_email_out_of_band(&stable));
    }

    #[test]
    fn email_submit_errors_are_mapped_without_exposing_server_text() {
        assert!(matches!(
            map_email_submit_error(br#"{"errcode":"M_THREEPID_IN_USE"}"#),
            CommandErr::InvalidEmail
        ));
        assert!(matches!(
            map_email_submit_error(br#"{"errcode":"M_THREEPID_AUTH_FAILED"}"#),
            CommandErr::EmailVerificationFailed
        ));
        assert!(matches!(
            map_email_submit_error(b"not json"),
            CommandErr::EmailVerificationFailed
        ));
    }
}
