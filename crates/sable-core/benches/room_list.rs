//! Rebuilding room list rows for a sync update that changed no room.
//!
//! Run with `cargo bench -p sable-core --bench room_list`.

#![expect(clippy::expect_used, reason = "benchmark setup")]

use std::collections::HashMap;
use std::hint::black_box;

use criterion::{BenchmarkId, Criterion, criterion_group, criterion_main};
use matrix_sdk::test_utils::mocks::MatrixMockServer;
use matrix_sdk_test::event_factory::EventFactory;
use matrix_sdk_test::{JoinedRoomBuilder, User};
use matrix_sdk_ui::eyeball_im::VectorDiff;
use matrix_sdk_ui::room_list_service::RoomListItem;
use tokio::runtime::Runtime;

async fn rooms(server: &MatrixMockServer, count: usize) -> Vec<VectorDiff<RoomListItem>> {
    let client = server.client_builder().build().await;
    let mut diffs = Vec::with_capacity(count);
    for index in 0..count {
        let room_id = matrix_sdk::ruma::OwnedRoomId::try_from(format!("!room{index}:example.org"))
            .expect("valid room id");
        let avatar = matrix_sdk::ruma::OwnedMxcUri::from(format!("mxc://example.org/{index}"));
        let factory = EventFactory::new().room(&room_id).sender(User::Alice);
        let room = server
            .sync_room(
                &client,
                JoinedRoomBuilder::new(&room_id)
                    .add_state_event(factory.room_avatar().url(&avatar)),
            )
            .await;
        diffs.push(VectorDiff::Set {
            index,
            value: RoomListItem::from(room),
        });
    }
    diffs
}

fn unchanged_rooms(c: &mut Criterion) {
    let runtime = Runtime::new().expect("tokio runtime");
    let mut group = c.benchmark_group("room_list/unchanged_update");
    for count in [100, 500] {
        let (_server, diffs, mut cache) = runtime.block_on(async {
            let server = MatrixMockServer::new().await;
            let diffs = rooms(&server, count).await;
            let mut cache = HashMap::new();
            sable_core::view::enrich_room_batch(&diffs, &mut cache).await;
            (server, diffs, cache)
        });
        group.bench_function(BenchmarkId::from_parameter(count), |b| {
            b.iter(|| {
                runtime.block_on(sable_core::view::enrich_room_batch(
                    black_box(&diffs),
                    &mut cache,
                ));
            });
        });
    }
    group.finish();
}

criterion_group!(benches, unchanged_rooms);
criterion_main!(benches);
