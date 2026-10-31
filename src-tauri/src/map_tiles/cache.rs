use std::{fs, path::Path, time::SystemTime};

use http_cache_semantics::{AfterResponse, CacheOptions, CachePolicy, RequestLike, ResponseLike};
use serde::{Deserialize, Serialize};
use serde_with::{base64::Base64, serde_as};

#[serde_as]
#[derive(Deserialize, Serialize)]
pub(super) struct CachedTile {
    pub policy: CachePolicy,
    #[serde_as(as = "Base64")]
    pub body: Vec<u8>,
}

impl CachedTile {
    pub(super) fn revalidate(
        &self,
        request: &impl RequestLike,
        response: &impl ResponseLike,
        now: SystemTime,
    ) -> AfterResponse {
        match self.policy.after_response(request, response, now) {
            AfterResponse::NotModified(_, mut parts) => {
                // Version 3.0 only merges headers already present in the original response.
                let mut headers = response.headers().clone();
                for name in [
                    "content-length",
                    "content-encoding",
                    "transfer-encoding",
                    "content-range",
                ] {
                    headers.remove(name);
                }
                parts.headers.extend(headers);
                let policy = CachePolicy::new_options(
                    request,
                    &parts,
                    now,
                    CacheOptions {
                        shared: false,
                        ..CacheOptions::default()
                    },
                );
                AfterResponse::NotModified(policy, parts)
            }
            AfterResponse::Modified(policy, parts) => AfterResponse::Modified(policy, parts),
        }
    }

    pub(super) fn load(path: &Path) -> Option<Self> {
        serde_json::from_slice(&fs::read(path).ok()?).ok()
    }

    pub(super) fn load_policy(path: &Path) -> Option<CachePolicy> {
        #[derive(Deserialize)]
        struct Stored {
            policy: CachePolicy,
        }
        serde_json::from_slice::<Stored>(&fs::read(path).ok()?)
            .ok()
            .map(|stored| stored.policy)
    }

    pub(super) fn save(&self, path: &Path) -> Result<(), Box<dyn std::error::Error>> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        sable_core::store::write_atomic(path, &serde_json::to_vec(self)?)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use std::time::{Duration, SystemTime};

    use http_cache_semantics::{AfterResponse, BeforeRequest, CacheOptions};
    use tauri::http::{Request, Response, header};

    use super::*;

    #[test]
    fn stored_tiles_revalidate_with_the_origin_etag() {
        let request = Request::builder()
            .uri("https://tile.openstreetmap.org/1/0/0.png")
            .body(())
            .unwrap();
        let response = Response::builder()
            .header(header::CACHE_CONTROL, "max-age=60")
            .header(header::ETAG, "\"tile\"")
            .body(())
            .unwrap();
        let now = SystemTime::UNIX_EPOCH + Duration::from_secs(1_700_000_000);
        let policy = CachePolicy::new_options(
            &request,
            &response,
            now,
            CacheOptions {
                shared: false,
                ..CacheOptions::default()
            },
        );
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("tile.cache");
        CachedTile {
            policy,
            body: vec![0, 1, 254, 255],
        }
        .save(&path)
        .unwrap();
        let cached = CachedTile::load(&path).unwrap();
        assert_eq!(cached.body, [0, 1, 254, 255]);
        assert!(matches!(
            cached
                .policy
                .before_request(&request, now + Duration::from_secs(30)),
            BeforeRequest::Fresh(_)
        ));
        assert_eq!(
            cached.policy.time_to_live(now + Duration::from_secs(30)),
            Duration::from_secs(30)
        );
        let later = now + Duration::from_secs(61);
        let BeforeRequest::Stale {
            request: conditional,
            matches: true,
        } = cached.policy.before_request(&request, later)
        else {
            panic!("the expired tile must revalidate")
        };
        assert_eq!(conditional.headers[header::IF_NONE_MATCH], "\"tile\"");
        let unchanged = Response::builder()
            .status(304)
            .header(header::ETAG, "\"tile\"")
            .body(())
            .unwrap();
        let AfterResponse::NotModified(policy, _) =
            cached.revalidate(&conditional, &unchanged, later)
        else {
            panic!("304 must retain the cached body")
        };
        assert_eq!(policy.time_to_live(later), Duration::from_secs(60));
        let response = Response::builder()
            .status(304)
            .header(header::CACHE_CONTROL, "max-age=120")
            .header(header::ETAG, "\"tile\"")
            .body(())
            .unwrap();
        let AfterResponse::NotModified(policy, _) =
            cached.revalidate(&conditional, &response, later)
        else {
            panic!("304 must retain the cached body")
        };
        assert_eq!(policy.time_to_live(later), Duration::from_secs(120));
    }

    #[test]
    fn revalidation_honors_new_cache_headers_without_changing_body_metadata() {
        let request = Request::builder()
            .uri("https://tile.openstreetmap.org/1/0/0.png")
            .body(())
            .unwrap();
        let response = Response::builder()
            .header(header::ETAG, "\"tile\"")
            .header(header::CONTENT_LENGTH, "4")
            .body(())
            .unwrap();
        let now = SystemTime::UNIX_EPOCH + Duration::from_secs(1_700_000_000);
        let cached = CachedTile {
            policy: CachePolicy::new_options(
                &request,
                &response,
                now,
                CacheOptions {
                    shared: false,
                    ..CacheOptions::default()
                },
            ),
            body: vec![0, 1, 254, 255],
        };
        for (cache_control, storable, ttl) in [
            ("no-store", false, Duration::ZERO),
            ("max-age=120", true, Duration::from_secs(120)),
            ("no-cache, max-age=120", true, Duration::ZERO),
        ] {
            let response = Response::builder()
                .status(304)
                .header(header::ETAG, "\"tile\"")
                .header(header::CACHE_CONTROL, cache_control)
                .header(header::CONTENT_LENGTH, "0")
                .body(())
                .unwrap();
            let AfterResponse::NotModified(policy, parts) =
                cached.revalidate(&request, &response, now)
            else {
                panic!("304 must retain the cached body")
            };
            assert_eq!(policy.is_storable(), storable, "{cache_control}");
            assert_eq!(policy.time_to_live(now), ttl, "{cache_control}");
            assert_eq!(parts.headers[header::CONTENT_LENGTH], "4");
        }
    }

    #[test]
    fn corrupt_cache_entries_are_ignored() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("tile.cache");
        fs::write(&path, b"partial metadata").unwrap();
        assert!(CachedTile::load(&path).is_none());
    }
}
