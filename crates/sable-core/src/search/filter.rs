use matrix_sdk::ruma::{OwnedRoomId, OwnedUserId};

use crate::protocol::{self, RpcCode, RpcError, SearchAttachment};

/// [`protocol::SearchFilter`] with its ids parsed.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct IndexFilter {
    pub(crate) rooms: Vec<OwnedRoomId>,
    pub(crate) senders: Vec<OwnedUserId>,
    pub(crate) mentions: Vec<OwnedUserId>,
    pub(crate) has: Vec<SearchAttachment>,
    pub(crate) not_rooms: Vec<OwnedRoomId>,
    pub(crate) not_senders: Vec<OwnedUserId>,
    pub(crate) not_mentions: Vec<OwnedUserId>,
    pub(crate) not_has: Vec<SearchAttachment>,
    pub(crate) after_ts: Option<u64>,
    pub(crate) before_ts: Option<u64>,
    pub(crate) phrases: Vec<String>,
    pub(crate) exclude: Vec<String>,
    pub(crate) pinned: Option<bool>,
    pub(crate) in_thread: Option<bool>,
    pub(crate) file_types: Vec<String>,
    pub(crate) not_file_types: Vec<String>,
    pub(crate) pattern: Option<String>,
    pub(crate) state_events: Option<bool>,
}

fn parsed_ids<T: TryFrom<String>>(ids: Vec<String>) -> Result<Vec<T>, RpcError> {
    ids.into_iter()
        .map(|id| T::try_from(id).map_err(|_| RpcCode::InvalidSearchFilter.into()))
        .collect()
}

impl TryFrom<protocol::SearchFilter> for IndexFilter {
    type Error = RpcError;

    fn try_from(filter: protocol::SearchFilter) -> Result<Self, RpcError> {
        Ok(Self {
            rooms: parsed_ids(filter.rooms)?,
            senders: parsed_ids(filter.senders)?,
            mentions: parsed_ids(filter.mentions)?,
            has: filter.has,
            not_rooms: parsed_ids(filter.not_rooms)?,
            not_senders: parsed_ids(filter.not_senders)?,
            not_mentions: parsed_ids(filter.not_mentions)?,
            not_has: filter.not_has,
            after_ts: filter.after_ts,
            before_ts: filter.before_ts,
            phrases: filter.phrases,
            exclude: filter.exclude,
            pinned: filter.pinned,
            in_thread: filter.in_thread,
            file_types: filter.file_types,
            not_file_types: filter.not_file_types,
            pattern: filter.pattern,
            state_events: filter.state_events,
        })
    }
}
