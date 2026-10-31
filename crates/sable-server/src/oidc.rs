use openidconnect::{
    AuthorizationCode, ClientId, ClientSecret, CsrfToken, IssuerUrl, Nonce, PkceCodeChallenge,
    PkceCodeVerifier, RedirectUrl, TokenResponse,
    core::{CoreAuthenticationFlow, CoreClient, CoreProviderMetadata},
    reqwest,
};
use tokio::sync::Mutex;

const METADATA_TTL: std::time::Duration = std::time::Duration::from_hours(1);

pub(crate) struct Oidc {
    pub issuer: String,
    pub client_id: String,
    pub client_secret: String,
    pub redirect_uri: String,
    pub(crate) metadata: Mutex<Option<(std::time::Instant, CoreProviderMetadata)>>,
}

pub(crate) struct Transaction {
    pub state: String,
    pub nonce: String,
    pub verifier: String,
}

impl Oidc {
    fn http_client(&self) -> Result<reqwest::Client, Box<dyn std::error::Error + Send + Sync>> {
        let issuer = url::Url::parse(&self.issuer)?;
        Ok(reqwest::ClientBuilder::new()
            .user_agent(sable_core::USER_AGENT)
            .https_only(issuer.scheme() == "https")
            .redirect(reqwest::redirect::Policy::none())
            .timeout(std::time::Duration::from_secs(10))
            .build()?)
    }

    fn validate_endpoints(
        &self,
        metadata: &CoreProviderMetadata,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let local_provider = url::Url::parse(&self.issuer)?.scheme() == "http";
        let token = metadata
            .token_endpoint()
            .ok_or("missing OIDC token endpoint")?;
        if [
            metadata.authorization_endpoint().url(),
            token.url(),
            metadata.jwks_uri().url(),
        ]
        .into_iter()
        .all(|url| secure_endpoint(url, local_provider))
        {
            Ok(())
        } else {
            Err("OIDC endpoints must use HTTPS unless the issuer and endpoint are loopback".into())
        }
    }

    pub(crate) async fn start(
        &self,
    ) -> Result<(String, Transaction), Box<dyn std::error::Error + Send + Sync>> {
        let metadata = self.metadata().await?;
        let client = CoreClient::from_provider_metadata(
            metadata,
            ClientId::new(self.client_id.clone()),
            Some(ClientSecret::new(self.client_secret.clone())),
        )
        .set_redirect_uri(RedirectUrl::new(self.redirect_uri.clone())?);
        let (challenge, verifier) = PkceCodeChallenge::new_random_sha256();
        let (url, state, nonce) = client
            .authorize_url(
                CoreAuthenticationFlow::AuthorizationCode,
                CsrfToken::new_random,
                Nonce::new_random,
            )
            .set_pkce_challenge(challenge)
            .url();
        Ok((
            url.to_string(),
            Transaction {
                state: state.secret().to_owned(),
                nonce: nonce.secret().to_owned(),
                verifier: verifier.secret().to_owned(),
            },
        ))
    }

    pub(crate) async fn exchange(
        &self,
        code: String,
        transaction: Transaction,
    ) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
        let http = self.http_client()?;
        let metadata = self.metadata().await?;
        let client = CoreClient::from_provider_metadata(
            metadata,
            ClientId::new(self.client_id.clone()),
            Some(ClientSecret::new(self.client_secret.clone())),
        )
        .set_redirect_uri(RedirectUrl::new(self.redirect_uri.clone())?);
        let response = client
            .exchange_code(AuthorizationCode::new(code))?
            .set_pkce_verifier(PkceCodeVerifier::new(transaction.verifier))
            .request_async(&http)
            .await?;
        let token = response.id_token().ok_or("missing ID token")?;
        let nonce = Nonce::new(transaction.nonce);
        let claims = token.claims(&client.id_token_verifier(), &nonce)?;
        Ok(claims.subject().as_str().to_owned())
    }

    async fn metadata(
        &self,
    ) -> Result<CoreProviderMetadata, Box<dyn std::error::Error + Send + Sync>> {
        if let Some((created, metadata)) = self.metadata.lock().await.as_ref()
            && created.elapsed() < METADATA_TTL
        {
            return Ok(metadata.clone());
        }
        let http = self.http_client()?;
        let issuer = IssuerUrl::new(self.issuer.clone())?;
        let metadata = CoreProviderMetadata::discover_async(issuer, &http).await?;
        self.validate_endpoints(&metadata)?;
        let mut cached = self.metadata.lock().await;
        if let Some((created, previous)) = cached.as_ref()
            && created.elapsed() < METADATA_TTL
        {
            return Ok(previous.clone());
        }
        *cached = Some((std::time::Instant::now(), metadata.clone()));
        Ok(metadata)
    }
}

fn secure_endpoint(url: &url::Url, local_provider: bool) -> bool {
    let loopback = crate::config::is_loopback_url(url);
    url.username().is_empty()
        && url.password().is_none()
        && (url.scheme() == "https" || (local_provider && url.scheme() == "http" && loopback))
}

#[cfg(test)]
mod tests {
    use super::secure_endpoint;

    #[test]
    fn endpoint_transport_requires_https_outside_loopback_development() {
        for value in [
            "http://example.com/token",
            "http://127.0.0.1/token",
            "https://user:pass@example.com/token",
        ] {
            assert!(!secure_endpoint(&url::Url::parse(value).unwrap(), false));
        }
        assert!(secure_endpoint(
            &url::Url::parse("https://example.com/token").unwrap(),
            false
        ));
        assert!(secure_endpoint(
            &url::Url::parse("http://127.0.0.1/token").unwrap(),
            true
        ));
        assert!(!secure_endpoint(
            &url::Url::parse("http://example.com/token").unwrap(),
            true
        ));
    }
}
