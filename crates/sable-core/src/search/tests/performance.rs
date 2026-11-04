use std::hint::black_box;
use std::time::Duration;

use criterion::Criterion;
use matrix_sdk::ruma::events::room::message::RoomMessageEventContentWithoutRelation;
use matrix_sdk::ruma::room_version_rules::RedactionRules;
use matrix_sdk::ruma::{EventId, room_id, user_id};
use matrix_sdk::test_utils::mocks::MatrixMockServer;
use matrix_sdk_test::event_factory::EventFactory;

use super::document;
use crate::search::document::FoldedTerms;
use crate::search::index::ColdWindow;
use crate::search::persist::StoredChunk;
use crate::search::{IndexFilter, MessageIndex};

#[test]
#[ignore = "manual Criterion benchmark"]
fn benchmark_cold_search_with_pending_edits() {
    let runtime = tokio::runtime::Runtime::new().unwrap();
    let room = room_id!("!benchmark:localhost").to_owned();
    let index = runtime.block_on(async {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;
        let _room = server.sync_joined_room(&client, &room).await;
        let (cache, _handles) = client.event_cache().unwrap().room(&room).await.unwrap();
        let factory = EventFactory::new()
            .room(&room)
            .sender(user_id!("@kris:localhost"));
        let edits = (0..250)
            .map(|number| {
                let target = EventId::parse(format!("$message{number}")).unwrap();
                let edit = EventId::parse(format!("$edit{number}")).unwrap();
                factory
                    .text_msg("* updated message")
                    .edit(
                        &target,
                        RoomMessageEventContentWithoutRelation::text_plain("updated message"),
                    )
                    .event_id(&edit)
                    .into_event()
            })
            .collect();
        let mut index = MessageIndex::new();
        index
            .ingest(&room, edits, &cache, &RedactionRules::V11)
            .await;
        index
    });
    drop(runtime);
    let stored = StoredChunk::new(
        (0..1000)
            .map(|number| {
                document(
                    &format!("message{number}"),
                    "original message",
                    "@kris:localhost",
                    number,
                    None,
                    Vec::new(),
                )
            })
            .collect(),
        Vec::new(),
    );
    let filter = IndexFilter::default();
    let terms = FoldedTerms::of(&filter, std::collections::HashSet::new());
    let mut criterion = Criterion::default()
        .without_plots()
        .warm_up_time(Duration::from_secs(1))
        .measurement_time(Duration::from_secs(2))
        .sample_size(20);
    criterion.bench_function(
        "search/cold_pending_edits_1000_messages_250_edits",
        |bench| {
            bench.iter(|| {
                black_box(index.scan_cold(
                    &room,
                    black_box(&stored),
                    "",
                    &filter,
                    &terms,
                    ColdWindow {
                        skip: 0,
                        take: 20,
                        context: 0,
                    },
                ))
            });
        },
    );
    criterion.final_summary();
}
