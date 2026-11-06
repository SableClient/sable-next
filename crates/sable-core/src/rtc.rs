use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::Ordering;

use matrix_sdk::Client;
use matrix_sdk::deserialized_responses::EncryptionInfo;
use matrix_sdk::ruma::{OwnedDeviceId, OwnedUserId};
use sable_frostbite::{
    CandidateEvent, CandidateEventContent, NegotiateEvent, NegotiateEventContent, SendError,
};

use crate::Core;
use crate::probed_state::now_ms;
use crate::protocol::{CoreEvent, RpcError, RtcSignal};
use crate::sealed_account_data::verified_own_sender;

const SESSION_MS: u64 = 120_000;
const MAX_CANDIDATES: usize = 64;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum RtcPurpose {
    SearchSharing,
}

struct Session {
    device: OwnedDeviceId,
    sender: bool,
    purpose: RtcPurpose,
    touched: u64,
    candidates: usize,
}

#[derive(Default)]
pub(crate) struct RtcSessions(parking_lot::Mutex<HashMap<String, Session>>);

impl RtcSessions {
    pub(crate) fn clear(&self) {
        self.0.lock().clear();
    }
}

struct Incoming {
    sender: OwnedUserId,
    session: String,
    timestamp: Option<u64>,
    signal: RtcSignal,
}

impl Core {
    pub(crate) fn open_rtc(
        &self,
        purpose: RtcPurpose,
        session: String,
        device: OwnedDeviceId,
        sender: bool,
    ) -> bool {
        let mut sessions = self.rtc.0.lock();
        if sessions.contains_key(&session) {
            return false;
        }
        sessions.insert(
            session,
            Session {
                device,
                sender,
                purpose,
                touched: now_ms(),
                candidates: 0,
            },
        );
        true
    }

    pub(crate) fn close_rtc(&self, session: &str) {
        self.rtc.0.lock().remove(session);
    }

    pub(crate) fn close_rtc_purpose(&self, purpose: RtcPurpose) {
        let closed: Vec<String> = {
            let mut sessions = self.rtc.0.lock();
            let closed = sessions
                .iter()
                .filter(|(_, session)| session.purpose == purpose)
                .map(|(id, _)| id.clone())
                .collect();
            sessions.retain(|_, session| session.purpose != purpose);
            closed
        };
        for session_id in closed {
            self.emit(CoreEvent::Rtc {
                session_id,
                sender: false,
                signal: RtcSignal::Close,
            });
        }
    }

    pub(crate) fn rtc_device(&self, session: &str) -> Option<(OwnedDeviceId, bool)> {
        let mut sessions = self.rtc.0.lock();
        let entry = sessions.get_mut(session)?;
        if now_ms().saturating_sub(entry.touched) > SESSION_MS {
            sessions.remove(session);
            return None;
        }
        entry.touched = now_ms();
        Some((entry.device.clone(), entry.sender))
    }

    pub(crate) async fn signal_rtc(
        &self,
        session: &str,
        signal: RtcSignal,
    ) -> Result<(), RpcError> {
        let client = self.client().await?;
        let (device, sender) = self.rtc_device(session).ok_or(RpcError::Unavailable)?;
        let sent = match signal {
            RtcSignal::Negotiate { description } if description.valid_from(sender) => {
                sable_frostbite::send(
                    &client,
                    &device,
                    &NegotiateEventContent {
                        session: session.to_owned(),
                        timestamp: now_ms(),
                        description,
                    },
                )
                .await
            }
            RtcSignal::Candidate { candidate } if candidate.valid() => {
                sable_frostbite::send(
                    &client,
                    &device,
                    &CandidateEventContent {
                        session: session.to_owned(),
                        candidate,
                    },
                )
                .await
            }
            _ => return Err(RpcError::Unavailable),
        };
        sent.map_err(|error| match error {
            SendError::NotLoggedIn => RpcError::NotLoggedIn,
            SendError::UnverifiedDevice | SendError::Failed => RpcError::Unavailable,
        })
    }

    pub(crate) fn watch_rtc(self: &Arc<Self>, client: &Client, generation: u64) {
        self.watch_rtc_event(client, generation, |event: NegotiateEvent| {
            let content = event.content;
            Incoming {
                sender: event.sender,
                session: content.session,
                timestamp: Some(content.timestamp),
                signal: RtcSignal::Negotiate {
                    description: content.description,
                },
            }
        });
        self.watch_rtc_event(client, generation, |event: CandidateEvent| {
            let content = event.content;
            Incoming {
                sender: event.sender,
                session: content.session,
                timestamp: None,
                signal: RtcSignal::Candidate {
                    candidate: content.candidate,
                },
            }
        });
    }

    fn watch_rtc_event<E>(
        self: &Arc<Self>,
        client: &Client,
        generation: u64,
        incoming: fn(E) -> Incoming,
    ) where
        E: matrix_sdk::event_handler::SyncEvent + serde::de::DeserializeOwned + Send + 'static,
    {
        let weak = Arc::downgrade(self);
        let handle = client.add_event_handler(
            move |event: E, encryption: Option<EncryptionInfo>, client: Client| {
                let weak = weak.clone();
                let incoming = incoming(event);
                async move {
                    if let Some(core) = weak.upgrade() {
                        core.receive_rtc(&client, generation, encryption, incoming)
                            .await;
                    }
                }
            },
        );
        self.track_session_handler(client, handle);
    }

    async fn receive_rtc(
        &self,
        client: &Client,
        generation: u64,
        encryption: Option<EncryptionInfo>,
        Incoming {
            sender,
            session,
            timestamp,
            signal,
        }: Incoming,
    ) {
        if self.session_generation.load(Ordering::SeqCst) != generation
            || timestamp.is_some_and(|ts| now_ms().abs_diff(ts) > SESSION_MS)
            || !self.rtc.0.lock().contains_key(&session)
        {
            return;
        }
        let Some(device) = verified_own_sender(client, &sender, encryption).await else {
            return;
        };
        let local_sender = {
            let mut sessions = self.rtc.0.lock();
            let Some(entry) = sessions.get_mut(&session) else {
                return;
            };
            if entry.device != device.device_id()
                || now_ms().saturating_sub(entry.touched) > SESSION_MS
            {
                return;
            }
            let accepted = match &signal {
                RtcSignal::Negotiate { description } => description.valid_from(!entry.sender),
                RtcSignal::Candidate { candidate } => {
                    candidate.valid() && entry.candidates < MAX_CANDIDATES
                }
                RtcSignal::Open | RtcSignal::Close => false,
            };
            if !accepted {
                return;
            }
            if matches!(signal, RtcSignal::Candidate { .. }) {
                entry.candidates += 1;
            }
            entry.touched = now_ms();
            entry.sender
        };
        self.emit_if_current(
            generation,
            CoreEvent::Rtc {
                session_id: session,
                sender: local_sender,
                signal,
            },
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn sessions_close_by_purpose_and_expire() {
        let (core, mut events) =
            Core::new("rtc", Box::new(crate::store::MemorySessionStore::default()));
        assert!(core.open_rtc(RtcPurpose::SearchSharing, "a".into(), "DEV".into(), true));
        assert!(!core.open_rtc(RtcPurpose::SearchSharing, "a".into(), "DEV".into(), false));
        assert_eq!(core.rtc_device("a"), Some(("DEV".into(), true)));
        core.close_rtc_purpose(RtcPurpose::SearchSharing);
        assert_eq!(core.rtc_device("a"), None);
        assert!(matches!(
            events.recv().await,
            Some(CoreEvent::Rtc {
                signal: RtcSignal::Close,
                ..
            })
        ));
        core.rtc.0.lock().insert(
            "old".into(),
            Session {
                device: "DEV".into(),
                sender: true,
                purpose: RtcPurpose::SearchSharing,
                touched: now_ms() - SESSION_MS - 1,
                candidates: 0,
            },
        );
        assert_eq!(core.rtc_device("old"), None);
    }
}
