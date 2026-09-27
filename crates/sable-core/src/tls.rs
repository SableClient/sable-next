use matrix_sdk::reqwest::ClientBuilder;

#[cfg(not(target_family = "wasm"))]
static PROXY: std::sync::OnceLock<String> = std::sync::OnceLock::new();

/// # Errors
///
/// When `url` is not a proxy `reqwest` can use, or a proxy was already set.
#[cfg(not(target_family = "wasm"))]
pub fn set_proxy(url: &str) -> Result<(), String> {
    matrix_sdk::reqwest::Proxy::all(url).map_err(|error| error.to_string())?;
    PROXY
        .set(url.to_owned())
        .map_err(|_| "the proxy is already set".to_owned())
}

#[cfg(not(target_family = "wasm"))]
fn with_proxy(builder: ClientBuilder) -> ClientBuilder {
    match PROXY.get().map(matrix_sdk::reqwest::Proxy::all) {
        Some(Ok(proxy)) => builder.proxy(proxy),
        _ => builder,
    }
}

#[cfg(all(not(target_os = "android"), not(target_family = "wasm")))]
#[must_use = "returns the configured builder"]
pub fn apply(builder: ClientBuilder) -> ClientBuilder {
    with_proxy(builder)
}

#[cfg(target_family = "wasm")]
#[must_use = "returns the configured builder"]
pub const fn apply(builder: ClientBuilder) -> ClientBuilder {
    builder
}

#[cfg(target_os = "android")]
#[must_use = "returns the configured builder"]
pub fn apply(builder: ClientBuilder) -> ClientBuilder {
    let builder = with_proxy(builder);
    let Some(config) = client_config() else {
        return builder;
    };
    builder.tls_backend_preconfigured(config)
}

#[cfg(all(not(target_os = "android"), not(target_family = "wasm")))]
pub(crate) fn apply_sdk(builder: matrix_sdk::ClientBuilder) -> matrix_sdk::ClientBuilder {
    match PROXY.get() {
        Some(url) => builder.proxy(url),
        None => builder,
    }
}

#[cfg(target_family = "wasm")]
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
