use std::sync::{Arc, Mutex};
use std::time::Duration;

use matrix_sdk::ruma::{device_id, owned_user_id};
use matrix_sdk::test_utils::mocks::{MatrixMockServer, encryption::PendingToDeviceMessages};
use matrix_sdk_ui::sync_service::SyncService;
use tokio::sync::mpsc;

use crate::{
    Core,
    protocol::{Command, CoreEvent, VerificationView},
    session::Session,
    store::MemorySessionStore,
};

struct Device {
    client: matrix_sdk::Client,
    core: Arc<Core>,
    events: mpsc::UnboundedReceiver<CoreEvent>,
    states: Vec<(String, VerificationView)>,
}

impl Device {
    fn drain(&mut self) {
        while let Ok(event) = self.events.try_recv() {
            if let CoreEvent::Verification { flow_id, state, .. } = event {
                self.states.push((flow_id, state));
            }
        }
    }

    fn last_live(&self) -> Option<&(String, VerificationView)> {
        self.states.iter().rev().find(|(flow_id, _)| {
            !self.states.iter().any(|(cancelled, state)| {
                cancelled == flow_id && matches!(state, VerificationView::Cancelled { .. })
            })
        })
    }
}

#[allow(clippy::unwrap_used)]
async fn device(server: &MatrixMockServer, id: &str) -> Device {
    let client = server
        .client_builder_for_crypto_end_to_end(
            &owned_user_id!("@alice:example.org"),
            <&matrix_sdk::ruma::DeviceId>::from(id),
        )
        .build()
        .await;
    let sync_service = Arc::new(SyncService::builder(client.clone()).build().await.unwrap());
    let (core, events) = Core::new(id, Box::new(MemorySessionStore::default()));
    *core.session.write().await = Some(Session {
        account_id: id.into(),
        client: client.clone(),
        sync_service,
        homeserver: server.server().uri(),
        oauth: false,
    });
    core.watch_incoming_verifications(&client);
    Device {
        client,
        core,
        events,
        states: Vec::new(),
    }
}

async fn deliver(
    server: &MatrixMockServer,
    queue: &Arc<Mutex<PendingToDeviceMessages>>,
    devices: &mut [&mut Device],
) {
    for _ in 0..10 {
        tokio::time::sleep(Duration::from_millis(50)).await;
        for device in devices.iter_mut() {
            let pending = {
                let mut queue = queue
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                device
                    .client
                    .user_id()
                    .and_then(|user_id| queue.get_mut(user_id))
                    .and_then(|devices| devices.remove(device.client.device_id()?))
                    .unwrap_or_default()
            };
            for message in pending {
                server
                    .mock_sync()
                    .ok_and_run(&device.client, |sync| {
                        sync.add_to_device_event(message.deserialize_as().unwrap_or_default());
                    })
                    .await;
            }
            device.drain();
        }
    }
}

#[allow(clippy::unwrap_used)]
async fn two_devices(
    server: &MatrixMockServer,
    cross_signed: bool,
) -> (Device, Device, Arc<Mutex<PendingToDeviceMessages>>) {
    server.mock_crypto_endpoints_preset().await;
    let old = device(server, "AAAAAAAA").await;
    let new = device(server, "BBBBBBBB").await;

    server.mock_sync().ok_and_run(&old.client, |_| {}).await;
    if cross_signed {
        old.client
            .encryption()
            .bootstrap_cross_signing(None)
            .await
            .unwrap();
    }
    server.mock_sync().ok_and_run(&new.client, |_| {}).await;
    let user_id = old.client.user_id().unwrap().to_owned();
    for device in [&old, &new] {
        server
            .mock_sync()
            .ok_and_run(&device.client, |sync| {
                sync.add_change_device(&user_id);
            })
            .await;
        server.mock_sync().ok_and_run(&device.client, |_| {}).await;
    }

    let queue = Arc::new(Mutex::new(PendingToDeviceMessages::default()));
    (old, new, queue)
}

#[allow(clippy::unwrap_used)]
#[tokio::test]
async fn crossed_self_verification_requests_are_cancelled_without_retrying() {
    let server = MatrixMockServer::new().await;
    let (mut old, mut new, queue) = two_devices(&server, false).await;
    let user_id = old.client.user_id().unwrap().to_owned();
    let _traffic = server
        .capture_put_to_device_traffic(&user_id, queue.clone())
        .await;

    old.core
        .dispatch(Command::RequestVerification {
            user_id: user_id.clone(),
            device_id: Some(device_id!("BBBBBBBB").to_owned()),
        })
        .await
        .unwrap();
    new.core
        .dispatch(Command::RequestVerification {
            user_id: user_id.clone(),
            device_id: Some(device_id!("AAAAAAAA").to_owned()),
        })
        .await
        .unwrap();

    deliver(&server, &queue, &mut [&mut old, &mut new]).await;

    for device in [&old, &new] {
        assert!(device.last_live().is_none(), "{:?}", device.states);
        assert!(
            device
                .states
                .iter()
                .any(|(_, state)| matches!(state, VerificationView::Cancelled { .. })),
            "{:?}",
            device.states
        );
    }
}

#[allow(clippy::unwrap_used)]
#[tokio::test]
async fn a_self_verification_offers_a_qr_code_both_ways() {
    let server = MatrixMockServer::new().await;
    let (mut old, mut new, queue) = two_devices(&server, true).await;
    let user_id = old.client.user_id().unwrap().to_owned();
    let _traffic = server
        .capture_put_to_device_traffic(&user_id, queue.clone())
        .await;

    new.core
        .dispatch(Command::RequestVerification {
            user_id: user_id.clone(),
            device_id: Some(device_id!("AAAAAAAA").to_owned()),
        })
        .await
        .unwrap();
    deliver(&server, &queue, &mut [&mut old, &mut new]).await;

    let (flow_id, _) = old.last_live().unwrap().clone();
    old.core
        .dispatch(Command::AcceptVerification {
            user_id: user_id.clone(),
            flow_id,
        })
        .await
        .unwrap();
    deliver(&server, &queue, &mut [&mut old, &mut new]).await;

    for device in [&old, &new] {
        let (_, state) = device.last_live().unwrap();
        assert!(
            matches!(
                state,
                VerificationView::Choose {
                    qr: Some(_),
                    can_scan: true,
                    can_compare: true,
                }
            ),
            "{state:?}"
        );
    }
}
