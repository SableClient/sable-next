use matrix_sdk::reqwest::ClientBuilder;

#[cfg(not(target_os = "android"))]
pub(crate) const fn apply(builder: ClientBuilder) -> ClientBuilder {
    builder
}

#[cfg(target_os = "android")]
pub(crate) fn apply(builder: ClientBuilder) -> ClientBuilder {
    let Some(config) = client_config() else {
        return builder;
    };
    builder.tls_backend_preconfigured(config)
}

#[cfg(not(target_os = "android"))]
pub(crate) const fn apply_sdk(builder: matrix_sdk::ClientBuilder) -> matrix_sdk::ClientBuilder {
    builder
}

#[cfg(target_os = "android")]
pub(crate) fn apply_sdk(builder: matrix_sdk::ClientBuilder) -> matrix_sdk::ClientBuilder {
    let Ok(client) = apply(
        matrix_sdk::reqwest::Client::builder()
            .user_agent("matrix-rust-sdk")
            .timeout(std::time::Duration::from_secs(30)),
    )
    .build() else {
        return builder;
    };
    builder.http_client(client)
}

#[cfg(target_os = "android")]
fn client_config() -> Option<rustls::ClientConfig> {
    let provider = std::sync::Arc::new(rustls::crypto::aws_lc_rs::default_provider());
    let roots = rustls::RootCertStore {
        roots: webpki_roots::TLS_SERVER_ROOTS.to_vec(),
    };
    let mut config = rustls::ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .ok()?
        .with_root_certificates(roots)
        .with_no_client_auth();
    config.alpn_protocols = vec![b"h2".to_vec(), b"http/1.1".to_vec()];
    Some(config)
}
