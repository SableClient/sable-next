use matrix_sdk::Client;
#[cfg(not(target_family = "wasm"))]
use matrix_sdk::ruma::OwnedEventId;
use matrix_sdk::ruma::api::client::push::{PusherIds, PusherInit, PusherKind};
use matrix_sdk::ruma::events::AnySyncMessageLikeEvent;
use matrix_sdk::ruma::events::AnySyncTimelineEvent;
use matrix_sdk::ruma::events::TimelineEventType;
#[cfg(not(target_family = "wasm"))]
use matrix_sdk::ruma::events::room::encrypted::OriginalSyncRoomEncryptedEvent;
use matrix_sdk::ruma::events::room::message::{MessageType, RoomMessageEventContent};
use matrix_sdk::ruma::push::{Action, HttpPusherData, PushFormat};
use matrix_sdk::ruma::serde::Raw;
use matrix_sdk::ruma::{EventId, MilliSecondsSinceUnixEpoch, OwnedUserId, RoomId};
use matrix_sdk_ui::notification_client::{
    NotificationClient, NotificationEvent, NotificationItem, NotificationProcessSetup,
    NotificationStatus, RawNotificationEvent,
};

use url::Url;

use crate::protocol::{NotificationView, PushEventView, PushFetchView, PusherView};
#[cfg(not(target_family = "wasm"))]
use crate::session::{AccountRegistry, PersistedAccount};
#[cfg(not(target_family = "wasm"))]
use crate::store::{FileSessionStore, SessionStore};

const GATEWAY_PATH: &str = "/_matrix/push/v1/notify";

/// Resolve Android's app-data root to the session and SDK stores under `files`.
#[cfg(not(target_family = "wasm"))]
#[must_use]
fn cold_push_store_dir(data_dir: &std::path::Path) -> std::path::PathBuf {
    data_dir.join("files")
}

#[cfg(not(target_family = "wasm"))]
fn push_account<'a>(
    accounts: &'a AccountRegistry,
    user_id: &str,
    device_id: &str,
) -> Option<&'a PersistedAccount> {
    accounts.accounts.iter().find(|account| {
        !account.needs_reauth
            && account.session.credentials.user_id() == user_id
            && account.session.credentials.device_id() == device_id
    })
}

#[cfg(not(target_family = "wasm"))]
#[derive(Debug, PartialEq, Eq)]
pub enum ColdPush {
    Clear(String),
    Discard,
    NeedsKey { quietly: bool },
    Undecryptable,
}

/// Decrypt an Android push.
#[cfg(not(target_family = "wasm"))]
pub async fn decrypt_cold_push(
    core: Option<&crate::Core>,
    data_dir: &std::path::Path,
    user_id: &str,
    device_id: &str,
    room_id: &str,
    event_json: &str,
    fetch_keys: bool,
) -> ColdPush {
    let store_dir = cold_push_store_dir(data_dir);
    if let Some(core) = core {
        let live = core
            .session
            .read()
            .await
            .as_ref()
            .filter(|session| {
                session.client.user_id().is_some_and(|id| id == user_id)
                    && session.client.device_id().is_some_and(|id| id == device_id)
            })
            .map(|session| (session.client.clone(), session.sync_service.clone()));
        return match live {
            Some((client, sync_service)) => {
                let key_fetch = if fetch_keys {
                    KeyFetch::Live(sync_service)
                } else {
                    KeyFetch::Never
                };
                decrypt_push_event(&client, key_fetch, room_id, event_json).await
            }
            None => {
                match cold_push_from_store(&store_dir, user_id, device_id, room_id, event_json)
                    .await
                {
                    ColdPush::NeedsKey { quietly: true } if fetch_keys => ColdPush::Discard,
                    ColdPush::NeedsKey { .. } if fetch_keys => ColdPush::Undecryptable,
                    result => result,
                }
            }
        };
    }
    let Some(client) = push_client(&store_dir, user_id, device_id).await else {
        return ColdPush::Undecryptable;
    };
    let key_fetch = if fetch_keys {
        KeyFetch::Cold
    } else {
        KeyFetch::Never
    };
    decrypt_push_event(&client, key_fetch, room_id, event_json).await
}

/// Decrypt using the same session and SDK stores as the application. Callers
/// must bound the operation to the platform's notification processing budget.
#[cfg(not(target_family = "wasm"))]
pub async fn decrypt_push_from_store(
    store_dir: &std::path::Path,
    user_id: &str,
    device_id: &str,
    room_id: &str,
    event_json: &str,
) -> Option<String> {
    match cold_push_from_store(store_dir, user_id, device_id, room_id, event_json).await {
        ColdPush::Clear(clear) => Some(clear),
        ColdPush::Discard | ColdPush::NeedsKey { .. } | ColdPush::Undecryptable => None,
    }
}

#[cfg(not(target_family = "wasm"))]
async fn cold_push_from_store(
    store_dir: &std::path::Path,
    user_id: &str,
    device_id: &str,
    room_id: &str,
    event_json: &str,
) -> ColdPush {
    let Some(client) = push_client(store_dir, user_id, device_id).await else {
        return ColdPush::Undecryptable;
    };
    Box::pin(decrypt_push_event(
        &client,
        KeyFetch::Never,
        room_id,
        event_json,
    ))
    .await
}

#[cfg(not(target_family = "wasm"))]
async fn push_client(
    store_dir: &std::path::Path,
    user_id: &str,
    device_id: &str,
) -> Option<Client> {
    let stored = FileSessionStore::new(store_dir).load().await.ok()??;
    let base_store = store_dir.to_str()?;
    let (mut accounts, _) = AccountRegistry::from_bytes(&stored, base_store).ok()?;
    accounts.reanchor_stores(base_store);
    let account = push_account(&accounts, user_id, device_id)?;
    crate::session::restore_authenticated_client(&account.store_id, &account.session)
        .await
        .ok()
}

#[cfg(not(target_family = "wasm"))]
enum KeyFetch {
    Never,
    Live(std::sync::Arc<matrix_sdk_ui::sync_service::SyncService>),
    Cold,
}

#[cfg(not(target_family = "wasm"))]
async fn decrypt_push_event(
    client: &Client,
    key_fetch: KeyFetch,
    room_id: &str,
    event_json: &str,
) -> ColdPush {
    let every_encrypted = every_encrypted_event_pushed(client).await;
    let undecryptable = if every_encrypted {
        ColdPush::Discard
    } else {
        ColdPush::Undecryptable
    };
    let Ok(room_id) = RoomId::parse(room_id) else {
        return ColdPush::Undecryptable;
    };
    let Some(room) = client.get_room(&room_id) else {
        return ColdPush::Undecryptable;
    };
    let Ok(event) = Raw::<OriginalSyncRoomEncryptedEvent>::from_json_string(event_json.to_owned())
    else {
        return ColdPush::Undecryptable;
    };
    let push_context = room.push_context().await.ok().flatten();
    let Ok(decrypted) = room.decrypt_event(&event, push_context.as_ref()).await else {
        return undecryptable;
    };

    match &decrypted.kind {
        matrix_sdk::deserialized_responses::TimelineEventKind::Decrypted(clear) => {
            return if decrypted
                .push_actions()
                .is_some_and(|actions| !notifies(actions))
            {
                ColdPush::Discard
            } else {
                ColdPush::Clear(clear.event.json().get().to_owned())
            };
        }
        matrix_sdk::deserialized_responses::TimelineEventKind::UnableToDecrypt {
            utd_info, ..
        } if utd_info.reason.is_missing_room_key() => {}
        matrix_sdk::deserialized_responses::TimelineEventKind::UnableToDecrypt { .. }
        | matrix_sdk::deserialized_responses::TimelineEventKind::PlainText { .. } => {
            return undecryptable;
        }
    }

    let sync_service = match key_fetch {
        KeyFetch::Never => {
            return ColdPush::NeedsKey {
                quietly: every_encrypted,
            };
        }
        KeyFetch::Live(sync_service) => sync_service,
        KeyFetch::Cold => match crate::session::build_sync(client.clone()).await {
            Ok(sync_service) => sync_service,
            Err(_) => return undecryptable,
        },
    };
    let Some(event_id) = event.get_field::<OwnedEventId>("event_id").ok().flatten() else {
        return undecryptable;
    };
    let setup = NotificationProcessSetup::SingleProcess { sync_service };
    let Ok(notifications) = NotificationClient::new(client.clone(), setup).await else {
        return undecryptable;
    };
    match notifications.get_notification(&room_id, &event_id).await {
        Ok(NotificationStatus::Event(item)) => match item.raw_event {
            RawNotificationEvent::Timeline(clear)
                if clear.get_field::<String>("type").ok().flatten().as_deref()
                    != Some("m.room.encrypted") =>
            {
                ColdPush::Clear(clear.json().get().to_owned())
            }
            _ => undecryptable,
        },
        Ok(NotificationStatus::EventFilteredOut | NotificationStatus::EventRedacted) => {
            ColdPush::Discard
        }
        Ok(NotificationStatus::EventNotFound) | Err(_) => undecryptable,
    }
}

#[cfg(not(target_family = "wasm"))]
pub async fn fetch_cold_push_event(
    core: Option<&crate::Core>,
    data_dir: &std::path::Path,
    user_id: &str,
    device_id: &str,
    room_id: &str,
    event_id: &str,
) -> PushFetchView {
    let (Ok(room_id), Ok(event_id)) = (RoomId::parse(room_id), EventId::parse(event_id)) else {
        return PushFetchView::Unavailable;
    };
    let live = match core {
        Some(core) => core
            .session
            .read()
            .await
            .as_ref()
            .filter(|session| {
                session.client.user_id().is_some_and(|id| id == user_id)
                    && session.client.device_id().is_some_and(|id| id == device_id)
            })
            .map(|session| (session.client.clone(), session.sync_service.clone())),
        None => None,
    };
    let (client, sync_service) = if let Some(live) = live {
        live
    } else {
        let store_dir = cold_push_store_dir(data_dir);
        let Some(client) = push_client(&store_dir, user_id, device_id).await else {
            return PushFetchView::Unavailable;
        };
        let Ok(sync_service) = crate::session::build_sync(client.clone()).await else {
            return PushFetchView::Unavailable;
        };
        (client, sync_service)
    };
    Box::pin(fetch_push_event(&client, sync_service, &room_id, &event_id)).await
}

pub async fn fetch_push_event(
    client: &Client,
    sync_service: std::sync::Arc<matrix_sdk_ui::sync_service::SyncService>,
    room_id: &RoomId,
    event_id: &EventId,
) -> PushFetchView {
    let setup = NotificationProcessSetup::SingleProcess { sync_service };
    let Ok(notifications) = NotificationClient::new(client.clone(), setup).await else {
        return PushFetchView::Unavailable;
    };
    match notifications.get_notification(room_id, event_id).await {
        Ok(NotificationStatus::Event(item)) => push_event_view(*item)
            .map_or(PushFetchView::Unavailable, |event| PushFetchView::Event {
                event,
            }),
        Ok(NotificationStatus::EventFilteredOut | NotificationStatus::EventRedacted) => {
            PushFetchView::Discard
        }
        Ok(NotificationStatus::EventNotFound) | Err(_) => PushFetchView::Unavailable,
    }
}

fn push_event_view(item: NotificationItem) -> Option<PushEventView> {
    let raw = match &item.raw_event {
        RawNotificationEvent::Timeline(raw) => raw.json().get(),
        RawNotificationEvent::Invite(raw) => raw.json().get(),
    };
    let mut event: serde_json::Value = serde_json::from_str(raw).ok()?;
    Some(PushEventView {
        event_type: event.get("type")?.as_str()?.to_owned(),
        content: event
            .get_mut("content")
            .map(serde_json::Value::take)
            .unwrap_or_default(),
        sender: item.event.sender().to_string(),
        sender_display_name: item.sender_display_name,
        room_name: item.room_computed_display_name,
        room_avatar_url: item.room_avatar_url,
    })
}

pub use crate::push_rules::notifies;

#[must_use]
pub fn is_one_to_one(room: &matrix_sdk::Room) -> bool {
    room.active_members_count() == 2
}

pub async fn every_encrypted_event_pushed(client: &Client) -> bool {
    client
        .account()
        .push_rules()
        .await
        .is_ok_and(|rules| crate::push_rules::pushes_every_encrypted_event(&rules))
}

pub async fn notification(
    client: &Client,
    setup: NotificationProcessSetup,
    room_id: &RoomId,
    event_id: &EventId,
) -> Option<NotificationView> {
    let notifications = NotificationClient::new(client.clone(), setup).await.ok()?;

    match notifications.get_notification(room_id, event_id).await {
        Ok(NotificationStatus::Event(item)) => {
            Some(view(client.user_id()?.to_owned(), room_id, event_id, *item))
        }
        _ => None,
    }
}

pub(crate) async fn foreground_notification(
    notifications: &NotificationClient,
    room: &matrix_sdk::Room,
    event_id: &EventId,
    discard_undecryptable: bool,
) -> Option<NotificationView> {
    match notifications
        .get_notification_with_context(room.room_id(), event_id)
        .await
    {
        Ok(NotificationStatus::Event(item))
            if !(discard_undecryptable && still_encrypted(&item.event)) =>
        {
            Some(view(
                room.own_user_id().to_owned(),
                room.room_id(),
                event_id,
                *item,
            ))
        }
        _ => None,
    }
}

fn still_encrypted(event: &NotificationEvent) -> bool {
    matches!(
        event,
        NotificationEvent::Timeline(event)
            if event.event_type() == TimelineEventType::RoomEncrypted
    )
}

pub(crate) fn raw_is_encrypted(raw: &Raw<AnySyncTimelineEvent>) -> bool {
    raw.get_field::<String>("type").ok().flatten().as_deref() == Some("m.room.encrypted")
}

pub(crate) async fn invite_notification(
    room: &matrix_sdk::Room,
    actions: &[Action],
) -> Option<NotificationView> {
    let invite = room.invite_details().await.ok()?;
    Some(NotificationView {
        user_id: room.own_user_id().to_owned(),
        room_id: room.room_id().to_owned(),
        event_id: None,
        room_name: room.display_name().await.ok()?.to_string(),
        room_avatar_url: room.avatar_url().map(|url| url.to_string()),
        is_direct: room.is_direct().await.unwrap_or(false),
        encrypted: room.encryption_state().is_encrypted(),
        sender: invite.inviter_id,
        sender_name: invite
            .inviter
            .as_ref()
            .and_then(|member| member.display_name().map(ToOwned::to_owned)),
        sender_avatar_url: invite
            .inviter
            .as_ref()
            .and_then(|member| member.avatar_url().map(ToString::to_string)),
        body: "invited you".to_owned(),
        mention: actions.iter().any(Action::is_highlight),
        noisy: Some(actions.iter().any(|action| action.sound().is_some())),
    })
}

/// A device token must not be handed to anything but a Matrix push gateway.
/// # Errors
///
/// When the address is not a gateway's.
pub(crate) fn gateway(url: &str) -> Result<String, String> {
    let parsed = Url::parse(url).map_err(|_| "the push gateway is not a URL".to_owned())?;
    let plain = parsed.scheme() != "https";
    let addressed = !parsed.username().is_empty() || parsed.password().is_some();
    if plain || addressed || parsed.fragment().is_some() || parsed.path() != GATEWAY_PATH {
        return Err(format!("{url} is not an https {GATEWAY_PATH} endpoint"));
    }

    Ok(parsed.to_string())
}

/// A cold platform notification is built from this payload, and it derives its
/// identity from `user_id`, so leaving it out stops a running app replacing it.
/// # Errors
///
/// When the gateway is not a push gateway, or the server rejects the registration.
pub async fn set_pusher(client: &Client, pusher: PusherView) -> Result<(), String> {
    let mut pusher_data = HttpPusherData::new(gateway(&pusher.url)?);
    if pusher.event_id_only {
        pusher_data.format = Some(PushFormat::EventIdOnly);
    }
    if let Some(user_id) = client.user_id() {
        pusher_data
            .data
            .insert("user_id".to_owned(), user_id.as_str().into());
        pusher_data.data.insert(
            "default_payload".to_owned(),
            serde_json::json!({ "user_id": user_id.as_str() }),
        );
    }
    if let Some(keys) = pusher.web_push {
        pusher_data
            .data
            .insert("endpoint".to_owned(), keys.endpoint.into());
        pusher_data
            .data
            .insert("p256dh".to_owned(), keys.p256dh.into());
        pusher_data.data.insert("auth".to_owned(), keys.auth.into());
    }

    client
        .pusher()
        .set(
            PusherInit {
                ids: PusherIds::new(pusher.pushkey, pusher.app_id),
                kind: PusherKind::Http(pusher_data),
                app_display_name: "Sable".to_owned(),
                device_display_name: pusher.device_display_name,
                profile_tag: None,
                lang: "en".to_owned(),
            }
            .into(),
            pusher.append,
        )
        .await
        .map_err(|error| error.to_string())
}

/// # Errors
///
/// When the server rejects the removal.
pub async fn remove_pusher(client: &Client, pushkey: String, app_id: String) -> Result<(), String> {
    client
        .pusher()
        .delete(PusherIds::new(pushkey, app_id))
        .await
        .map_err(|error| error.to_string())
}

const BACKFILL_GRACE_MS: u64 = 60_000;

#[must_use]
pub fn is_backfill(
    session_start: MilliSecondsSinceUnixEpoch,
    origin_server_ts: MilliSecondsSinceUnixEpoch,
) -> bool {
    let start: u64 = session_start.get().into();
    let sent: u64 = origin_server_ts.get().into();
    sent < start.saturating_sub(BACKFILL_GRACE_MS)
}

pub async fn is_read(room: &matrix_sdk::Room, sent: MilliSecondsSinceUnixEpoch) -> bool {
    room.unread_notification_counts().notification_count == 0
        && crate::inbox::receipt_ts(room).await >= u64::from(sent.get())
}

fn view(
    user_id: OwnedUserId,
    room_id: &RoomId,
    event_id: &EventId,
    item: NotificationItem,
) -> NotificationView {
    NotificationView {
        user_id,
        room_id: room_id.to_owned(),
        event_id: Some(event_id.to_owned()),
        room_name: item.room_computed_display_name,
        room_avatar_url: item.room_avatar_url,
        is_direct: item.is_direct_message_room,
        encrypted: item.is_room_encrypted.unwrap_or(false),
        sender: item.event.sender().to_owned(),
        sender_name: item.sender_display_name,
        sender_avatar_url: item.sender_avatar_url,
        body: body(&item.event),
        mention: item.has_mention.unwrap_or(false),
        noisy: item.is_noisy,
    }
}

fn body(event: &NotificationEvent) -> String {
    match event {
        NotificationEvent::Invite(_) => "invited you".to_owned(),
        NotificationEvent::Timeline(event) => timeline_body(event),
    }
}

const FALLBACK_BODY: &str = "sent a message";

pub(crate) fn timeline_body(event: &AnySyncTimelineEvent) -> String {
    let AnySyncTimelineEvent::MessageLike(message) = event else {
        return FALLBACK_BODY.to_owned();
    };

    match message {
        AnySyncMessageLikeEvent::RoomMessage(message) => message.as_original().map_or_else(
            || FALLBACK_BODY.to_owned(),
            |event| room_message_body(&event.content),
        ),
        AnySyncMessageLikeEvent::RoomEncrypted(_) => "sent an encrypted message".to_owned(),
        AnySyncMessageLikeEvent::Sticker(_) => "sent a sticker".to_owned(),
        AnySyncMessageLikeEvent::Reaction(reaction) => reaction.as_original().map_or_else(
            || FALLBACK_BODY.to_owned(),
            |event| format!("reacted with {}", event.content.relates_to.key),
        ),
        AnySyncMessageLikeEvent::UnstablePollStart(poll) => poll.as_original().map_or_else(
            || FALLBACK_BODY.to_owned(),
            |event| event.content.poll_start().question.text.clone(),
        ),
        AnySyncMessageLikeEvent::CallInvite(_) => "started a call".to_owned(),
        _ => FALLBACK_BODY.to_owned(),
    }
}

fn room_message_body(content: &RoomMessageEventContent) -> String {
    match &content.msgtype {
        MessageType::Image(_) => "sent an image".to_owned(),
        MessageType::Video(_) => "sent a video".to_owned(),
        MessageType::Audio(_) => "sent an audio file".to_owned(),
        MessageType::File(_) => "sent a file".to_owned(),
        MessageType::Gallery(_) => "sent a gallery".to_owned(),
        _ => content.body().to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use matrix_sdk::ruma::events::AnySyncTimelineEvent;
    use matrix_sdk::ruma::push::{ConditionalPushRule, RuleKind, Ruleset};
    use matrix_sdk::ruma::serde::Raw;
    use matrix_sdk::ruma::{MilliSecondsSinceUnixEpoch, UInt, owned_device_id, room_id, user_id};
    use matrix_sdk::test_utils::mocks::MatrixMockServer;
    use matrix_sdk_base::crypto::{
        olm::{Account, EncryptionSettings, InboundGroupSession, OutboundGroupSession, SenderData},
        types::EventEncryptionAlgorithm,
    };
    use matrix_sdk_test::JoinedRoomBuilder;
    use serde_json::json;

    use super::{
        ColdPush, cold_push_store_dir, decrypt_cold_push, fetch_cold_push_event, gateway,
        is_backfill, push_account, timeline_body,
    };
    use crate::protocol::PushFetchView;
    use crate::session::{PersistedSession, restore_authenticated_client};
    use crate::store::{FileSessionStore, SessionStore};

    fn ts(millis: u32) -> MilliSecondsSinceUnixEpoch {
        MilliSecondsSinceUnixEpoch(UInt::from(millis))
    }

    fn event(value: &serde_json::Value) -> AnySyncTimelineEvent {
        Raw::<AnySyncTimelineEvent>::from_json_string(value.to_string())
            .expect("the fixture is valid JSON")
            .deserialize()
            .expect("the fixture is a timeline event")
    }

    #[test]
    fn a_cold_push_only_opens_its_exact_authenticated_account() {
        let accounts: crate::session::AccountRegistry = serde_json::from_value(json!({
            "version": 1, "active_account_id": "a1", "next_account_id": 3,
            "accounts": [
                { "account_id": "a1", "store_id": "one", "needs_reauth": false,
                  "session": { "homeserver": "https://example.org", "credentials": {
                    "kind": "password", "user_id": "@alice:example.org", "device_id": "A", "access_token": "token"
                  }}},
                { "account_id": "a2", "store_id": "two", "needs_reauth": true,
                  "session": { "homeserver": "https://example.org", "credentials": {
                    "kind": "password", "user_id": "@alice:example.org", "device_id": "B", "access_token": "token"
                  }}}
            ]
        }))
        .expect("the account registry fixture is valid");

        assert_eq!(
            push_account(&accounts, "@alice:example.org", "A").map(|account| &account.store_id),
            Some(&"one".to_owned())
        );
        assert!(push_account(&accounts, "@alice:example.org", "B").is_none());
        assert!(push_account(&accounts, "@mallory:example.org", "A").is_none());
    }

    #[test]
    fn a_cold_push_uses_androids_files_directory() {
        assert_eq!(
            cold_push_store_dir(std::path::Path::new("/data/user/0/moe.sable.client")),
            std::path::Path::new("/data/user/0/moe.sable.client/files")
        );
    }

    const COLD_ROOM: &str = "!cold:example.org";

    struct ColdFixture {
        data_dir: std::path::PathBuf,
        client: Option<matrix_sdk::Client>,
        outbound: OutboundGroupSession,
        server: MatrixMockServer,
    }

    impl ColdFixture {
        async fn new(tag: &str, joined: JoinedRoomBuilder, rules: Option<Ruleset>) -> Self {
            let data_dir =
                std::env::temp_dir().join(format!("sable-cold-push-{tag}-{}", std::process::id()));
            let store_dir = cold_push_store_dir(&data_dir);
            let server = MatrixMockServer::new().await;
            server.mock_versions().ok().mount().await;
            let persisted: PersistedSession = serde_json::from_value(json!({
                "homeserver": server.uri(), "resolved_homeserver": server.uri(),
                "credentials": {"kind": "password", "user_id": "@alice:example.org",
                    "device_id": "A", "access_token": "test-token"}
            }))
            .unwrap();
            FileSessionStore::new(&store_dir)
                .save(serde_json::to_vec(&persisted).unwrap())
                .await
                .unwrap();
            let client = restore_authenticated_client(store_dir.to_str().unwrap(), &persisted)
                .await
                .unwrap();
            server
                .mock_sync()
                .ok_and_run(&client, |builder| {
                    if let Some(rules) = rules {
                        builder.add_global_account_data(
                            matrix_sdk_test::event_factory::EventFactory::new().push_rules(rules),
                        );
                    }
                    builder.add_joined_room(joined);
                })
                .await;
            let room = room_id!("!cold:example.org");
            let sender = Account::new(user_id!("@sender:example.org"));
            let keys = sender.identity_keys();
            let outbound = OutboundGroupSession::new(
                owned_device_id!("SENDER"),
                std::sync::Arc::new(keys),
                room,
                EncryptionSettings::default(),
            )
            .unwrap();
            let inbound = InboundGroupSession::new(
                outbound.sender_key(),
                keys.ed25519,
                room,
                &outbound.session_key().await,
                SenderData::unknown(),
                None,
                EventEncryptionAlgorithm::MegolmV1AesSha2,
                None,
                false,
            )
            .unwrap();
            client
                .olm_machine_for_testing()
                .await
                .as_ref()
                .unwrap()
                .store()
                .import_room_keys(vec![inbound.export().await], None, |_, _| ())
                .await
                .unwrap();
            Self {
                data_dir,
                client: Some(client),
                outbound,
                server,
            }
        }

        async fn push(&self, event_type: &str, content: serde_json::Value) -> String {
            encrypted_push(&self.outbound, event_type, content).await
        }

        async fn decrypt(&self, device: &str, event: &str) -> ColdPush {
            decrypt_cold_push(
                None,
                &self.data_dir,
                "@alice:example.org",
                device,
                COLD_ROOM,
                event,
                true,
            )
            .await
        }

        async fn decrypt_locally(&self, event: &str) -> ColdPush {
            decrypt_cold_push(
                None,
                &self.data_dir,
                "@alice:example.org",
                "A",
                COLD_ROOM,
                event,
                false,
            )
            .await
        }
    }

    #[tokio::test]
    async fn a_cold_push_decrypts_from_androids_persisted_store() {
        let mut fixture = ColdFixture::new(
            "store",
            JoinedRoomBuilder::new(room_id!("!cold:example.org")),
            None,
        )
        .await;
        let event = fixture
            .push(
                "m.room.message",
                json!({"msgtype":"m.text", "body":"Cold preview 🔐"}),
            )
            .await;
        // A second SDK client must coexist with the warm application's store owner.
        let ColdPush::Clear(clear) = fixture.decrypt("A", &event).await else {
            panic!("cold decryption while the application has the store open");
        };
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&clear).unwrap()["content"]["body"],
            "Cold preview 🔐"
        );
        drop(fixture.client.take());
        assert!(matches!(
            fixture.decrypt("A", &event).await,
            ColdPush::Clear(_)
        ));
        assert_eq!(
            fixture.decrypt("OTHER", &event).await,
            ColdPush::Undecryptable
        );
        assert!(!fixture.data_dir.join("session.json").exists());

        tokio::fs::remove_dir_all(&fixture.data_dir).await.unwrap();
    }

    async fn encrypted_push(
        outbound: &OutboundGroupSession,
        event_type: &str,
        content: serde_json::Value,
    ) -> String {
        let content = outbound
            .encrypt(event_type, &serde_json::from_value(content).unwrap())
            .await
            .content;
        json!({"type":"m.room.encrypted", "event_id":"$cold",
            "sender":"@sender:example.org", "origin_server_ts":1, "content":content})
        .to_string()
    }

    fn cold_room_with_members() -> JoinedRoomBuilder {
        let factory = matrix_sdk_test::event_factory::EventFactory::new()
            .room(room_id!("!cold:example.org"))
            .sender(user_id!("@sender:example.org"));
        JoinedRoomBuilder::new(room_id!("!cold:example.org"))
            .add_state_event(factory.member(user_id!("@alice:example.org")))
            .add_state_event(factory.member(user_id!("@sender:example.org")))
            .add_state_event(factory.default_power_levels())
    }

    #[tokio::test]
    async fn a_cold_push_the_push_rules_silence_is_discarded() {
        use matrix_sdk::ruma::push::PredefinedUnderrideRuleId;

        let fixture = ColdFixture::new("reaction", cold_room_with_members(), None).await;
        let reaction = fixture
            .push(
                "m.reaction",
                json!({"m.relates_to": {"rel_type": "m.annotation", "event_id": "$target", "key": "👍"}}),
            )
            .await;
        let message = fixture
            .push(
                "m.room.message",
                json!({"msgtype":"m.text", "body":"hello"}),
            )
            .await;

        assert_eq!(fixture.decrypt("A", &reaction).await, ColdPush::Discard);
        assert!(matches!(
            fixture.decrypt("A", &message).await,
            ColdPush::Clear(_)
        ));
        tokio::fs::remove_dir_all(&fixture.data_dir).await.unwrap();

        let mut rules = Ruleset::server_default(user_id!("@alice:example.org"));
        rules
            .set_actions(
                RuleKind::Underride,
                PredefinedUnderrideRuleId::Message.as_str(),
                vec![],
            )
            .unwrap();
        let fixture = ColdFixture::new("mentions", cold_room_with_members(), Some(rules)).await;
        let message = fixture
            .push(
                "m.room.message",
                json!({"msgtype":"m.text", "body":"hello"}),
            )
            .await;

        assert_eq!(fixture.decrypt("A", &message).await, ColdPush::Discard);
        tokio::fs::remove_dir_all(&fixture.data_dir).await.unwrap();
    }

    #[tokio::test]
    async fn a_cold_push_in_an_all_messages_room_is_shown_under_a_mentions_default() {
        use matrix_sdk::ruma::push::{NewPushRule, NewSimplePushRule, PredefinedUnderrideRuleId};

        let mut rules = Ruleset::server_default(user_id!("@alice:example.org"));
        rules
            .set_actions(
                RuleKind::Underride,
                PredefinedUnderrideRuleId::Message.as_str(),
                vec![],
            )
            .unwrap();
        rules
            .insert(
                NewPushRule::Room(NewSimplePushRule::new(
                    room_id!("!cold:example.org").to_owned(),
                    vec![matrix_sdk::ruma::push::Action::Notify],
                )),
                None,
                None,
            )
            .unwrap();
        let fixture = ColdFixture::new("all", cold_room_with_members(), Some(rules)).await;
        let message = fixture
            .push(
                "m.room.message",
                json!({"msgtype":"m.text", "body":"hello"}),
            )
            .await;

        let ColdPush::Clear(clear) = fixture.decrypt("A", &message).await else {
            panic!("an all-messages room must still notify");
        };
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&clear).unwrap()["content"]["body"],
            "hello"
        );
        tokio::fs::remove_dir_all(&fixture.data_dir).await.unwrap();
    }

    #[tokio::test]
    async fn a_local_decryption_asks_for_the_key_quietly_only_when_every_encrypted_event_is_pushed()
    {
        let stranger = OutboundGroupSession::new(
            owned_device_id!("STRANGER"),
            std::sync::Arc::new(Account::new(user_id!("@sender:example.org")).identity_keys()),
            room_id!("!cold:example.org"),
            EncryptionSettings::default(),
        )
        .unwrap();
        let unknown = encrypted_push(
            &stranger,
            "m.room.message",
            json!({"msgtype":"m.text", "body":"hello"}),
        )
        .await;

        let fixture = ColdFixture::new("needs-key", cold_room_with_members(), None).await;
        assert_eq!(
            fixture.decrypt_locally(&unknown).await,
            ColdPush::NeedsKey { quietly: false }
        );
        tokio::fs::remove_dir_all(&fixture.data_dir).await.unwrap();

        let mut rules = Ruleset::server_default(user_id!("@alice:example.org"));
        rules.override_.insert(
            serde_json::from_value::<ConditionalPushRule>(json!({
                "rule_id": ".org.matrix.msc4028.encrypted_event",
                "default": true,
                "enabled": true,
                "conditions": [{"kind": "event_match", "key": "type", "pattern": "m.room.encrypted"}],
                "actions": ["notify"],
            }))
            .unwrap(),
        );
        let fixture =
            ColdFixture::new("needs-key-quietly", cold_room_with_members(), Some(rules)).await;
        assert_eq!(
            fixture.decrypt_locally(&unknown).await,
            ColdPush::NeedsKey { quietly: true }
        );
        tokio::fs::remove_dir_all(&fixture.data_dir).await.unwrap();
    }

    async fn fetch(fixture: &ColdFixture, device: &str, event: serde_json::Value) -> PushFetchView {
        use matrix_sdk::ruma::api::client::sync::sync_events::v5;

        let mut room = v5::response::Room::new();
        room.initial = Some(true);
        room.timeline = vec![Raw::from_json_string(event.to_string()).unwrap()];
        let mut response = v5::Response::new("1".to_owned());
        response.rooms =
            std::collections::BTreeMap::from([(room_id!("!cold:example.org").to_owned(), room)]);
        let _sync = fixture
            .server
            .mock_sliding_sync()
            .ok(response)
            .mount_as_scoped()
            .await;
        let _encryption = fixture
            .server
            .mock_room_state_encryption()
            .plain()
            .mount_as_scoped()
            .await;
        fetch_cold_push_event(
            None,
            &fixture.data_dir,
            "@alice:example.org",
            device,
            COLD_ROOM,
            event["event_id"].as_str().unwrap(),
        )
        .await
    }

    #[tokio::test]
    async fn an_event_id_only_push_is_fetched_in_the_shape_of_a_rich_payload() {
        let fixture = ColdFixture::new("fetch", cold_room_with_members(), None).await;
        let message = json!({"type": "m.room.message", "event_id": "$fetched",
            "sender": "@sender:example.org", "origin_server_ts": 1,
            "content": {"msgtype": "m.text", "body": "fetched by id"}});

        let PushFetchView::Event { event } = fetch(&fixture, "A", message.clone()).await else {
            panic!("a push that names only its event must be fetched");
        };
        let payload = serde_json::to_value(&event).unwrap();
        assert_eq!(payload["type"], "m.room.message");
        assert_eq!(payload["content"]["body"], "fetched by id");
        assert_eq!(payload["sender"], "@sender:example.org");
        assert!(!event.room_name.is_empty());

        assert!(matches!(
            fetch(&fixture, "OTHER", message).await,
            PushFetchView::Unavailable
        ));

        tokio::fs::remove_dir_all(&fixture.data_dir).await.unwrap();
    }

    fn stub(event_type: &str, content: &serde_json::Value) -> serde_json::Value {
        json!({
            "type": event_type,
            "content": content,
            "event_id": "$1:example.org",
            "sender": "@alice:example.org",
            "origin_server_ts": 0,
        })
    }

    #[test]
    fn every_notifiable_event_says_something() {
        let cases = [
            stub(
                "m.room.message",
                &json!({"msgtype": "m.text", "body": "hello"}),
            ),
            stub(
                "m.room.message",
                &json!({"msgtype": "m.image", "body": "cat.png", "url": "mxc://example.org/2"}),
            ),
            stub(
                "m.room.message",
                &json!({"msgtype": "dm.filament.gallery", "body": "", "itemtypes": [{"itemtype": "m.image", "body": "cat.png", "url": "mxc://example.org/3"}]}),
            ),
            stub(
                "m.room.encrypted",
                &json!({"algorithm": "m.megolm.v1.aes-sha2", "ciphertext": "x", "sender_key": "k", "device_id": "D", "session_id": "s"}),
            ),
            stub(
                "m.sticker",
                &json!({"body": "wave", "url": "mxc://example.org/1", "info": {"w": 1, "h": 1, "mimetype": "image/png", "size": 1}}),
            ),
            stub(
                "m.reaction",
                &json!({"m.relates_to": {"rel_type": "m.annotation", "event_id": "$0:example.org", "key": "👍"}}),
            ),
            stub(
                "org.matrix.msc3381.poll.start",
                &json!({"org.matrix.msc3381.poll.start": {"question": {"org.matrix.msc1767.text": "Lunch?"}, "answers": [{"id": "a", "org.matrix.msc1767.text": "Yes"}]}}),
            ),
            stub("m.room.topic", &json!({"topic": "hi"})),
        ];

        for case in cases {
            let body = timeline_body(&event(&case));
            assert!(
                !body.is_empty(),
                "a notification for {case} would read as a bare sender name"
            );
        }
    }

    #[test]
    fn the_body_describes_what_arrived() {
        assert_eq!(
            timeline_body(&event(&stub(
                "m.room.message",
                &json!({"msgtype": "m.text", "body": "hello"})
            ))),
            "hello"
        );
        assert_eq!(
            timeline_body(&event(&stub(
                "m.room.encrypted",
                &json!({"algorithm": "m.megolm.v1.aes-sha2", "ciphertext": "x", "sender_key": "k", "device_id": "D", "session_id": "s"})
            ))),
            "sent an encrypted message"
        );
        assert_eq!(
            timeline_body(&event(&stub(
                "m.reaction",
                &json!({"m.relates_to": {"rel_type": "m.annotation", "event_id": "$0:example.org", "key": "👍"}})
            ))),
            "reacted with 👍"
        );
        assert_eq!(
            timeline_body(&event(&stub(
                "org.matrix.msc3381.poll.start",
                &json!({"org.matrix.msc3381.poll.start": {"question": {"org.matrix.msc1767.text": "Lunch?"}, "answers": [{"id": "a", "org.matrix.msc1767.text": "Yes"}]}})
            ))),
            "Lunch?"
        );
    }

    #[test]
    fn a_replayed_event_is_backfill_and_a_recent_one_is_not() {
        let start = ts(120_000);
        assert!(is_backfill(start, ts(1_000)));
        assert!(!is_backfill(start, ts(120_000)));
        assert!(!is_backfill(start, ts(200_000)));
        assert!(!is_backfill(start, ts(61_000)));
        assert!(is_backfill(start, ts(59_000)));
    }

    #[test]
    fn a_gateway_must_be_an_https_notify_endpoint() {
        assert_eq!(
            gateway("https://sygnal.example/_matrix/push/v1/notify"),
            Ok("https://sygnal.example/_matrix/push/v1/notify".to_owned())
        );

        let accepted: Vec<&str> = [
            "http://sygnal.example/_matrix/push/v1/notify",
            "https://user:pass@sygnal.example/_matrix/push/v1/notify",
            "https://sygnal.example/_matrix/push/v1/notify#fragment",
            "https://sygnal.example/",
            "not a url",
        ]
        .into_iter()
        .filter(|address| gateway(address).is_ok())
        .collect();

        assert!(accepted.is_empty(), "these are not gateways: {accepted:?}");
    }
}
