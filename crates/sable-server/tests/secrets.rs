use sable_server::{Server, config::Config};

#[tokio::test]
async fn server_account_store_survives_restart() {
    if let Some(directory) = std::env::var_os("SABLE_TEST_SECRET_DIRECTORY") {
        let data_dir = std::path::PathBuf::from(directory);
        let config = Config {
            data_dir: data_dir.clone(),
            listen_addr: "127.0.0.1:0".into(),
            public_url: "http://127.0.0.1:18008".into(),
            client_ip_source: axum_client_ip::ClientIpSource::ConnectInfo,
            max_active_users: 128,
            allowed_private_cidrs: vec![],
            username: "test".into(),
            password_hash: None,
            oidc_issuer: None,
            oidc_client_id: None,
            oidc_client_secret: None,
            oidc_auto_provision: false,
            frontend_dir: "missing-frontend".into(),
        };
        let _server = Server::new(config).unwrap();
        let client = sable_core::session::build_client_at(
            data_dir.join("account").to_str().unwrap(),
            &url::Url::parse("http://127.0.0.1:12345").unwrap(),
            false,
        )
        .await
        .unwrap();
        assert!(
            std::fs::read_dir(data_dir.join("secrets"))
                .unwrap()
                .next()
                .is_some()
        );
        let store = client.state_store();
        if std::env::var_os("SABLE_TEST_SECRET_READ").is_some() {
            assert_eq!(
                store.get_custom_value(b"test").await.unwrap(),
                Some(b"saved".to_vec())
            );
        } else {
            store
                .set_custom_value(b"test", b"saved".to_vec())
                .await
                .unwrap();
        }
        return;
    }

    let directory = tempfile::tempdir().unwrap();
    for read in [false, true] {
        let mut child = std::process::Command::new(std::env::current_exe().unwrap());
        child
            .arg("--exact")
            .arg("server_account_store_survives_restart")
            .env("SABLE_TEST_SECRET_DIRECTORY", directory.path());
        if read {
            child.env("SABLE_TEST_SECRET_READ", "1");
        }
        assert!(child.status().unwrap().success());
    }
}
