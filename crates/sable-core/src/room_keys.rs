use matrix_sdk::encryption::{KeyExportError, RoomKeyImportError};
use tempfile::NamedTempFile;

use crate::Core;
use crate::protocol::{CommandErr, CommandOk};

impl Core {
    pub(crate) async fn export_room_keys(&self, passphrase: &str) -> Result<CommandOk, CommandErr> {
        let client = self.client().await?;
        let file = self.room_key_file()?;

        client
            .encryption()
            .export_room_keys(file.path().to_owned(), passphrase, |_| true)
            .await
            .map_err(|error| self.failed("export_room_keys", error))?;

        let export = tokio::fs::read_to_string(file.path())
            .await
            .map_err(|error| self.failed("export_room_keys", error))?;

        Ok(CommandOk::ExportRoomKeys { export })
    }

    pub(crate) async fn import_room_keys(
        &self,
        export: &str,
        passphrase: &str,
    ) -> Result<CommandOk, CommandErr> {
        let client = self.client().await?;
        let file = self.room_key_file()?;

        tokio::fs::write(file.path(), export)
            .await
            .map_err(|error| self.failed("import_room_keys", error))?;

        let result = client
            .encryption()
            .import_room_keys(file.path().to_owned(), passphrase)
            .await
            .map_err(|error| self.room_key_import_error(error))?;

        Ok(CommandOk::ImportRoomKeys {
            imported: result.imported_count as u64,
            total: result.total_count as u64,
        })
    }

    fn room_key_file(&self) -> Result<NamedTempFile, CommandErr> {
        tempfile::Builder::new()
            .prefix(".room-keys-")
            .tempfile_in(&self.store_id)
            .map_err(|error| self.failed("room_key_file", error))
    }

    fn room_key_import_error(&self, error: RoomKeyImportError) -> CommandErr {
        match error {
            RoomKeyImportError::Export(KeyExportError::InvalidMac) => CommandErr::Denied,
            RoomKeyImportError::Export(_) => CommandErr::InvalidKeyExport,
            error => self.failed("import_room_keys", error),
        }
    }
}

#[cfg(test)]
#[allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::large_futures
)]
mod tests {
    use std::{sync::Arc, time::Duration};

    use futures_util::StreamExt;
    use matrix_sdk::{
        Client,
        ruma::{RoomId, owned_device_id, room_id, serde::Raw, user_id},
        test_utils::mocks::MatrixMockServer,
    };
    use matrix_sdk_base::crypto::{
        encrypt_room_key_export,
        olm::{
            Account, EncryptionSettings, ExportedRoomKey, InboundGroupSession,
            OutboundGroupSession, SenderData,
        },
        types::EventEncryptionAlgorithm,
        vodozemac::Ed25519PublicKey,
    };
    use matrix_sdk_test::JoinedRoomBuilder;
    use matrix_sdk_ui::{sync_service::SyncService, timeline::TimelineItem};
    use serde_json::json;
    use tempfile::TempDir;

    use crate::{
        Core,
        protocol::{CommandErr, CommandOk, TimelineFocusView},
        session::Session,
        store::MemorySessionStore,
        timelines::build_room_timeline,
    };

    const ELEMENT_EXPORT: &str = "-----BEGIN MEGOLM SESSION DATA-----
AWIEZVPUCHhsgGI7QxF6v7jY5mbnDpQkvE402UNF1lBfAAAD6D21Bj9tDCdiu+IdpF0gBVgsFZWmJEuuMjkO5ZBWbE9O1vVgqq3tdRP+Zo9oDKiTjr2WzaSk6oHoVDmd
UsVerHOMZnXBYN9PU3zpyxTBCS0juJDK64vDn5/hnRuXR80h16a1kMsGoF3FE/L3lL3zcq9D9UXspr8Sut5kXGRGt6YFCtOPg3V/uc4MVRb4b2zD3oJzncfDiJ3cbetJ
MBX7B4IP+aO41QIx0i9Ln1q3Hc9IO3JY5CoQ4a/bj0bWhWnKLXsId/XnDL3HD14tFQl1/KGaS0tQYRBO4c2OvjvG/B40WDjjhOBRMuJUSqSlu1p43PuSVx18Z5+CXh+y
98/0nBthvP6smQP7JbYMHkgIBC+ialXucJtWTojQ/fYjxlPyceffR7v0zSUDV09mxpB6xhsxulum74kayhNzJE+iACYgH1eZy7Jx1VRhyEcwIYrvDlF38apoU2KR/1yR
9dQ7ErNsfjjM1EAf5YCYzTXUxOOywlASWTzGSuYGEk1vZzhRwiHi+NyCTWgGWchHaptb+TqUzePn3YRKZv7IvhY2h3EGfYeje3jVdf+Yv17gB0qj4u+QbSX+xJZgqD3U
ngjgWgEDc8qQHBtDJPz+m+yphv/xZAFw4Wldrz8mal3cudGfUnueAlwgf2wvzk2ZCT+kfo95tRqyWuhFoaktz4LWw0nPwBUS3L7fk9x15Yeua4qF4U3BunaHPhp3k10=
-----END MEGOLM SESSION DATA-----";

    const ELEMENT_SESSION: &str = "gM8i47Xhu0q52xLfgUXzanCMpLinoyVyH7R58cBuVBU";

    async fn core_for(server: &MatrixMockServer) -> (Arc<Core>, Client, TempDir) {
        let client = server.client_builder().build().await;
        client.event_cache().subscribe().unwrap();
        let sync_service = Arc::new(SyncService::builder(client.clone()).build().await.unwrap());
        let store = tempfile::tempdir().unwrap();
        let (core, _events) = Core::new(
            store.path().to_str().unwrap(),
            Box::new(MemorySessionStore::default()),
        );
        *core.session.write().await = Some(Session {
            account_id: "a1".to_owned(),
            client: client.clone(),
            sync_service,
            homeserver: server.server().uri(),
            oauth: false,
        });
        (core, client, store)
    }

    async fn session_ids(client: &Client) -> Vec<String> {
        client
            .olm_machine_for_testing()
            .await
            .as_ref()
            .unwrap()
            .store()
            .export_room_keys(|_| true)
            .await
            .unwrap()
            .into_iter()
            .map(|key| key.session_id)
            .collect()
    }

    async fn import(core: &Core, export: &str, passphrase: &str) -> Result<(u64, u64), CommandErr> {
        match core.import_room_keys(export, passphrase).await? {
            CommandOk::ImportRoomKeys { imported, total } => Ok((imported, total)),
            other => panic!("unexpected response {other:?}"),
        }
    }

    fn outbound_session(room: &RoomId) -> (OutboundGroupSession, Ed25519PublicKey) {
        let keys = Account::new(user_id!("@sender:example.org")).identity_keys();
        let outbound = OutboundGroupSession::new(
            owned_device_id!("SENDER"),
            Arc::new(keys),
            room,
            EncryptionSettings::default(),
        )
        .unwrap();
        (outbound, keys.ed25519)
    }

    async fn exported(
        (outbound, signing_key): &(OutboundGroupSession, Ed25519PublicKey),
    ) -> ExportedRoomKey {
        InboundGroupSession::new(
            outbound.sender_key(),
            *signing_key,
            outbound.room_id(),
            &outbound.session_key().await,
            SenderData::unknown(),
            None,
            EventEncryptionAlgorithm::MegolmV1AesSha2,
            None,
            false,
        )
        .unwrap()
        .export()
        .await
    }

    #[tokio::test]
    async fn an_export_imports_into_another_device() {
        let server = MatrixMockServer::new().await;
        let (source, source_client, _source_store) = core_for(&server).await;
        let (target, target_client, _target_store) = core_for(&server).await;
        let outbound = outbound_session(room_id!("!keys:example.org"));
        source_client
            .olm_machine_for_testing()
            .await
            .as_ref()
            .unwrap()
            .store()
            .import_exported_room_keys(vec![exported(&outbound).await], |_, _| ())
            .await
            .unwrap();

        let CommandOk::ExportRoomKeys { export } =
            source.export_room_keys("correct horse").await.unwrap()
        else {
            panic!("unexpected response");
        };

        assert!(export.starts_with("-----BEGIN MEGOLM SESSION DATA-----"));
        assert!(
            export
                .trim_end()
                .ends_with("-----END MEGOLM SESSION DATA-----")
        );
        assert_eq!(
            import(&target, &export, "correct horse").await.unwrap(),
            (1, 1)
        );
        assert_eq!(session_ids(&target_client).await, [outbound.0.session_id()]);
        assert_eq!(
            import(&target, &export, "correct horse").await.unwrap(),
            (0, 1)
        );
    }

    #[tokio::test]
    async fn an_element_export_imports() {
        let server = MatrixMockServer::new().await;
        let (core, client, _store) = core_for(&server).await;

        assert_eq!(
            import(&core, ELEMENT_EXPORT, "element passphrase")
                .await
                .unwrap(),
            (1, 1)
        );
        assert_eq!(session_ids(&client).await, [ELEMENT_SESSION]);
    }

    #[tokio::test]
    async fn a_wrong_passphrase_is_denied_and_a_damaged_file_is_invalid() {
        let server = MatrixMockServer::new().await;
        let (core, client, store) = core_for(&server).await;

        assert!(matches!(
            import(&core, ELEMENT_EXPORT, "wrong").await,
            Err(CommandErr::Denied)
        ));
        assert!(matches!(
            import(&core, "not a key export", "element passphrase").await,
            Err(CommandErr::InvalidKeyExport)
        ));
        let damaged =
            "-----BEGIN MEGOLM SESSION DATA-----\nnot*base64\n-----END MEGOLM SESSION DATA-----";
        assert!(matches!(
            import(&core, damaged, "element passphrase").await,
            Err(CommandErr::InvalidKeyExport)
        ));
        assert!(session_ids(&client).await.is_empty());
        assert_eq!(std::fs::read_dir(store.path()).unwrap().count(), 0);
    }

    #[tokio::test]
    async fn an_import_redecrypts_what_the_timeline_already_shows() {
        let server = MatrixMockServer::new().await;
        let (core, client, _store) = core_for(&server).await;
        let room_id = room_id!("!encrypted:example.org");
        let outbound = outbound_session(room_id);
        let key = exported(&outbound).await;
        let content = outbound
            .0
            .encrypt(
                "m.room.message",
                &serde_json::from_value(json!({"msgtype": "m.text", "body": "from v1"})).unwrap(),
            )
            .await
            .content;
        let event = Raw::from_json_string(
            json!({"type": "m.room.encrypted", "event_id": "$utd",
                "sender": "@sender:example.org", "origin_server_ts": 1, "content": content})
            .to_string(),
        )
        .unwrap();

        server
            .mock_room_state_encryption()
            .encrypted()
            .mount()
            .await;
        let room = server
            .sync_room(
                &client,
                JoinedRoomBuilder::new(room_id).add_timeline_event(event),
            )
            .await;
        let timeline = build_room_timeline(&room, &TimelineFocusView::Live, false)
            .await
            .unwrap();
        let (items, mut stream) = timeline.subscribe().await;
        assert!(items.iter().any(|item| is_utd(item)));

        let export = encrypt_room_key_export(&[key], "v1", 1000).unwrap();
        assert_eq!(import(&core, &export, "v1").await.unwrap(), (1, 1));

        tokio::time::timeout(Duration::from_secs(5), async {
            while !timeline
                .items()
                .await
                .iter()
                .any(|item| body(item) == Some("from v1"))
            {
                stream.next().await.expect("open timeline stream");
            }
        })
        .await
        .expect("the imported key redecrypts the event");
    }

    fn is_utd(item: &TimelineItem) -> bool {
        item.as_event()
            .is_some_and(|event| event.content().is_unable_to_decrypt())
    }

    fn body(item: &TimelineItem) -> Option<&str> {
        Some(item.as_event()?.content().as_message()?.body())
    }
}
