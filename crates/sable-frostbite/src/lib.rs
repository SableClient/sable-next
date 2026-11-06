use matrix_sdk::Client;
use matrix_sdk::encryption::identities::Device;
use matrix_sdk::ruma::DeviceId;
use matrix_sdk::ruma::events::macros::EventContent;
use matrix_sdk::ruma::events::{AnyToDeviceEventContent, StaticEventContent};
use matrix_sdk::ruma::serde::Raw;
use matrix_sdk_base::crypto::CollectStrategy;
use serde::{Deserialize, Serialize};

pub const MAX_SDP: usize = 48 * 1024;
pub const MAX_CANDIDATE: usize = 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
#[serde(rename_all = "snake_case")]
pub enum DescriptionType {
    Offer,
    Answer,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
pub struct Description {
    #[serde(rename = "type")]
    pub kind: DescriptionType,
    pub sdp: String,
}

impl Description {
    #[must_use]
    pub fn valid_from(&self, sender: bool) -> bool {
        let expected = if sender {
            DescriptionType::Offer
        } else {
            DescriptionType::Answer
        };
        self.kind == expected && !self.sdp.is_empty() && self.sdp.len() <= MAX_SDP
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct IceCandidate {
    pub candidate: String,
    pub sdp_mid: Option<String>,
    pub sdp_m_line_index: Option<u16>,
}

impl IceCandidate {
    #[must_use]
    pub fn valid(&self) -> bool {
        self.candidate.len() + self.sdp_mid.as_ref().map_or(0, String::len) <= MAX_CANDIDATE
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, EventContent)]
#[ruma_event(type = "computer.gingershaped.frostbite.negotiate", kind = ToDevice)]
pub struct NegotiateEventContent {
    pub session: String,
    pub timestamp: u64,
    pub description: Description,
}

#[derive(Clone, Debug, Deserialize, Serialize, EventContent)]
#[ruma_event(type = "computer.gingershaped.frostbite.candidate", kind = ToDevice)]
pub struct CandidateEventContent {
    pub session: String,
    pub candidate: IceCandidate,
}

#[derive(Debug)]
pub enum SendError {
    NotLoggedIn,
    UnverifiedDevice,
    Failed,
}

/// # Errors
///
/// When the device is not verified or did not receive the event.
pub async fn send<C>(client: &Client, device_id: &DeviceId, content: &C) -> Result<(), SendError>
where
    C: StaticEventContent + Serialize,
{
    let user = client.user_id().ok_or(SendError::NotLoggedIn)?;
    let device = client
        .encryption()
        .get_device(user, device_id)
        .await
        .map_err(|_| SendError::Failed)?
        .filter(Device::is_verified)
        .ok_or(SendError::UnverifiedDevice)?;
    let raw: Raw<AnyToDeviceEventContent> = Raw::new(content)
        .map_err(|_| SendError::Failed)?
        .cast_unchecked();
    let failures = client
        .encryption()
        .encrypt_and_send_raw_to_device(vec![&device], C::TYPE, raw, CollectStrategy::AllDevices)
        .await
        .map_err(|_| SendError::Failed)?;
    if failures.is_empty() {
        Ok(())
    } else {
        Err(SendError::Failed)
    }
}

#[cfg(test)]
mod tests;
