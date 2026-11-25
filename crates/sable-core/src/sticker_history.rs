use sable_model::emote_picker::RecentUse;
use serde_json::Value;

use crate::SignedIn;
use crate::protocol::RpcError;
use crate::usage_history::Kind;

/// Not `m.recent_emoji`, or stickers would show in other clients' emoji pickers.
const STICKERS: Kind = Kind {
    event_type: "moe.sable.next.sticker_history",
    store_key: b"sable.sticker_history",
    list: "recent_stickers",
    key: "sticker",
    limit: 32,
    sealed: true,
    accepts: |key| !key.is_empty(),
    identity: str::to_owned,
};

fn recent_uses(entries: &[Value], now: u64) -> Vec<RecentUse> {
    let count = |count: u64| u32::try_from(count).unwrap_or(u32::MAX);
    entries
        .iter()
        .filter_map(|entry| {
            let (key, (uses, total)) = STICKERS.frequency(entry, now)?;
            Some(RecentUse {
                key: key.to_owned(),
                uses: count(uses),
                total: count(total),
            })
        })
        .collect()
}

impl SignedIn {
    /// `legacy` is this device's old list and `synced` the one older builds still share.
    pub(crate) async fn recent_stickers(
        &self,
        sync: bool,
        legacy: &[String],
        synced: Option<&[String]>,
    ) -> Result<Vec<RecentUse>, RpcError> {
        let entries = self
            .update_usage_history(&STICKERS, sync, |history| {
                history.seed(&STICKERS, legacy);
                if let Some(list) = synced {
                    history.follow(&STICKERS, list);
                }
            })
            .await?;
        Ok(recent_uses(&entries, crate::now_ms()))
    }

    pub(crate) async fn remember_sticker(&self, key: &str, sync: bool) -> Result<(), RpcError> {
        self.remember_use(&STICKERS, key, sync).await
    }
}

#[cfg(test)]
#[cfg(not(target_family = "wasm"))]
mod tests {
    use matrix_sdk::test_utils::mocks::MatrixMockServer;
    use serde_json::{Value, json};
    use wiremock::{
        Mock, MockGuard, ResponseTemplate,
        matchers::{method, path_regex},
    };

    use super::*;
    use crate::sealed_account_data::{AccountDataKey, cache_key};
    use crate::usage_history::testing::{signed_in, uploads};
    use crate::usage_history::undated;

    async fn stored(server: &MatrixMockServer, content: Option<Value>) -> MockGuard {
        let response = content.map_or_else(
            || {
                ResponseTemplate::new(404)
                    .set_body_json(json!({"errcode": "M_NOT_FOUND", "error": "none"}))
            },
            |content| ResponseTemplate::new(200).set_body_json(content),
        );
        Mock::given(method("GET"))
            .and(path_regex("/account_data/moe.sable.next.sticker_history$"))
            .respond_with(response)
            .mount_as_scoped(server.server())
            .await
    }

    async fn writable(server: &MatrixMockServer) {
        Mock::given(method("PUT"))
            .and(path_regex("/account_data/moe.sable.next.sticker_history$"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({})))
            .mount(server.server())
            .await;
    }

    fn document(entries: &[(&str, u32)]) -> Value {
        let entries: Vec<Value> = entries
            .iter()
            .map(|(key, total)| json!({"sticker": key, "total": total}))
            .collect();
        json!({"recent_stickers": entries})
    }

    fn shown(recent: &[RecentUse]) -> Vec<(&str, u32)> {
        recent
            .iter()
            .map(|recent| (recent.key.as_str(), recent.total))
            .collect()
    }

    fn keys(keys: &[&str]) -> Vec<String> {
        keys.iter().map(|key| (*key).to_owned()).collect()
    }

    #[tokio::test]
    async fn nothing_leaves_the_device_until_settings_sync_is_on() {
        let server = MatrixMockServer::new().await;
        let core = signed_in(&server).await;
        let session = core.signed_in().unwrap();
        session.remember_sticker("wave", false).await.unwrap();
        session.remember_sticker("wave", false).await.unwrap();
        let local = session
            .recent_stickers(false, &keys(&["party"]), None)
            .await;
        assert_eq!(shown(&local.unwrap()), [("wave", 2), ("party", 1)]);
        let requests = server.server().received_requests().await.unwrap();
        assert!(
            !requests
                .iter()
                .any(|request| request.url.path().contains("sticker_history"))
        );

        let _stored = stored(&server, Some(document(&[("cat", 7), ("wave", 4)]))).await;
        writable(&server).await;
        session.recent_stickers(true, &[], None).await.unwrap();
        assert_eq!(
            uploads(&server).await,
            [document(&[("wave", 6), ("cat", 7), ("party", 1)])]
        );
    }

    #[tokio::test]
    async fn two_devices_keep_both_counts() {
        let server = MatrixMockServer::new().await;
        let core = signed_in(&server).await;
        let session = core.signed_in().unwrap();
        let before = stored(&server, Some(document(&[("wave", 1)]))).await;
        session.recent_stickers(true, &[], None).await.unwrap();
        drop(before);

        let _after = stored(&server, Some(document(&[("party", 5), ("wave", 3)]))).await;
        writable(&server).await;
        session.remember_sticker("wave", true).await.unwrap();
        assert_eq!(
            uploads(&server).await,
            [document(&[("wave", 4), ("party", 5)])]
        );
    }

    #[tokio::test]
    async fn an_older_builds_list_migrates_in_order_then_adds_its_new_picks_in_front() {
        let server = MatrixMockServer::new().await;
        let core = signed_in(&server).await;
        let session = core.signed_in().unwrap();
        writable(&server).await;
        let empty = stored(&server, None).await;
        let list = keys(&["wave", "party"]);
        session
            .recent_stickers(true, &[], Some(&list))
            .await
            .unwrap();
        let migrated = document(&[("wave", 1), ("party", 1)]);
        assert_eq!(uploads(&server).await, std::slice::from_ref(&migrated));
        drop(empty);

        let _stored = stored(&server, Some(migrated)).await;
        let list = keys(&["cat", "wave", "party"]);
        let recent = session
            .recent_stickers(true, &[], Some(&list))
            .await
            .unwrap();
        assert_eq!(shown(&recent), [("cat", 1), ("wave", 1), ("party", 1)]);
    }

    #[tokio::test]
    async fn a_stale_list_does_not_bring_back_what_was_dropped() {
        let server = MatrixMockServer::new().await;
        let core = signed_in(&server).await;
        let session = core.signed_in().unwrap();
        let list = keys(&["wave", "dropped"]);
        let before = stored(&server, Some(document(&[("wave", 1), ("dropped", 1)]))).await;
        session
            .recent_stickers(true, &[], Some(&list))
            .await
            .unwrap();
        drop(before);

        let _after = stored(&server, Some(document(&[("wave", 2)]))).await;
        writable(&server).await;
        let recent = session
            .recent_stickers(true, &[], Some(&list))
            .await
            .unwrap();
        assert_eq!(shown(&recent), [("wave", 2)]);
        assert_eq!(uploads(&server).await, Vec::<Value>::new());
    }

    #[tokio::test]
    async fn a_locked_history_is_never_overwritten() {
        let server = MatrixMockServer::new().await;
        let core = signed_in(&server).await;
        let session = core.signed_in().unwrap();
        let key = AccountDataKey::from_bytes([7; 32]);
        let sealed = key
            .seal(STICKERS.event_type, &document(&[("cat", 7)]))
            .unwrap();
        let _stored = stored(&server, Some(sealed)).await;
        writable(&server).await;
        session.remember_sticker("wave", true).await.unwrap();
        assert_eq!(uploads(&server).await, Vec::<Value>::new());

        cache_key(&core.signed_in().unwrap().client().clone(), &key).await;
        session.recent_stickers(true, &[], None).await.unwrap();
        let written = uploads(&server).await;
        assert_eq!(
            key.open(STICKERS.event_type, written.first().unwrap())
                .map(undated),
            Some(document(&[("wave", 1), ("cat", 7)]))
        );
    }

    #[tokio::test]
    async fn plain_history_is_sealed_once_there_is_a_key() {
        let server = MatrixMockServer::new().await;
        let core = signed_in(&server).await;
        let session = core.signed_in().unwrap();
        let key = AccountDataKey::from_bytes([7; 32]);
        cache_key(&core.signed_in().unwrap().client().clone(), &key).await;
        let _stored = stored(&server, Some(document(&[("cat", 7)]))).await;
        writable(&server).await;
        session.recent_stickers(true, &[], None).await.unwrap();
        let written = uploads(&server).await;
        assert_eq!(
            key.open(STICKERS.event_type, written.first().unwrap())
                .map(undated),
            Some(document(&[("cat", 7)]))
        );
    }

    #[tokio::test]
    async fn switching_accounts_mid_request_does_not_cross_histories() {
        let (first, second) = (MatrixMockServer::new().await, MatrixMockServer::new().await);
        let core = signed_in(&first).await;
        let other = signed_in(&second).await;
        writable(&first).await;
        writable(&second).await;
        let _read = Mock::given(method("GET"))
            .and(path_regex("/account_data/moe.sable.next.sticker_history$"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_delay(std::time::Duration::from_millis(300))
                    .set_body_json(document(&[("cat", 7)])),
            )
            .mount_as_scoped(first.server())
            .await;
        let session = core.signed_in().unwrap();
        let switch = async {
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            crate::test_support::set_session(&core, other.session.snapshot());
        };
        let (picked, ()) = tokio::join!(session.remember_sticker("wave", true), switch);
        picked.unwrap();
        assert_eq!(
            uploads(&first).await,
            [document(&[("wave", 1), ("cat", 7)])]
        );
        assert_eq!(uploads(&second).await, Vec::<Value>::new());
    }
}
