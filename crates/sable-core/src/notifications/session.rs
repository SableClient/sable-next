use std::time::Duration;

use matrix_sdk::ruma::api::client::sync::sync_events;
use matrix_sdk::ruma::presence::PresenceState;
use matrix_sdk::ruma::{EventId, RoomId};
use matrix_sdk::store::RoomLoadSettings;
use matrix_sdk_ui::notification_client::NotificationProcessSetup;
use sable_model::text::visible_name;

use super::cold::{
    ACCOUNT_DATA_TIMEOUT, ColdPush, KeyFetch, PushHost, cold_push_store_dir, decrypt_push_event,
    push_host,
};
use super::device_activity::DEVICE_ACTIVITY_EVENT;
use super::media::{
    PUSH_AVATAR_SIZE, PUSH_IMAGE_HEIGHT, PUSH_IMAGE_WIDTH, PUSH_MEDIA_DIRECTORY, PushImage,
    PushMedia, cached_push_media, message_image, prune_push_media, push_sender_name,
};
use super::push_cache;
use super::view::fetch_push_event_with;
use crate::protocol::PushFetchView;

pub async fn cold_push_active_elsewhere(
    data_dir: &std::path::Path,
    user_id: &str,
    device_id: &str,
    room_id: &str,
) -> bool {
    let store_dir = cold_push_store_dir(data_dir);
    match PushSession::cached(&store_dir, user_id, device_id, room_id).await {
        Some(session) => session.active_elsewhere().await,
        None => false,
    }
}

pub async fn fetch_cold_push_event(
    data_dir: &std::path::Path,
    user_id: &str,
    device_id: &str,
    room_id: &str,
    event_id: &str,
) -> PushFetchView {
    match PushSession::cached(&cold_push_store_dir(data_dir), user_id, device_id, room_id).await {
        Some(session) => session.fetch(event_id).await,
        None => PushFetchView::Unavailable,
    }
}

/// One restored login for every step of a push, which callers must bound to
/// the platform's notification processing budget.
pub struct PushSession {
    host: push_cache::ColdHost,
    store_dir: std::path::PathBuf,
    pub(super) room_id: ruma::OwnedRoomId,
}

/// A notification reply as it was sent: `text` drops a profile shorthand, and `profile` is
/// set when it went out as a per-message profile.
#[derive(Debug, serde::Serialize)]
pub struct SentReply {
    pub text: String,
    pub profile: Option<SentProfile>,
}

/// `avatar` is a cached file path.
#[derive(Debug, serde::Serialize)]
pub struct SentProfile {
    pub id: String,
    pub name: String,
    pub avatar: Option<String>,
}

const READ_ROOMS_TIMEOUT: Duration = Duration::from_secs(5);
const READ_ROOMS_CONNECTION: &str = "read-rooms";
const READ_ROOMS_TIMELINE: u32 = 1;

/// MSC4186 has no notification counts (Synapse always sent zero), so a room is
/// read when its latest event carries the user's own receipt or is the user's
/// own. A room missing from the response proves nothing, so it stays unread.
fn read_rooms_from_sync(
    response: &sync_events::msc4186::Response,
    own_user: &ruma::UserId,
    room_ids: &[ruma::OwnedRoomId],
) -> Vec<String> {
    room_ids
        .iter()
        .filter(|room_id| {
            let Some(room) = response.rooms.get(*room_id) else {
                return false;
            };
            let receipts = own_receipts(response.extensions.receipts.rooms.get(*room_id), own_user);
            read_through_latest(&room.timeline, &receipts, own_user)
        })
        .map(ToString::to_string)
        .collect()
}

fn read_through_latest(
    timeline: &[ruma::serde::Raw<ruma::events::AnySyncTimelineEvent>],
    receipts: &std::collections::HashSet<String>,
    own_user: &ruma::UserId,
) -> bool {
    let Some(latest) = timeline.last() else {
        return false;
    };
    latest
        .get_field::<String>("event_id")
        .ok()
        .flatten()
        .is_some_and(|event_id| receipts.contains(&event_id))
        || latest
            .get_field::<String>("sender")
            .ok()
            .flatten()
            .as_deref()
            == Some(own_user.as_str())
}

/// Main-timeline receipts only: a threaded receipt says nothing about the room's latest event.
fn own_receipts(
    receipts: Option<&ruma::serde::Raw<ruma::events::receipt::SyncReceiptEvent>>,
    own_user: &ruma::UserId,
) -> std::collections::HashSet<String> {
    let Some(value) =
        receipts.and_then(|raw| serde_json::from_str::<serde_json::Value>(raw.json().get()).ok())
    else {
        return std::collections::HashSet::new();
    };
    // MSC4551 sends the receipts bare; servers predating it wrap them in an `m.receipt` event.
    let content = value
        .get("content")
        .filter(|_| value.get("type").is_some())
        .unwrap_or(&value);
    let Some(events) = content.as_object() else {
        return std::collections::HashSet::new();
    };
    events
        .iter()
        .filter(|(_, types)| {
            [
                "m.read",
                "m.read.private",
                "org.matrix.msc2285.read.private",
            ]
            .iter()
            .any(|kind| {
                types
                    .get(kind)
                    .and_then(|users| users.get(own_user.as_str()))
                    .is_some_and(|receipt| {
                        receipt
                            .get("thread_id")
                            .and_then(serde_json::Value::as_str)
                            .is_none_or(|thread| thread == "main")
                    })
            })
        })
        .map(|(event_id, _)| event_id.clone())
        .collect()
}

impl PushSession {
    pub async fn open(
        store_dir: &std::path::Path,
        user_id: &str,
        device_id: &str,
        room_id: &str,
    ) -> Option<Self> {
        let room_id = RoomId::parse(room_id).ok()?;
        let host = push_host(
            store_dir,
            user_id,
            device_id,
            RoomLoadSettings::One(room_id.clone()),
        )
        .await?;
        Some(Self {
            host: push_cache::ColdHost::uncached(host),
            store_dir: store_dir.to_owned(),
            room_id,
        })
    }

    /// Android's login, which stays restored for as long as no core takes the store.
    async fn cached(
        store_dir: &std::path::Path,
        user_id: &str,
        device_id: &str,
        room_id: &str,
    ) -> Option<Self> {
        let room_id = RoomId::parse(room_id).ok()?;
        Some(Self {
            host: push_cache::cold_host(store_dir, user_id, device_id).await?,
            store_dir: store_dir.to_owned(),
            room_id,
        })
    }

    /// Only with the keys already stored.
    pub async fn decrypt(&self, event_json: &str) -> ColdPush {
        Box::pin(decrypt_push_event(
            self.host.client(),
            KeyFetch::Never,
            self.room_id.as_str(),
            event_json,
        ))
        .await
    }

    pub async fn sender_name(
        &self,
        sender: Option<&str>,
        payload_name: Option<&str>,
        content: Option<&serde_json::Value>,
    ) -> String {
        let override_name = match sender {
            Some(sender) => {
                crate::profile_overrides::notification_name(self.host.client(), sender).await
            }
            None => None,
        };
        let name = push_sender_name(sender, override_name.as_deref().or(payload_name), content);
        let Some(sender) = sender else {
            return name;
        };
        let speaks_as_profile = crate::view::per_message_profile(content)
            .is_some_and(|profile| profile.display_name.is_some());
        if override_name.is_none()
            && !speaks_as_profile
            && name != sender
            && self.name_ambiguous(sender).await
        {
            format!("{name} ({sender})")
        } else {
            name
        }
    }

    async fn name_ambiguous(&self, sender: &str) -> bool {
        let (Some(room), Ok(sender)) = (
            self.host.client().get_room(&self.room_id),
            ruma::UserId::parse(sender),
        ) else {
            return false;
        };
        room.get_member_no_sync(&sender)
            .await
            .ok()
            .flatten()
            .is_some_and(|member| member.name_ambiguous())
    }

    pub async fn fetch(&self, event_id: &str) -> PushFetchView {
        let Ok(event_id) = EventId::parse(event_id) else {
            return PushFetchView::Unavailable;
        };
        let setup = match &*self.host {
            PushHost::Live { sync_service, .. } => NotificationProcessSetup::SingleProcess {
                sync_service: sync_service.clone(),
            },
            // Without this client's own sync service, the SDK's store lock coordinates it with others.
            _ => NotificationProcessSetup::MultipleProcesses,
        };
        let fetch = || {
            Box::pin(fetch_push_event_with(
                self.host.client(),
                setup.clone(),
                &self.room_id,
                &event_id,
            ))
        };
        let result = fetch().await;
        if matches!(result, PushFetchView::Unavailable) && self.host.refresh().await {
            fetch().await
        } else {
            result
        }
    }

    pub async fn active_elsewhere(&self) -> bool {
        let client = self.host.client();
        let (Some(user_id), Some(device_id)) = (client.user_id(), client.device_id()) else {
            return false;
        };
        let Ok(response) = client
            .send(
                ruma::api::client::config::get_global_account_data::v3::Request::new(
                    user_id.to_owned(),
                    DEVICE_ACTIVITY_EVENT.into(),
                ),
            )
            .with_request_config(
                matrix_sdk::config::RequestConfig::short_retry().timeout(ACCOUNT_DATA_TIMEOUT),
            )
            .await
        else {
            return false;
        };
        let Ok(content) = serde_json::from_str::<sable_model::notifications::DeviceActivity>(
            response.account_data.json().get(),
        ) else {
            return false;
        };
        sable_model::notifications::active_elsewhere(&content, device_id.as_str(), crate::now_ms())
    }

    pub async fn read_rooms(&self, room_ids: &[String]) -> Option<Vec<String>> {
        let room_ids = room_ids
            .iter()
            .map(|room_id| RoomId::parse(room_id).ok())
            .collect::<Option<Vec<_>>>()?;
        if room_ids.is_empty() {
            return Some(Vec::new());
        }

        // Room subscriptions name exactly what to send. A `/sync` filter is advisory: a server
        // ignoring it answers with every room and all of the account's data.
        let own_user = self.host.client().user_id()?.to_owned();
        let subscriptions: std::collections::BTreeMap<_, _> = room_ids
            .iter()
            .map(|room_id| {
                let mut subscription = sync_events::msc4186::request::RoomSubscription::default();
                subscription.timeline_limit = READ_ROOMS_TIMELINE.into();
                (room_id.clone(), subscription)
            })
            .collect();

        let response = tokio::time::timeout(
            READ_ROOMS_TIMEOUT,
            self.host.retry(|| async {
                let mut request = sync_events::msc4186::Request::new();
                request.conn_id = Some(READ_ROOMS_CONNECTION.to_owned());
                request.timeout = Some(Duration::ZERO);
                request.set_presence = PresenceState::Offline;
                request.room_subscriptions.clone_from(&subscriptions);
                request.extensions.receipts.enabled = Some(true);
                request.extensions.receipts.rooms = Some(vec![
                    sync_events::msc4186::request::ExtensionRoomConfig::AllSubscribed,
                ]);
                self.host
                    .client()
                    .send(request)
                    .with_request_config(
                        matrix_sdk::config::RequestConfig::short_retry()
                            .timeout(READ_ROOMS_TIMEOUT),
                    )
                    .await
            }),
        )
        .await
        .ok()?
        .ok()?;
        Some(read_rooms_from_sync(&response, &own_user, &room_ids))
    }

    #[must_use]
    pub fn joined_members(&self) -> Option<u64> {
        self.host
            .client()
            .get_room(&self.room_id)
            .map(|room| room.joined_members_count())
    }

    /// `sender` asks for the avatars, `content` for the message's image and per-message
    /// profile; leave out the content when the notification may not show the message.
    /// `payload_avatar` is the sender avatar the SDK resolved with the pushed event, which
    /// this store may have no member for.
    pub async fn media(
        &self,
        sender: Option<&str>,
        payload_name: Option<&str>,
        payload_avatar: Option<&str>,
        content: Option<&serde_json::Value>,
    ) -> PushMedia {
        let sender_name = self.sender_name(sender, payload_name, content).await;
        let client = self.host.client();
        let Some(room) = client.get_room(&self.room_id) else {
            return PushMedia {
                sender_name,
                ..PushMedia::default()
            };
        };
        let profile = sender.and_then(|_| crate::view::per_message_profile(content));
        let profile_avatar = profile
            .as_ref()
            .and_then(|profile| profile.avatar_url.as_deref());
        let sender_url = match (profile_avatar, payload_avatar, sender) {
            (Some(url), _, _) | (None, Some(url), Some(_)) => {
                crate::media::mxc_only(url).map(ruma::OwnedMxcUri::from)
            }
            (None, None, Some(sender)) => match ruma::UserId::parse(sender) {
                Ok(sender) => room
                    .get_member_no_sync(&sender)
                    .await
                    .ok()
                    .flatten()
                    .and_then(|member| member.avatar_url().map(ToOwned::to_owned)),
                Err(_) => None,
            },
            (None, _, None) => None,
        };
        let room_url = match sender {
            Some(_) => crate::view::room_avatar_url(&room)
                .await
                .map(ruma::OwnedMxcUri::from),
            None => None,
        };
        let own = match sender {
            Some(_) => room
                .get_member_no_sync(room.own_user_id())
                .await
                .ok()
                .flatten(),
            None => None,
        };
        let own_name = own.as_ref().and_then(|member| {
            member
                .display_name()
                .and_then(visible_name)
                .map(ToOwned::to_owned)
        });
        let own_url = own.and_then(|member| member.avatar_url().map(ToOwned::to_owned));
        let room_name = match sender {
            Some(_) => super::view::direct_name(&room)
                .await
                .or_else(|| room.cached_display_name().map(|name| name.to_string())),
            None => None,
        };
        let image = match content {
            Some(content) if crate::account_documents::shows_media_previews(&room).await => {
                message_image(content)
            }
            _ => None,
        };
        let directory = self.store_dir.join(PUSH_MEDIA_DIRECTORY);
        prune_push_media(&directory).await;
        let avatar = |url: Option<ruma::OwnedMxcUri>| {
            let source = url.map(ruma::events::room::MediaSource::Plain);
            cached_push_media(
                client,
                &directory,
                source,
                Some((PUSH_AVATAR_SIZE, PUSH_AVATAR_SIZE)),
            )
        };
        let (sender, room, own_avatar, image) = futures_util::join!(
            avatar(sender_url),
            avatar(room_url),
            avatar(own_url),
            cached_push_media(
                client,
                &directory,
                image,
                Some((PUSH_IMAGE_WIDTH, PUSH_IMAGE_HEIGHT))
            ),
        );
        PushMedia {
            sender_name,
            sender: sender.map(|(path, _)| path),
            sender_profile: profile.and_then(|profile| profile.id.or(profile.display_name)),
            room: room.map(|(path, _)| path),
            image: image.map(|(path, mimetype)| PushImage { path, mimetype }),
            own_name,
            own_avatar: own_avatar.map(|(path, _)| path),
            room_name,
        }
    }

    /// Sends `text` to the room, then marks `event_id` read, and returns what was sent.
    /// Retrying with the same `transaction_id` never sends it twice.
    pub async fn reply(
        &self,
        text: &str,
        transaction_id: &str,
        event_id: &str,
        private_receipt: bool,
    ) -> Option<SentReply> {
        let room = self.host.client().get_room(&self.room_id)?;
        let (text, profile) = match self
            .host
            .retry(|| crate::personas::notification_reply(self.host.client(), &self.room_id, text))
            .await
        {
            Ok(reply) => reply,
            Err(error) => {
                tracing::warn!("notification reply profile unavailable: {error}");
                return None;
            }
        };
        let content = crate::outgoing::message_content(
            text.clone(),
            None,
            crate::protocol::MessageKind::Text,
            Vec::new(),
            false,
        );
        let mut content = serde_json::to_value(content).ok()?;
        if let Some(profile) = profile.as_ref() {
            crate::personas::stamp_profile(&mut content, profile);
        }
        let transaction = ruma::OwnedTransactionId::from(transaction_id);
        let message = self.host.retry(|| {
            room.send_raw("m.room.message", content.clone())
                .with_transaction_id(&transaction)
                .into_future()
        });
        let (sent, profile) = futures_util::join!(message, self.sent_profile(&room, profile));
        if let Err(error) = sent {
            tracing::warn!("notification reply not sent: {error}");
            return None;
        }
        self.mark_read(event_id, private_receipt).await;
        Some(SentReply { text, profile })
    }

    async fn sent_profile(
        &self,
        room: &matrix_sdk::Room,
        profile: Option<crate::protocol::PerMessageProfileView>,
    ) -> Option<SentProfile> {
        let profile = profile?;
        let name = match profile.display_name {
            Some(name) => name,
            None => room
                .get_member_no_sync(room.own_user_id())
                .await
                .ok()
                .flatten()
                .and_then(|member| {
                    member
                        .display_name()
                        .and_then(visible_name)
                        .map(ToOwned::to_owned)
                })
                .unwrap_or_else(|| room.own_user_id().to_string()),
        };
        let source = profile
            .avatar_url
            .as_deref()
            .and_then(crate::media::mxc_only)
            .map(|url| ruma::events::room::MediaSource::Plain(url.into()));
        let avatar = cached_push_media(
            self.host.client(),
            &self.store_dir.join(PUSH_MEDIA_DIRECTORY),
            source,
            Some((PUSH_AVATAR_SIZE, PUSH_AVATAR_SIZE)),
        )
        .await;
        Some(SentProfile {
            id: profile.id.unwrap_or_else(|| name.clone()),
            name,
            avatar: avatar.map(|(path, _)| path),
        })
    }

    /// In the event's thread, or the main timeline, as the app's timelines would.
    pub async fn mark_read(&self, event_id: &str, private_receipt: bool) -> bool {
        use matrix_sdk::ruma::api::client::receipt::create_receipt::v3::ReceiptType;
        use matrix_sdk::ruma::events::receipt::ReceiptThread;

        let (Some(room), Ok(event_id)) = (
            self.host.client().get_room(&self.room_id),
            EventId::parse(event_id),
        ) else {
            return false;
        };
        let thread = crate::timelines::receipt_thread_root(&room, &event_id, None)
            .await
            .map_or(ReceiptThread::Main, ReceiptThread::Thread);
        let receipt = if private_receipt {
            ReceiptType::ReadPrivate
        } else {
            ReceiptType::Read
        };
        let sent = self
            .host
            .retry(|| room.send_single_receipt(receipt.clone(), thread.clone(), event_id.clone()))
            .await;
        if let Err(error) = &sent {
            tracing::warn!("notification receipt not sent: {error}");
            return false;
        }
        if thread == ReceiptThread::Main
            && let Err(error) = self
                .host
                .retry(|| {
                    room.send_single_receipt(
                        ReceiptType::FullyRead,
                        ReceiptThread::Unthreaded,
                        event_id.clone(),
                    )
                })
                .await
        {
            tracing::warn!("notification read marker not moved: {error}");
        }
        true
    }
}

pub async fn cold_push_session(
    data_dir: &std::path::Path,
    user_id: &str,
    device_id: &str,
    room_id: &str,
) -> Option<PushSession> {
    PushSession::cached(&cold_push_store_dir(data_dir), user_id, device_id, room_id).await
}

pub async fn cold_push_media(
    data_dir: &std::path::Path,
    user_id: &str,
    device_id: &str,
    room_id: &str,
    sender: Option<&str>,
    payload_name: Option<&str>,
    content: Option<&serde_json::Value>,
) -> PushMedia {
    match PushSession::cached(&cold_push_store_dir(data_dir), user_id, device_id, room_id).await {
        Some(session) => session.media(sender, payload_name, None, content).await,
        None => PushMedia {
            sender_name: push_sender_name(sender, payload_name, content),
            ..PushMedia::default()
        },
    }
}

#[cfg(test)]
mod tests {
    use matrix_sdk::ruma::api::client::sync::sync_events::msc4186::{Response, response};
    use matrix_sdk::ruma::events::AnySyncTimelineEvent;
    use matrix_sdk::ruma::serde::Raw;
    use matrix_sdk::ruma::{RoomId, user_id};
    use serde_json::json;

    use super::read_rooms_from_sync;

    fn event(id: &str, sender: &str) -> Raw<AnySyncTimelineEvent> {
        Raw::from_json_string(
            json!({"type": "m.room.message", "event_id": id, "sender": sender,
                "origin_server_ts": 1, "content": {"msgtype": "m.text", "body": "hi"}})
            .to_string(),
        )
        .unwrap()
    }

    fn room(
        response: &mut Response,
        id: &str,
        timeline: Vec<Raw<AnySyncTimelineEvent>>,
        receipts: Option<serde_json::Value>,
    ) {
        let room_id = RoomId::parse(id).unwrap();
        let mut room = response::Room::default();
        room.timeline = timeline;
        response.rooms.insert(room_id.clone(), room);
        if let Some(receipts) = receipts {
            response.extensions.receipts.rooms.insert(
                room_id,
                Raw::from_json_string(receipts.to_string()).unwrap(),
            );
        }
    }

    #[test]
    fn a_room_is_read_once_the_users_receipt_or_message_follows_everyone_elses() {
        let me = user_id!("@me:example.org");
        let bob = "@bob:example.org";
        let mut response = Response::new("1".to_owned());
        room(
            &mut response,
            "!read:example.org",
            vec![event("$a", bob), event("$b", bob)],
            Some(
                json!({"type": "m.receipt", "content": {"$b": {"m.read": {"@me:example.org": {"ts": 1}}}}}),
            ),
        );
        room(
            &mut response,
            "!private:example.org",
            vec![event("$c", bob)],
            Some(json!({"$c": {"m.read.private": {"@me:example.org": {"thread_id": "main"}}}})),
        );
        room(
            &mut response,
            "!replied:example.org",
            vec![event("$d", bob), event("$e", me.as_str())],
            None,
        );
        room(
            &mut response,
            "!unread:example.org",
            vec![event("$f", bob), event("$g", bob)],
            Some(json!({"$f": {"m.read": {"@me:example.org": {}}}})),
        );
        room(
            &mut response,
            "!threaded:example.org",
            vec![event("$h", bob)],
            Some(json!({"$h": {"m.read": {"@me:example.org": {"thread_id": "$root"}}}})),
        );
        room(
            &mut response,
            "!theirs:example.org",
            vec![event("$i", bob)],
            Some(json!({"$i": {"m.read": {"@bob:example.org": {}}}})),
        );
        room(&mut response, "!no-timeline:example.org", Vec::new(), None);
        let rooms = [
            "!read:example.org",
            "!private:example.org",
            "!replied:example.org",
            "!unread:example.org",
            "!threaded:example.org",
            "!theirs:example.org",
            "!no-timeline:example.org",
            "!left:example.org",
        ]
        .map(|id| RoomId::parse(id).unwrap());

        assert_eq!(
            read_rooms_from_sync(&response, me, &rooms),
            vec![
                "!read:example.org".to_owned(),
                "!private:example.org".to_owned(),
                "!replied:example.org".to_owned(),
            ]
        );
    }
}
