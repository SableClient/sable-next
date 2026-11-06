//! A `MemoryStore` that counts room state lookups, for tests that hold them to a budget.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use matrix_sdk::ruma::events::presence::PresenceEvent;
use matrix_sdk::ruma::events::receipt::{Receipt, ReceiptThread, ReceiptType};
use matrix_sdk::ruma::events::{
    AnyGlobalAccountDataEvent, AnyRoomAccountDataEvent, GlobalAccountDataEventType,
    RoomAccountDataEventType, StateEventType,
};
use matrix_sdk::ruma::profile::UserProfile;
use matrix_sdk::ruma::serde::Raw;
use matrix_sdk::ruma::{
    EventId, MilliSecondsSinceUnixEpoch, OwnedEventId, OwnedRoomId, OwnedTransactionId,
    OwnedUserId, RoomId, TransactionId, UserId,
};
use matrix_sdk_base::deserialized_responses::{DisplayName, RawAnySyncOrStrippedState};
use matrix_sdk_base::store::{
    ChildTransactionId, DependentQueuedRequest, DependentQueuedRequestKind, MemoryStore,
    QueueWedgeError, QueuedRequest, QueuedRequestKind, RoomLoadSettings, SentRequestKey,
    StoredThreadSubscription,
};
use matrix_sdk_base::{
    MinimalRoomMemberEvent, RoomInfo, RoomMemberships, StateChanges, StateStore, StateStoreDataKey,
    StateStoreDataValue,
};

#[derive(Clone, Debug, Default)]
pub(crate) struct StoreReads(Arc<Mutex<HashMap<&'static str, usize>>>);

impl StoreReads {
    fn record(&self, method: &'static str) {
        if let Ok(mut counts) = self.0.lock() {
            *counts.entry(method).or_default() += 1;
        }
    }

    fn of(&self, method: &str) -> usize {
        self.0
            .lock()
            .map_or(0, |counts| counts.get(method).copied().unwrap_or_default())
    }

    /// Room state lookups since the last reset, each two `IndexedDB` transactions on the web.
    pub(crate) fn state(&self) -> usize {
        self.of("get_state_event")
            + self.of("get_state_events")
            + self.of("get_state_events_for_keys")
    }

    pub(crate) fn reset(&self) {
        if let Ok(mut counts) = self.0.lock() {
            counts.clear();
        }
    }
}

#[derive(Debug)]
pub(crate) struct CountingStore {
    inner: MemoryStore,
    reads: StoreReads,
}

impl CountingStore {
    pub(crate) fn new() -> (Self, StoreReads) {
        let reads = StoreReads::default();
        (
            Self {
                inner: MemoryStore::new(),
                reads: reads.clone(),
            },
            reads,
        )
    }
}

#[cfg_attr(target_family = "wasm", async_trait(?Send))]
#[cfg_attr(not(target_family = "wasm"), async_trait)]
impl StateStore for CountingStore {
    type Error = <MemoryStore as StateStore>::Error;

    async fn get_kv_data(
        &self,
        key: StateStoreDataKey<'_>,
    ) -> Result<Option<StateStoreDataValue>, Self::Error> {
        self.inner.get_kv_data(key).await
    }

    async fn set_kv_data(
        &self,
        key: StateStoreDataKey<'_>,
        value: StateStoreDataValue,
    ) -> Result<(), Self::Error> {
        self.inner.set_kv_data(key, value).await
    }

    async fn remove_kv_data(&self, key: StateStoreDataKey<'_>) -> Result<(), Self::Error> {
        self.inner.remove_kv_data(key).await
    }

    async fn save_changes(&self, changes: &StateChanges) -> Result<(), Self::Error> {
        self.inner.save_changes(changes).await
    }

    async fn get_presence_event(
        &self,
        user_id: &UserId,
    ) -> Result<Option<Raw<PresenceEvent>>, Self::Error> {
        self.inner.get_presence_event(user_id).await
    }

    async fn get_presence_events(
        &self,
        user_ids: &[OwnedUserId],
    ) -> Result<Vec<Raw<PresenceEvent>>, Self::Error> {
        self.inner.get_presence_events(user_ids).await
    }

    async fn get_state_event(
        &self,
        room_id: &RoomId,
        event_type: StateEventType,
        state_key: &str,
    ) -> Result<Option<RawAnySyncOrStrippedState>, Self::Error> {
        self.reads.record("get_state_event");
        self.inner
            .get_state_event(room_id, event_type, state_key)
            .await
    }

    async fn get_state_events(
        &self,
        room_id: &RoomId,
        event_type: StateEventType,
    ) -> Result<Vec<RawAnySyncOrStrippedState>, Self::Error> {
        self.reads.record("get_state_events");
        self.inner.get_state_events(room_id, event_type).await
    }

    async fn get_state_events_for_keys(
        &self,
        room_id: &RoomId,
        event_type: StateEventType,
        state_keys: &[&str],
    ) -> Result<Vec<RawAnySyncOrStrippedState>, Self::Error> {
        self.reads.record("get_state_events_for_keys");
        self.inner
            .get_state_events_for_keys(room_id, event_type, state_keys)
            .await
    }

    async fn get_profile(
        &self,
        room_id: &RoomId,
        user_id: &UserId,
    ) -> Result<Option<MinimalRoomMemberEvent>, Self::Error> {
        self.inner.get_profile(room_id, user_id).await
    }

    async fn get_profiles<'a>(
        &self,
        room_id: &RoomId,
        user_ids: &'a [OwnedUserId],
    ) -> Result<BTreeMap<&'a UserId, MinimalRoomMemberEvent>, Self::Error> {
        self.inner.get_profiles(room_id, user_ids).await
    }

    async fn get_user_ids(
        &self,
        room_id: &RoomId,
        memberships: RoomMemberships,
    ) -> Result<Vec<OwnedUserId>, Self::Error> {
        self.inner.get_user_ids(room_id, memberships).await
    }

    async fn get_room_infos(
        &self,
        room_load_settings: &RoomLoadSettings,
    ) -> Result<Vec<RoomInfo>, Self::Error> {
        self.inner.get_room_infos(room_load_settings).await
    }

    async fn get_users_with_display_name(
        &self,
        room_id: &RoomId,
        display_name: &DisplayName,
    ) -> Result<BTreeSet<OwnedUserId>, Self::Error> {
        self.inner
            .get_users_with_display_name(room_id, display_name)
            .await
    }

    async fn get_users_with_display_names<'a>(
        &self,
        room_id: &RoomId,
        display_names: &'a [DisplayName],
    ) -> Result<HashMap<&'a DisplayName, BTreeSet<OwnedUserId>>, Self::Error> {
        self.inner
            .get_users_with_display_names(room_id, display_names)
            .await
    }

    async fn get_account_data_event(
        &self,
        event_type: GlobalAccountDataEventType,
    ) -> Result<Option<Raw<AnyGlobalAccountDataEvent>>, Self::Error> {
        self.inner.get_account_data_event(event_type).await
    }

    async fn get_room_account_data_event(
        &self,
        room_id: &RoomId,
        event_type: RoomAccountDataEventType,
    ) -> Result<Option<Raw<AnyRoomAccountDataEvent>>, Self::Error> {
        self.inner
            .get_room_account_data_event(room_id, event_type)
            .await
    }

    async fn get_user_room_receipt_event(
        &self,
        room_id: &RoomId,
        receipt_type: ReceiptType,
        receipt_thread: &ReceiptThread,
        user_id: &UserId,
    ) -> Result<Option<(OwnedEventId, Receipt)>, Self::Error> {
        self.inner
            .get_user_room_receipt_event(room_id, receipt_type, receipt_thread, user_id)
            .await
    }

    async fn get_event_room_receipt_events(
        &self,
        room_id: &RoomId,
        receipt_type: ReceiptType,
        receipt_thread: &ReceiptThread,
        event_id: &EventId,
    ) -> Result<Vec<(OwnedUserId, Receipt)>, Self::Error> {
        self.inner
            .get_event_room_receipt_events(room_id, receipt_type, receipt_thread, event_id)
            .await
    }

    async fn get_event_room_receipt_events_batch<'a>(
        &self,
        room_id: &RoomId,
        receipt_type: ReceiptType,
        receipt_thread: &ReceiptThread,
        event_ids: &[&'a EventId],
    ) -> Result<BTreeMap<&'a EventId, Vec<(OwnedUserId, Receipt)>>, Self::Error> {
        self.inner
            .get_event_room_receipt_events_batch(room_id, receipt_type, receipt_thread, event_ids)
            .await
    }

    async fn get_custom_value(&self, key: &[u8]) -> Result<Option<Vec<u8>>, Self::Error> {
        self.inner.get_custom_value(key).await
    }

    async fn set_custom_value(
        &self,
        key: &[u8],
        value: Vec<u8>,
    ) -> Result<Option<Vec<u8>>, Self::Error> {
        self.inner.set_custom_value(key, value).await
    }

    async fn remove_custom_value(&self, key: &[u8]) -> Result<Option<Vec<u8>>, Self::Error> {
        self.inner.remove_custom_value(key).await
    }

    async fn remove_room(&self, room_id: &RoomId) -> Result<(), Self::Error> {
        self.inner.remove_room(room_id).await
    }

    async fn save_send_queue_request(
        &self,
        room_id: &RoomId,
        transaction_id: OwnedTransactionId,
        created_at: MilliSecondsSinceUnixEpoch,
        request: QueuedRequestKind,
        priority: usize,
    ) -> Result<(), Self::Error> {
        self.inner
            .save_send_queue_request(room_id, transaction_id, created_at, request, priority)
            .await
    }

    async fn update_send_queue_request(
        &self,
        room_id: &RoomId,
        transaction_id: &TransactionId,
        content: QueuedRequestKind,
    ) -> Result<bool, Self::Error> {
        self.inner
            .update_send_queue_request(room_id, transaction_id, content)
            .await
    }

    async fn remove_send_queue_request(
        &self,
        room_id: &RoomId,
        transaction_id: &TransactionId,
    ) -> Result<bool, Self::Error> {
        self.inner
            .remove_send_queue_request(room_id, transaction_id)
            .await
    }

    async fn load_send_queue_requests(
        &self,
        room_id: &RoomId,
    ) -> Result<Vec<QueuedRequest>, Self::Error> {
        self.inner.load_send_queue_requests(room_id).await
    }

    async fn update_send_queue_request_status(
        &self,
        room_id: &RoomId,
        transaction_id: &TransactionId,
        error: Option<QueueWedgeError>,
    ) -> Result<(), Self::Error> {
        self.inner
            .update_send_queue_request_status(room_id, transaction_id, error)
            .await
    }

    async fn load_rooms_with_unsent_requests(&self) -> Result<Vec<OwnedRoomId>, Self::Error> {
        self.inner.load_rooms_with_unsent_requests().await
    }

    async fn save_dependent_queued_request(
        &self,
        room_id: &RoomId,
        parent_txn_id: &TransactionId,
        own_txn_id: ChildTransactionId,
        created_at: MilliSecondsSinceUnixEpoch,
        content: DependentQueuedRequestKind,
    ) -> Result<(), Self::Error> {
        self.inner
            .save_dependent_queued_request(room_id, parent_txn_id, own_txn_id, created_at, content)
            .await
    }

    async fn mark_dependent_queued_requests_as_ready(
        &self,
        room_id: &RoomId,
        parent_txn_id: &TransactionId,
        sent_parent_key: SentRequestKey,
    ) -> Result<usize, Self::Error> {
        self.inner
            .mark_dependent_queued_requests_as_ready(room_id, parent_txn_id, sent_parent_key)
            .await
    }

    async fn update_dependent_queued_request(
        &self,
        room_id: &RoomId,
        own_transaction_id: &ChildTransactionId,
        new_content: DependentQueuedRequestKind,
    ) -> Result<bool, Self::Error> {
        self.inner
            .update_dependent_queued_request(room_id, own_transaction_id, new_content)
            .await
    }

    async fn remove_dependent_queued_request(
        &self,
        room: &RoomId,
        own_txn_id: &ChildTransactionId,
    ) -> Result<bool, Self::Error> {
        self.inner
            .remove_dependent_queued_request(room, own_txn_id)
            .await
    }

    async fn load_dependent_queued_requests(
        &self,
        room: &RoomId,
    ) -> Result<Vec<DependentQueuedRequest>, Self::Error> {
        self.inner.load_dependent_queued_requests(room).await
    }

    async fn upsert_thread_subscriptions(
        &self,
        updates: Vec<(&RoomId, &EventId, StoredThreadSubscription)>,
    ) -> Result<(), Self::Error> {
        self.inner.upsert_thread_subscriptions(updates).await
    }

    async fn remove_thread_subscription(
        &self,
        room: &RoomId,
        thread_id: &EventId,
    ) -> Result<(), Self::Error> {
        self.inner.remove_thread_subscription(room, thread_id).await
    }

    async fn load_thread_subscription(
        &self,
        room: &RoomId,
        thread_id: &EventId,
    ) -> Result<Option<StoredThreadSubscription>, Self::Error> {
        self.inner.load_thread_subscription(room, thread_id).await
    }

    async fn get_global_profile(
        &self,
        user_id: &UserId,
    ) -> Result<Option<UserProfile>, Self::Error> {
        self.inner.get_global_profile(user_id).await
    }

    async fn get_global_profiles<'a>(
        &self,
        user_ids: &'a [OwnedUserId],
    ) -> Result<BTreeMap<&'a UserId, UserProfile>, Self::Error> {
        self.inner.get_global_profiles(user_ids).await
    }

    async fn get_missing_global_profiles<'a>(
        &self,
        user_ids: &'a [OwnedUserId],
    ) -> Result<Vec<&'a UserId>, Self::Error> {
        self.inner.get_missing_global_profiles(user_ids).await
    }

    async fn close(&self) -> Result<(), Self::Error> {
        self.inner.close().await
    }

    async fn reopen(&self) -> Result<(), Self::Error> {
        self.inner.reopen().await
    }

    async fn optimize(&self) -> Result<(), Self::Error> {
        self.inner.optimize().await
    }

    async fn get_size(&self) -> Result<Option<usize>, Self::Error> {
        self.inner.get_size().await
    }
}

/// A logged-in mock client whose state store counts reads.
pub(crate) async fn counting_client(
    server: &matrix_sdk::test_utils::mocks::MatrixMockServer,
) -> (matrix_sdk::Client, StoreReads) {
    use matrix_sdk::config::StoreConfig;
    use matrix_sdk_base::store::IntoStateStore as _;
    use matrix_sdk_common::cross_process_lock::CrossProcessLockConfig;

    let (store, reads) = CountingStore::new();
    let client = server
        .client_builder()
        .on_builder(|builder| {
            builder.store_config(
                StoreConfig::new(CrossProcessLockConfig::SingleProcess)
                    .state_store(store.into_state_store()),
            )
        })
        .build()
        .await;
    (client, reads)
}
