use matrix_sdk::deserialized_responses::EncryptionInfo;
use matrix_sdk::ruma::RoomId;
use matrix_sdk_base::crypto::{Device, OlmMachine, UserIdentity};
use serde_json::{Value, json};

use crate::Core;

impl Core {
    pub(crate) async fn encryption_details(
        &self,
        room_id: &RoomId,
        info: &EncryptionInfo,
    ) -> Option<String> {
        let base = self.base_client().await.ok()?;
        let machine = base.olm_machine().await;
        let details = details(machine.as_ref()?, room_id, info).await;
        serde_json::to_string_pretty(&details).ok()
    }
}

async fn details(machine: &OlmMachine, room_id: &RoomId, info: &EncryptionInfo) -> Value {
    let sender = &info.sender;
    let (current, session) = match info.session_id() {
        Some(id) => (
            machine
                .get_session_encryption_info(room_id, id, sender)
                .await
                .ok(),
            machine
                .store()
                .get_inbound_group_session(room_id, id)
                .await
                .ok()
                .flatten(),
        ),
        None => (None, None),
    };
    let devices = machine.get_user_devices(sender, None).await.ok();
    let named_device = info
        .sender_device
        .as_deref()
        .and_then(|id| devices.as_ref()?.get(id));
    let key_owner = session.as_ref().and_then(|session| {
        devices
            .as_ref()?
            .devices()
            .find(|device| device.curve25519_key() == Some(session.sender_key()))
    });
    let identity = machine.get_identity(sender, None).await.ok().flatten();

    json!({
        "event": info,
        "verification_state_now": current.map(|info| info.verification_state.clone()),
        "session": session.map(|session| json!({
            "imported": session.has_been_imported(),
            "backed_up": session.backed_up(),
            "first_known_index": session.first_known_index(),
            "shared_history": session.shared_history(),
            "sender_data": session.sender_data,
            "forwarder_data": session.forwarder_data,
        })),
        "sender_device": named_device.as_ref().map(device),
        "sender_key_owner": key_owner.as_ref().map(device),
        "sender_identity": identity.as_ref().map(user_identity),
    })
}

fn device(device: &Device) -> Value {
    json!({
        "device_id": device.device_id(),
        "display_name": device.display_name(),
        "curve25519": device.curve25519_key().map(|key| key.to_base64()),
        "ed25519": device.ed25519_key().map(|key| key.to_base64()),
        "verified": device.is_verified(),
        "cross_signed_by_owner": device.is_cross_signed_by_owner(),
        "deleted": device.is_deleted(),
    })
}

fn user_identity(identity: &UserIdentity) -> Value {
    let master_key = match identity {
        UserIdentity::Own(own) => own.master_key().get_first_key(),
        UserIdentity::Other(other) => other.master_key().get_first_key(),
    };
    json!({
        "verified": identity.is_verified(),
        "was_previously_verified": identity.was_previously_verified(),
        "verification_violation": identity.has_verification_violation(),
        "master_key": master_key.map(|key| key.to_base64()),
    })
}
