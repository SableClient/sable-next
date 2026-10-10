use std::sync::Arc;

use aes::Aes256;
use aes::cipher::{KeyIvInit, StreamCipher};
use base64::Engine as _;
use base64::alphabet::STANDARD;
use base64::engine::{DecodePaddingMode, GeneralPurpose, GeneralPurposeConfig};
use hkdf::Hkdf;
use hmac::{Hmac, KeyInit as _, Mac as _};
use matrix_sdk::deserialized_responses::EncryptionInfo;
use matrix_sdk::encryption::VerificationState;
use matrix_sdk::encryption::identities::Device;
use matrix_sdk::encryption::secret_storage::{SecretStorageError, SecretStore};
use matrix_sdk::executor::{JoinHandleExt, spawn};
use matrix_sdk::ruma::UserId;
use matrix_sdk::ruma::events::StaticEventContent;
use matrix_sdk::ruma::events::macros::EventContent;
use matrix_sdk::ruma::serde::Raw;
use matrix_sdk_base::crypto::CollectStrategy;
use serde::{Deserialize, Serialize};
use sha2::Sha256;

use crate::Core;
use crate::ResultExt;
use crate::protocol::{CommandErr, CoreEvent, SealStateView, SealedAccountDataView};

pub(crate) const ADK_SECRET: &str = "dev.zirco.msc4483.account_data.key";
const CACHE_KEY: &[u8] = b"sable.msc4483.account_data_key";
const KEY_SIZE: usize = 32;
const IV_SIZE: usize = 16;

const BASE64: GeneralPurpose = GeneralPurpose::new(
    &STANDARD,
    GeneralPurposeConfig::new()
        .with_encode_padding(false)
        .with_decode_padding_mode(DecodePaddingMode::Indifferent),
);

type Aes256Ctr = ctr::Ctr128BE<Aes256>;

#[derive(Serialize, Deserialize)]
struct Sealed {
    iv: String,
    ciphertext: String,
    mac: String,
}

#[derive(Serialize, Deserialize)]
struct Envelope {
    encrypted: Sealed,
}

pub(crate) struct AccountDataKey([u8; KEY_SIZE]);

impl AccountDataKey {
    pub(crate) fn generate() -> Result<Self, getrandom::Error> {
        let mut key = [0u8; KEY_SIZE];
        getrandom::fill(&mut key)?;
        Ok(Self(key))
    }

    fn from_base64(encoded: &str) -> Option<Self> {
        BASE64
            .decode(encoded.trim())
            .ok()?
            .try_into()
            .ok()
            .map(Self)
    }

    fn to_base64(&self) -> String {
        BASE64.encode(self.0)
    }

    fn expand(&self, event_type: &str) -> Option<([u8; KEY_SIZE], Hmac<Sha256>)> {
        let mut expanded = [0u8; KEY_SIZE * 2];
        Hkdf::<Sha256>::new(Some(&[0u8; KEY_SIZE]), &self.0)
            .expand(event_type.as_bytes(), &mut expanded)
            .ok()?;
        let (aes, mac) = expanded.split_at(KEY_SIZE);
        Some((aes.try_into().ok()?, Hmac::new_from_slice(mac).ok()?))
    }

    pub(crate) fn seal(
        &self,
        event_type: &str,
        content: &serde_json::Value,
    ) -> Result<serde_json::Value, SealError> {
        let (aes, mut mac) = self.expand(event_type).ok_or(SealError::Cipher)?;
        let mut iv = [0u8; IV_SIZE];
        getrandom::fill(&mut iv).map_err(SealError::Random)?;
        iv[8] &= 0x7f;

        let mut ciphertext = content.to_string().into_bytes();
        Aes256Ctr::new(&aes.into(), &iv.into()).apply_keystream(&mut ciphertext);
        mac.update(&ciphertext);

        serde_json::to_value(Envelope {
            encrypted: Sealed {
                iv: BASE64.encode(iv),
                ciphertext: BASE64.encode(ciphertext),
                mac: BASE64.encode(mac.finalize().into_bytes()),
            },
        })
        .map_err(|_| SealError::Cipher)
    }

    pub(crate) fn open(
        &self,
        event_type: &str,
        content: &serde_json::Value,
    ) -> Option<serde_json::Value> {
        let envelope = Envelope::deserialize(content).ok()?;
        let iv: [u8; IV_SIZE] = BASE64.decode(envelope.encrypted.iv).ok()?.try_into().ok()?;
        let mut plaintext = BASE64.decode(envelope.encrypted.ciphertext).ok()?;
        let tag = BASE64.decode(envelope.encrypted.mac).ok()?;

        let (aes, mut mac) = self.expand(event_type)?;
        mac.update(&plaintext);
        mac.verify_slice(&tag).ok()?;

        Aes256Ctr::new(&aes.into(), &iv.into()).apply_keystream(&mut plaintext);
        serde_json::from_slice(&plaintext).ok()
    }
}

#[derive(Debug)]
pub(crate) enum SealError {
    Random(getrandom::Error),
    Cipher,
}

impl std::fmt::Display for SealError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Random(error) => error.fmt(f),
            Self::Cipher => f.write_str("the account data could not be sealed"),
        }
    }
}

pub(crate) fn is_sealed(content: &serde_json::Value) -> bool {
    content
        .get("encrypted")
        .and_then(|encrypted| encrypted.get("ciphertext"))
        .is_some_and(serde_json::Value::is_string)
}

pub(crate) fn sealable(event_type: &str) -> bool {
    !event_type.starts_with("m.") && event_type.contains('.')
}

pub(crate) async fn cached_key(client: &matrix_sdk::Client) -> Option<AccountDataKey> {
    match client.state_store().get_custom_value(CACHE_KEY).await {
        Ok(Some(bytes)) => bytes.try_into().ok().map(AccountDataKey),
        Ok(None) => None,
        Err(error) => {
            tracing::warn!("reading the account data key failed: {error}");
            None
        }
    }
}

pub(crate) async fn cache_key(client: &matrix_sdk::Client, key: &AccountDataKey) {
    if let Err(error) = client
        .state_store()
        .set_custom_value_no_read(CACHE_KEY, key.0.to_vec())
        .await
    {
        tracing::warn!("storing the account data key failed: {error}");
    }
}

#[derive(Debug)]
pub(crate) enum AdoptError {
    SecretStorage(SecretStorageError),
    Random(getrandom::Error),
}

impl std::fmt::Display for AdoptError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::SecretStorage(error) => error.fmt(f),
            Self::Random(error) => error.fmt(f),
        }
    }
}

pub(crate) async fn adopt_key(
    client: &matrix_sdk::Client,
    store: &SecretStore,
) -> Result<(), AdoptError> {
    let remote = store
        .get_secret(ADK_SECRET)
        .await
        .map_err(AdoptError::SecretStorage)?
        .and_then(|secret| AccountDataKey::from_base64(&secret));
    if let Some(key) = remote {
        cache_key(client, &key).await;
        return Ok(());
    }

    let key = match cached_key(client).await {
        Some(key) => key,
        None => AccountDataKey::generate().map_err(AdoptError::Random)?,
    };
    store
        .put_secret(ADK_SECRET, &key.to_base64())
        .await
        .map_err(AdoptError::SecretStorage)?;
    cache_key(client, &key).await;
    Ok(())
}

impl Core {
    pub(crate) async fn sealed_account_data(
        &self,
        event_type: &str,
    ) -> Result<SealedAccountDataView, CommandErr> {
        if !sealable(event_type) {
            return Err(CommandErr::Unsupported);
        }
        let client = self.client().await?;
        let key = cached_key(&client).await;
        let content = self
            .global_account_data(event_type.into(), "sealed_account_data")
            .await?
            .and_then(|raw| raw.deserialize_as::<serde_json::Value>().ok());

        let (content, state) = match content {
            Some(content) if is_sealed(&content) => key
                .as_ref()
                .and_then(|key| key.open(event_type, &content))
                .map_or((None, SealStateView::Locked), |opened| {
                    (Some(opened), SealStateView::Sealed)
                }),
            content => (content, SealStateView::Plain),
        };
        Ok(SealedAccountDataView {
            content,
            state,
            can_seal: key.is_some(),
        })
    }

    pub(crate) async fn set_sealed_account_data(
        &self,
        event_type: &str,
        content: &serde_json::Value,
    ) -> Result<(), CommandErr> {
        if !sealable(event_type) {
            return Err(CommandErr::Unsupported);
        }
        let client = self.client().await?;
        let content = match cached_key(&client).await {
            Some(key) => key
                .seal(event_type, content)
                .or_failed(self, "set_sealed_account_data_seal")?,
            None => content.clone(),
        };
        self.put_global_account_data(event_type.into(), &content, "set_sealed_account_data")
            .await
    }

    pub(crate) async fn adopt_account_data_key(
        &self,
        client: &matrix_sdk::Client,
        recovery_key: &str,
    ) {
        let store = match client
            .encryption()
            .secret_storage()
            .open_secret_store(recovery_key)
            .await
        {
            Ok(store) => store,
            Err(error) => {
                tracing::warn!("opening secret storage for the account data key failed: {error}");
                return;
            }
        };
        if let Err(error) = adopt_key(client, &store).await {
            tracing::warn!("adopting the account data key failed: {error}");
            return;
        }
        self.emit(CoreEvent::AccountDataChanged {
            event_type: ADK_SECRET.to_owned(),
        });
        self.emit(CoreEvent::EncryptionStatus {
            status: crate::verification::encryption_status(client).await,
        });
    }

    pub(crate) fn watch_account_data_key_sharing(
        self: &Arc<Self>,
        client: &matrix_sdk::Client,
        generation: u64,
    ) {
        let handle = client.add_event_handler(
            |event: ToDeviceAccountDataKeyRequestEvent,
             encryption: Option<EncryptionInfo>,
             client: matrix_sdk::Client| async move {
                let Some(device) = verified_own_sender(&client, &event.sender, encryption).await
                else {
                    return;
                };
                let Some(key) = cached_key(&client).await else {
                    return;
                };
                let content = ToDeviceAccountDataKeySendEventContent {
                    key: key.to_base64(),
                };
                send_to(&client, &[device], &content).await;
            },
        );
        self.track_session_handler(client, handle);

        let core = self.clone();
        let handle = client.add_event_handler(
            move |event: ToDeviceAccountDataKeySendEvent,
                  encryption: Option<EncryptionInfo>,
                  client: matrix_sdk::Client| {
                let core = core.clone();
                async move {
                    if verified_own_sender(&client, &event.sender, encryption)
                        .await
                        .is_none()
                        || cached_key(&client).await.is_some()
                    {
                        return;
                    }
                    let Some(key) = AccountDataKey::from_base64(&event.content.key) else {
                        tracing::warn!("ignoring an account data key that is not 32 bytes");
                        return;
                    };
                    cache_key(&client, &key).await;
                    core.emit_if_current(
                        generation,
                        CoreEvent::AccountDataChanged {
                            event_type: ADK_SECRET.to_owned(),
                        },
                    );
                    core.emit_if_current(
                        generation,
                        CoreEvent::EncryptionStatus {
                            status: crate::verification::encryption_status(&client).await,
                        },
                    );
                }
            },
        );
        self.track_session_handler(client, handle);

        let mut verification = client.encryption().verification_state();
        let watched = client.clone();
        self.track_session_task(
            spawn(async move {
                loop {
                    if verification.get() == VerificationState::Verified {
                        request_account_data_key(&watched).await;
                    }
                    if verification.next().await.is_none() {
                        return;
                    }
                }
            })
            .abort_on_drop(),
        );
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, EventContent)]
#[ruma_event(type = "moe.sable.account_data_key.request", kind = ToDevice)]
pub(crate) struct ToDeviceAccountDataKeyRequestEventContent {}

#[derive(Clone, Debug, Deserialize, Serialize, EventContent)]
#[ruma_event(type = "moe.sable.account_data_key.send", kind = ToDevice)]
pub(crate) struct ToDeviceAccountDataKeySendEventContent {
    key: String,
}

pub(crate) async fn request_account_data_key(client: &matrix_sdk::Client) {
    if cached_key(client).await.is_some() {
        return;
    }
    let (Some(user_id), Some(device_id)) = (client.user_id(), client.device_id()) else {
        return;
    };
    let devices = match client.encryption().get_user_devices(user_id).await {
        Ok(devices) => devices,
        Err(error) => {
            tracing::warn!("listing our devices for the account data key failed: {error}");
            return;
        }
    };
    let targets: Vec<Device> = devices
        .devices()
        .filter(|device| device.device_id() != device_id && device.is_verified())
        .collect();
    if targets.is_empty() {
        return;
    }
    send_to(
        client,
        &targets,
        &ToDeviceAccountDataKeyRequestEventContent {},
    )
    .await;
}

async fn verified_own_sender(
    client: &matrix_sdk::Client,
    sender: &UserId,
    encryption: Option<EncryptionInfo>,
) -> Option<Device> {
    let encryption = encryption?;
    let device_id = encryption.sender_device?;
    if client.user_id() != Some(sender)
        || encryption.sender != sender
        || client.device_id() == Some(&*device_id)
    {
        return None;
    }
    let lookup = client.encryption();
    let mut device = lookup.get_device(sender, &device_id).await.ok().flatten();
    if !device.as_ref().is_some_and(Device::is_verified) {
        if let Err(error) = lookup.request_user_identity(sender).await {
            tracing::warn!("refreshing our devices for the account data key failed: {error}");
        }
        device = lookup.get_device(sender, &device_id).await.ok().flatten();
    }
    let device = device.filter(Device::is_verified);
    if device.is_none() {
        tracing::warn!(%device_id, "ignoring an account data key message from an unverified device");
    }
    device
}

async fn send_to<C: StaticEventContent + Serialize>(
    client: &matrix_sdk::Client,
    devices: &[Device],
    content: &C,
) {
    let event_type = C::TYPE;
    let Ok(raw) = Raw::new(content) else {
        return;
    };
    match client
        .encryption()
        .encrypt_and_send_raw_to_device(
            devices.iter().collect(),
            event_type,
            raw.cast_unchecked(),
            CollectStrategy::AllDevices,
        )
        .await
    {
        Ok(failures) if failures.is_empty() => {}
        Ok(failures) => tracing::warn!(
            count = failures.len(),
            event_type,
            "some devices did not receive the account data key message"
        ),
        Err(error) => tracing::warn!(
            event_type,
            "sending the account data key message failed: {error}"
        ),
    }
}

#[cfg(test)]
mod tests {
    use matrix_sdk_base::crypto::secret_storage::SecretStorageKey;
    use serde_json::json;

    use super::{AccountDataKey, is_sealed, sealable};

    const EVENT: &str = "moe.sable.next.drafts";

    #[test]
    fn a_sealed_document_opens_only_under_its_own_event_type() {
        let key = AccountDataKey([7; 32]);
        let content = json!({ "v": 1, "drafts": { "!room:example.org": "hello" } });

        let sealed = key.seal(EVENT, &content).unwrap();

        assert!(is_sealed(&sealed));
        assert!(!sealed.to_string().contains("hello"));
        assert_eq!(key.open(EVENT, &sealed), Some(content));
        assert_eq!(key.open("moe.sable.next.settings", &sealed), None);
        assert_eq!(AccountDataKey([8; 32]).open(EVENT, &sealed), None);
    }

    #[test]
    fn a_tampered_ciphertext_is_refused() {
        let key = AccountDataKey([7; 32]);
        let mut sealed = key.seal(EVENT, &json!({ "v": 1 })).unwrap();
        sealed["encrypted"]["ciphertext"] = json!("AAAAAAAA");

        assert_eq!(key.open(EVENT, &sealed), None);
    }

    #[test]
    fn opens_what_the_secret_storage_algorithm_encrypted() {
        let storage_key = SecretStorageKey::new();
        let raw = bs58::decode(storage_key.to_base58().replace(' ', ""))
            .into_vec()
            .unwrap();
        let key = AccountDataKey(raw[2..34].try_into().unwrap());
        let content = json!({ "v": 1, "quietRooms": ["!room:example.org"] });

        let encrypted = storage_key.encrypt(content.to_string().into_bytes(), &EVENT.into());
        let sealed = json!({ "encrypted": serde_json::to_value(encrypted).unwrap() });

        assert_eq!(key.open(EVENT, &sealed), Some(content));
    }

    #[test]
    fn a_key_round_trips_through_its_secret_encoding() {
        let key = AccountDataKey([9; 32]);
        let padded = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, key.0);

        assert_eq!(
            AccountDataKey::from_base64(&key.to_base64()).map(|key| key.0),
            Some([9; 32])
        );
        assert_eq!(
            AccountDataKey::from_base64(&padded).map(|key| key.0),
            Some([9; 32])
        );
        assert!(AccountDataKey::from_base64("c2hvcnQ").is_none());
    }

    #[test]
    fn only_namespaced_non_spec_types_are_sealable() {
        assert!(sealable("moe.sable.next.settings"));
        assert!(!sealable("m.push_rules"));
        assert!(!sealable("m.recent_emoji"));
        assert!(!sealable("plain"));
    }
}
