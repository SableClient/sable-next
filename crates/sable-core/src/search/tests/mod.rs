mod crawl;
mod filters;
mod golden;
mod ingest;
mod lifecycle;
mod media;
mod restore;
mod server;
mod updates;

use matrix_sdk::ruma::EventId;
use matrix_sdk::ruma::room_version_rules::RedactionRules;
use matrix_sdk::test_utils::mocks::MatrixMockServer;
use std::sync::Arc;

use crate::search::MessageIndex;

pub(super) async fn in_restored_room(
    index: &MessageIndex,
    room_id: &ruma::OwnedRoomId,
    query: &str,
    limit: usize,
) -> Vec<crate::search::Hit> {
    index
        .search_pinned(
            query,
            &crate::search::IndexFilter {
                rooms: vec![room_id.clone()],
                ..crate::search::IndexFilter::default()
            },
            std::collections::HashSet::new(),
            crate::api::search::SearchOrder::Rank,
            limit,
            0,
        )
        .await
}

pub(super) fn in_room(
    index: &MessageIndex,
    room_id: &ruma::OwnedRoomId,
    query: &str,
    limit: usize,
    offset: usize,
) -> Vec<crate::search::Hit> {
    index.search(
        query,
        &crate::search::IndexFilter {
            rooms: vec![room_id.clone()],
            ..crate::search::IndexFilter::default()
        },
        crate::api::search::SearchOrder::Rank,
        limit,
        offset,
    )
}

pub(super) async fn reingest_whole_room(
    index: &MessageIndex,
    cache: &matrix_sdk::event_cache::RoomEventCache,
    room_id: &ruma::OwnedRoomId,
) {
    let events = cache.events().await.expect("cached events");
    index
        .ingest(room_id, events, cache, &RedactionRules::V11)
        .await;
}

pub(in crate::search) fn document(
    seed: &str,
    body: &str,
    sender: &str,
    ts: u64,
    attachment: Option<crate::protocol::SearchAttachment>,
    mentions: Vec<ruma::OwnedUserId>,
) -> crate::search::Document {
    crate::search::Document {
        event_id: EventId::parse(format!("${seed}")).expect("event id"),
        has_link: crate::search::document::contains_link(body),
        body: body.to_owned(),
        folded: String::new(),
        sender: ruma::UserId::parse(sender).expect("user id"),
        origin_server_ts: ts,
        attachments: attachment.into_iter().collect(),
        mentions,
        in_thread: false,
        edited_at: None,
        edit_id: None,
        encrypted: Some(false),
        media: Vec::new(),
        state: false,
    }
}

pub(super) fn filtered_index() -> (MessageIndex, ruma::OwnedRoomId) {
    let room = ruma::RoomId::parse("!filters:localhost").expect("room id");
    let index = MessageIndex::new();

    index.upsert(
        &room,
        document(
            "kris",
            "the deploy pipeline is broken",
            "@kris:localhost",
            1_000,
            None,
            Vec::new(),
        ),
    );
    index.upsert(
        &room,
        document(
            "alice",
            "deploy finished, see https://example.org/build",
            "@alice:localhost",
            2_000,
            None,
            vec![matrix_sdk::ruma::user_id!("@kris:localhost").to_owned()],
        ),
    );
    index.upsert(
        &room,
        document(
            "screenshot",
            "deploy screenshot.png",
            "@alice:localhost",
            3_000,
            Some(crate::protocol::SearchAttachment::Image),
            Vec::new(),
        ),
    );

    (index, room)
}

pub(super) fn picture(seed: &str, sender: &str, ts: u64) -> crate::search::Document {
    crate::search::Document {
        media: vec![(
            None,
            crate::protocol::RoomAttachmentContentView::Image {
                filename: format!("{seed}.png"),
                source: format!("mxc://localhost/{seed}"),
                mime: None,
                width: None,
                height: None,
                blurhash: None,
                thumbnail: None,
                spoiler: None,
            },
        )],
        ..document(
            seed,
            &format!("{seed}.png"),
            sender,
            ts,
            Some(crate::protocol::SearchAttachment::Image),
            Vec::new(),
        )
    }
}

pub(super) fn attachment_pages(
    index: &MessageIndex,
    room: &ruma::RoomId,
    not_senders: &[ruma::OwnedUserId],
    limit: usize,
) -> Vec<Vec<String>> {
    let mut pages = Vec::new();
    let mut before: Option<(u64, ruma::OwnedEventId)> = None;
    loop {
        let step = index.attachment_step(
            room,
            crate::protocol::RoomAttachmentKind::Media,
            not_senders,
            before
                .as_ref()
                .map(|(ts, event_id)| (*ts, event_id.as_str())),
            limit,
        );
        let (items, next) = match step {
            crate::search::store::PageStep::Done(items, next) => (items, next),
            crate::search::store::PageStep::Hydrate(_) => panic!("unexpected hydrate step"),
        };
        pages.push(
            items
                .into_iter()
                .map(|item| item.event_id.to_string())
                .collect(),
        );
        match next {
            Some(cursor) => before = Some(cursor),
            None => return pages,
        }
    }
}

pub(super) fn found(
    index: &MessageIndex,
    query: &str,
    filter: &crate::search::IndexFilter,
) -> Vec<String> {
    index
        .search(query, filter, crate::api::search::SearchOrder::Rank, 20, 0)
        .into_iter()
        .map(|hit| hit.event_id.to_string())
        .collect()
}

pub(super) async fn logged_in(
    server: &MatrixMockServer,
    client: &matrix_sdk::Client,
    account_id: &str,
) -> Arc<crate::Core> {
    let sync_service = Arc::new(
        matrix_sdk_ui::sync_service::SyncService::builder(client.clone())
            .build()
            .await
            .expect("sync service"),
    );
    let (core, _events) = crate::Core::new(
        account_id,
        Box::new(crate::store::MemorySessionStore::default()),
    );
    crate::test_support::set_session(
        &core,
        Some(crate::session::Session {
            account_id: account_id.to_owned(),
            client: client.clone(),
            sync_service,
            homeserver: server.server().uri(),
            oauth: false,
            state: Arc::default(),
        }),
    );
    core
}
