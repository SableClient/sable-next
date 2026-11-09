use std::time::Duration;

use matrix_sdk::ruma::api::client::filter::{FilterDefinition, RoomFilter};
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
    pub(super) room_id: matrix_sdk::ruma::OwnedRoomId,
}

const READ_ROOMS_TIMEOUT: Duration = Duration::from_secs(5);

fn read_rooms_from_sync(
    joined: &std::collections::BTreeMap<matrix_sdk::ruma::OwnedRoomId, Option<u64>>,
    room_ids: &[matrix_sdk::ruma::OwnedRoomId],
) -> Vec<String> {
    room_ids
        .iter()
        .filter(|room_id| {
            joined
                .get(*room_id)
                .is_none_or(|count| count.is_none_or(|count| count == 0))
        })
        .map(ToString::to_string)
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

    pub async fn sender_name(&self, sender: Option<&str>, payload_name: Option<&str>) -> String {
        let override_name = match sender {
            Some(sender) => {
                crate::profile_overrides::notification_name(self.host.client(), sender).await
            }
            None => None,
        };
        push_sender_name(sender, override_name.as_deref().or(payload_name))
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
                matrix_sdk::ruma::api::client::config::get_global_account_data::v3::Request::new(
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

        let mut filter = FilterDefinition::default();
        filter.presence.types = Some(Vec::new());
        filter.account_data.types = Some(Vec::new());
        let mut rooms = RoomFilter::default();
        rooms.rooms = Some(room_ids.clone());
        rooms.timeline.limit = Some(matrix_sdk::ruma::uint!(0));
        rooms.state.types = Some(Vec::new());
        rooms.ephemeral.types = Some(Vec::new());
        rooms.account_data.types = Some(Vec::new());
        filter.room = rooms;

        let response = tokio::time::timeout(
            READ_ROOMS_TIMEOUT,
            self.host.retry(|| async {
                let mut request = sync_events::v3::Request::new();
                request.filter = Some(sync_events::v3::Filter::FilterDefinition(filter.clone()));
                request.timeout = Some(Duration::ZERO);
                request.set_presence = PresenceState::Offline;
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
        let joined = response
            .rooms
            .join
            .iter()
            .map(|(room_id, room)| {
                (
                    room_id.clone(),
                    room.unread_notifications.notification_count.map(u64::from),
                )
            })
            .collect();
        Some(read_rooms_from_sync(&joined, &room_ids))
    }

    #[must_use]
    pub fn joined_members(&self) -> Option<u64> {
        self.host
            .client()
            .get_room(&self.room_id)
            .map(|room| room.joined_members_count())
    }

    /// `sender` asks for the avatars, `content` for the message's image; leave out
    /// the content when the notification may not show the message.
    pub async fn media(
        &self,
        sender: Option<&str>,
        payload_name: Option<&str>,
        content: Option<&serde_json::Value>,
    ) -> PushMedia {
        let sender_name = self.sender_name(sender, payload_name).await;
        let client = self.host.client();
        let Some(room) = client.get_room(&self.room_id) else {
            return PushMedia {
                sender_name,
                ..PushMedia::default()
            };
        };
        let sender_url =
            match sender.and_then(|sender| matrix_sdk::ruma::UserId::parse(sender).ok()) {
                Some(sender) => room
                    .get_member_no_sync(&sender)
                    .await
                    .ok()
                    .flatten()
                    .and_then(|member| member.avatar_url().map(ToOwned::to_owned)),
                None => None,
            };
        let room_url = if sender.is_none() || room.is_direct().await.unwrap_or(false) {
            None
        } else {
            room.avatar_url()
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
        let image = match content {
            Some(content) if crate::account_documents::shows_media_previews(&room).await => {
                message_image(content)
            }
            _ => None,
        };
        let directory = self.store_dir.join(PUSH_MEDIA_DIRECTORY);
        prune_push_media(&directory).await;
        let avatar = |url: Option<matrix_sdk::ruma::OwnedMxcUri>| {
            let source = url.map(matrix_sdk::ruma::events::room::MediaSource::Plain);
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
            room: room.map(|(path, _)| path),
            image: image.map(|(path, mimetype)| PushImage { path, mimetype }),
            own_name,
            own_avatar: own_avatar.map(|(path, _)| path),
        }
    }

    /// Sends `text` to the room, then marks `event_id` read. Retrying with the same
    /// `transaction_id` never sends it twice.
    pub async fn reply(
        &self,
        text: &str,
        transaction_id: &str,
        event_id: &str,
        private_receipt: bool,
    ) -> bool {
        let Some(room) = self.host.client().get_room(&self.room_id) else {
            return false;
        };
        let profile = match self
            .host
            .retry(|| crate::personas::notification_profile(self.host.client(), &self.room_id))
            .await
        {
            Ok(profile) => profile,
            Err(error) => {
                tracing::warn!("notification reply profile unavailable: {error}");
                return false;
            }
        };
        let content = crate::outgoing::message_content(
            text.to_owned(),
            None,
            crate::protocol::MessageKind::Text,
            Vec::new(),
            false,
        );
        let Ok(mut content) = serde_json::to_value(content) else {
            return false;
        };
        if let Some(profile) = profile.as_ref() {
            crate::personas::stamp_profile(&mut content, profile);
        }
        let transaction = matrix_sdk::ruma::OwnedTransactionId::from(transaction_id);
        let sent = self
            .host
            .retry(|| {
                room.send_raw("m.room.message", content.clone())
                    .with_transaction_id(&transaction)
                    .into_future()
            })
            .await;
        if let Err(error) = sent {
            tracing::warn!("notification reply not sent: {error}");
            return false;
        }
        self.mark_read(event_id, private_receipt).await;
        true
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
        Some(session) => session.media(sender, payload_name, content).await,
        None => PushMedia {
            sender_name: push_sender_name(sender, payload_name),
            ..PushMedia::default()
        },
    }
}

#[cfg(test)]
mod tests {
    use matrix_sdk::ruma::room_id;

    use super::read_rooms_from_sync;

    #[test]
    fn filtered_sync_response_identifies_read_rooms() {
        let rooms = vec![
            room_id!("!zero:example.org").to_owned(),
            room_id!("!unread:example.org").to_owned(),
            room_id!("!missing-count:example.org").to_owned(),
            room_id!("!absent:example.org").to_owned(),
        ];
        let joined = [
            (room_id!("!zero:example.org").to_owned(), Some(0)),
            (room_id!("!unread:example.org").to_owned(), Some(2)),
            (room_id!("!missing-count:example.org").to_owned(), None),
        ]
        .into_iter()
        .collect();
        assert_eq!(
            read_rooms_from_sync(&joined, &rooms),
            vec![
                "!zero:example.org".to_owned(),
                "!missing-count:example.org".to_owned(),
                "!absent:example.org".to_owned(),
            ]
        );
    }
}
