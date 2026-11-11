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
use crate::now_ms;
use crate::protocol::{CoreEvent, RpcCode, RpcError, RtcSignal};
use crate::sealed_account_data::verified_own_sender;

const SESSION_MS: u64 = 120_000;
const MAX_CANDIDATES: usize = 64;
const MAX_FRAME: usize = 16 * 1024;
const MAX_MESSAGE: usize = 6 * 1024 * 1024;
const LENGTH_PREFIX: usize = 4;

pub(crate) use crate::protocol::RtcPurpose;

struct Session {
    device: OwnedDeviceId,
    sender: bool,
    purpose: RtcPurpose,
    touched: u64,
    candidates: usize,
    channel: Channel,
}

#[derive(Debug)]
enum Inbound {
    Opened,
    Message(Vec<u8>),
}

/// Data channel frames of a session. Each message is a big-endian `u32`
/// length followed by that many bytes, split into frames of up to 16 KiB.
/// The app passes an empty frame when the channel opens.
#[derive(Default)]
struct Channel {
    opened: bool,
    inbox: Vec<u8>,
}

impl Channel {
    fn push(&mut self, frame: &[u8]) -> Result<Option<Inbound>, RpcError> {
        if frame.is_empty() {
            if self.opened {
                return Err(RpcCode::Unavailable.into());
            }
            self.opened = true;
            return Ok(Some(Inbound::Opened));
        }
        if !self.opened || frame.len() > MAX_FRAME {
            return Err(RpcCode::Unavailable.into());
        }
        self.inbox.extend_from_slice(frame);
        let Some(length) = self.inbox.first_chunk::<LENGTH_PREFIX>() else {
            return Ok(None);
        };
        let length = u32::from_be_bytes(*length) as usize;
        if length > MAX_MESSAGE {
            return Err(RpcCode::Unavailable.into());
        }
        // A peer sends its next message only after the answer to the last one.
        match self.inbox.len().cmp(&(LENGTH_PREFIX + length)) {
            std::cmp::Ordering::Less => Ok(None),
            std::cmp::Ordering::Equal => {
                let mut message = std::mem::take(&mut self.inbox);
                message.drain(..LENGTH_PREFIX);
                Ok(Some(Inbound::Message(message)))
            }
            std::cmp::Ordering::Greater => Err(RpcCode::Unavailable.into()),
        }
    }
}

fn frame(message: &[u8]) -> Result<Vec<u8>, RpcError> {
    let length = u32::try_from(message.len())
        .ok()
        .filter(|_| message.len() <= MAX_MESSAGE)
        .ok_or(RpcCode::Unavailable)?;
    let mut framed = Vec::with_capacity(LENGTH_PREFIX + message.len());
    framed.extend_from_slice(&length.to_be_bytes());
    framed.extend_from_slice(message);
    Ok(framed)
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
                channel: Channel::default(),
            },
        );
        true
    }

    /// Takes one data channel frame of a session and returns the bytes to
    /// send back, empty when there is nothing to send yet.
    ///
    /// # Errors
    ///
    /// `Unavailable` for an unknown session or a frame that breaks the
    /// framing, otherwise the session's error. The app closes the channel.
    pub async fn rtc_data(
        self: &Arc<Self>,
        session_id: &str,
        frame_bytes: &[u8],
    ) -> Result<Vec<u8>, RpcError> {
        if self.shut_down.load(Ordering::SeqCst) {
            return Err(RpcCode::Unavailable.into());
        }
        let (purpose, inbound) = {
            let mut sessions = self.rtc.0.lock();
            let entry = sessions.get_mut(session_id).ok_or(RpcCode::Unavailable)?;
            if now_ms().saturating_sub(entry.touched) > SESSION_MS {
                sessions.remove(session_id);
                return Err(RpcCode::Unavailable.into());
            }
            entry.touched = now_ms();
            (entry.purpose, entry.channel.push(frame_bytes)?)
        };
        let Some(inbound) = inbound else {
            return Ok(Vec::new());
        };
        let message = match inbound {
            Inbound::Opened => None,
            Inbound::Message(message) => Some(message),
        };
        let reply = match purpose {
            RtcPurpose::SearchSharing => self.exchange_search_peer(session_id, message).await?,
        };
        reply.map_or_else(|| Ok(Vec::new()), |reply| frame(&reply))
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
                purpose,
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
        let (device, sender) = self.rtc_device(session).ok_or(RpcCode::Unavailable)?;
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
            _ => return Err(RpcCode::Unavailable.into()),
        };
        sent.map_err(|error| match error {
            SendError::NotLoggedIn => RpcCode::NotLoggedIn.into(),
            SendError::UnverifiedDevice | SendError::Failed => RpcCode::Unavailable.into(),
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
                        let deferred = core.clone();
                        core.defer_to_device(Box::pin(async move {
                            deferred
                                .receive_rtc(&client, generation, encryption, incoming)
                                .await;
                        }));
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
        if !self.is_current(generation)
            || timestamp.is_some_and(|ts| now_ms().abs_diff(ts) > SESSION_MS)
            || !self.rtc.0.lock().contains_key(&session)
        {
            return;
        }
        let Some(device) = verified_own_sender(client, &sender, encryption).await else {
            return;
        };
        let (purpose, local_sender) = {
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
            (entry.purpose, entry.sender)
        };
        self.emit_if_current(
            generation,
            CoreEvent::Rtc {
                session_id: session,
                purpose,
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
                channel: Channel::default(),
            },
        );
        assert_eq!(core.rtc_device("old"), None);
    }

    #[test]
    fn frames_are_reassembled_into_messages() {
        let mut channel = Channel::default();
        channel.push(&[1]).unwrap_err();
        assert!(matches!(channel.push(&[]), Ok(Some(Inbound::Opened))));
        channel.push(&[]).unwrap_err();

        let framed = frame(&[7; 20]).unwrap();
        assert_eq!(framed[..LENGTH_PREFIX], [0, 0, 0, 20]);
        assert!(matches!(channel.push(&framed[..3]), Ok(None)));
        assert!(matches!(channel.push(&framed[3..10]), Ok(None)));
        let Ok(Some(Inbound::Message(message))) = channel.push(&framed[10..]) else {
            panic!("expected a message");
        };
        assert_eq!(message, [7; 20]);

        let mut early = frame(&[1]).unwrap();
        early.push(0);
        channel.push(&early).unwrap_err();
    }

    #[test]
    fn oversized_frames_and_messages_are_refused() {
        let mut channel = Channel::default();
        channel.push(&[]).unwrap();
        channel.push(&vec![0; MAX_FRAME + 1]).unwrap_err();
        let length = u32::try_from(MAX_MESSAGE + 1).unwrap().to_be_bytes();
        let mut channel = Channel::default();
        channel.push(&[]).unwrap();
        channel.push(&length).unwrap_err();
        frame(&vec![0; MAX_MESSAGE + 1]).unwrap_err();
    }
}
