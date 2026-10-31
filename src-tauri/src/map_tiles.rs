use std::{
    fs,
    path::{Path, PathBuf},
    sync::OnceLock,
    time::{Duration, SystemTime},
};

use http_cache_semantics::{AfterResponse, BeforeRequest, CacheOptions, CachePolicy};
use sable_core::reqwest::Client;
use tauri::{
    AppHandle, Manager, Runtime, UriSchemeContext, UriSchemeResponder,
    http::{HeaderValue, Request, Response, StatusCode, header},
};
use tokio::sync::Semaphore;

mod cache;
use cache::CachedTile;

pub(crate) const TILE_URI_SCHEME: &str = "sable-tiles";

const TILE_ORIGIN: &str = "https://tile.openstreetmap.org";
const CACHE_SUBDIR: &str = "sable-tiles";
const CACHE_TTL: Duration = Duration::from_hours(24 * 7);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);
const MAX_CONCURRENT_REQUESTS: usize = 6;
const MAX_ZOOM: u32 = 19;

static CLIENT: OnceLock<Option<Client>> = OnceLock::new();
static LANE: Semaphore = Semaphore::const_new(MAX_CONCURRENT_REQUESTS);

#[expect(
    clippy::needless_pass_by_value,
    reason = "tauri hands the handler both by value"
)]
pub(crate) fn respond<R: Runtime>(
    ctx: UriSchemeContext<'_, R>,
    request: Request<Vec<u8>>,
    responder: UriSchemeResponder,
) {
    let app = ctx.app_handle().clone();
    let path = request.uri().path().to_owned();
    tauri::async_runtime::spawn(async move {
        responder.respond(
            handle_request(&app, &path)
                .await
                .unwrap_or_else(error_response),
        );
    });
}

pub(crate) fn cleanup_cache<R: Runtime>(app: &AppHandle<R>) {
    let Ok(dir) = cache_dir(app) else { return };
    tauri::async_runtime::spawn_blocking(move || {
        for tile in walk_tiles(&dir) {
            let fresh = CachedTile::load_policy(&tile)
                .is_some_and(|policy| !policy.is_stale(SystemTime::now()));
            if !fresh && !is_fresh(&tile) {
                let _ = fs::remove_file(tile);
            }
        }
    });
}

struct Tile {
    z: u32,
    x: u32,
    y: u32,
}

impl Tile {
    fn parse(path: &str) -> Option<Self> {
        let mut segments = path.trim_start_matches('/').split('/');
        let z: u32 = segments.next()?.parse().ok()?;
        let x: u32 = segments.next()?.parse().ok()?;
        let y: u32 = segments.next()?.strip_suffix(".png")?.parse().ok()?;
        if segments.next().is_some() || z > MAX_ZOOM {
            return None;
        }
        let span = 1u32 << z;
        (x < span && y < span).then_some(Self { z, x, y })
    }

    fn url(&self) -> String {
        format!("{TILE_ORIGIN}/{}/{}/{}.png", self.z, self.x, self.y)
    }

    fn cache_path(&self, dir: &Path) -> PathBuf {
        dir.join(self.z.to_string())
            .join(self.x.to_string())
            .join(format!("{}.png", self.y))
    }
}

async fn handle_request<R: Runtime>(
    app: &AppHandle<R>,
    path: &str,
) -> Result<Response<Vec<u8>>, StatusCode> {
    let tile = Tile::parse(path).ok_or(StatusCode::NOT_FOUND)?;
    let legacy_path = cache_dir(app).ok().map(|dir| tile.cache_path(&dir));
    let cache_path = legacy_path
        .as_ref()
        .map(|path| path.with_extension("cache"));
    let mut cached = match cache_path.clone() {
        Some(path) => blocking(move || CachedTile::load(&path)).await,
        None => None,
    };
    let client = client().ok_or(StatusCode::SERVICE_UNAVAILABLE)?;
    let mut request = client
        .get(tile.url())
        .build()
        .map_err(|_| StatusCode::BAD_GATEWAY)?;

    if let Some(tile) = cached.as_ref() {
        match tile.policy.before_request(&request, SystemTime::now()) {
            BeforeRequest::Fresh(_) => {
                return Ok(tile_response(
                    tile.body.clone(),
                    Some(tile.policy.time_to_live(SystemTime::now())),
                ));
            }
            BeforeRequest::Stale {
                request: conditional,
                matches,
            } => {
                *request.headers_mut() = conditional.headers;
                if !matches {
                    cached = None;
                }
            }
        }
    } else if let Some(path) = legacy_path
        && let Some((bytes, remaining)) = blocking(move || read_fresh(&path)).await
    {
        return Ok(tile_response(bytes, Some(remaining)));
    }

    let _permit = LANE
        .acquire()
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    let response = client
        .execute(request.try_clone().ok_or(StatusCode::BAD_GATEWAY)?)
        .await
        .map_err(|_| StatusCode::BAD_GATEWAY)?;

    if let Some(reason) = response.headers().get("x-blocked") {
        log::warn!("openstreetmap tile request blocked: {reason:?}");
        return Err(StatusCode::BAD_GATEWAY);
    }

    let now = SystemTime::now();
    let (policy, reused) = if let Some(tile) = cached {
        match tile.revalidate(&request, &response, now) {
            AfterResponse::NotModified(policy, _) => (policy, Some(tile.body)),
            AfterResponse::Modified(policy, _) => (policy, None),
        }
    } else {
        (
            CachePolicy::new_options(
                &request,
                &response,
                now,
                CacheOptions {
                    shared: false,
                    ..CacheOptions::default()
                },
            ),
            None,
        )
    };
    let bytes = match reused {
        Some(bytes) => bytes,
        None if response.status().is_success() => response
            .bytes()
            .await
            .map_err(|_| StatusCode::BAD_GATEWAY)?
            .to_vec(),
        None => return Err(StatusCode::BAD_GATEWAY),
    };
    let lifetime = policy
        .is_storable()
        .then(|| policy.time_to_live(SystemTime::now()));

    if let Some(path) = cache_path {
        let entry = policy.is_storable().then(|| CachedTile {
            policy,
            body: bytes.clone(),
        });
        persist(path, entry);
    }
    Ok(tile_response(bytes, lifetime))
}

fn persist(path: PathBuf, entry: Option<CachedTile>) {
    tauri::async_runtime::spawn_blocking(move || match entry {
        Some(entry) => {
            if let Err(err) = entry.save(&path) {
                log::debug!("tile cache write failed: {err}");
            }
        }
        None => {
            if let Err(err) = fs::remove_file(&path) {
                log::debug!("tile cache removal failed: {err}");
            }
        }
    });
}

async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Option<T> + Send + 'static,
) -> Option<T> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .ok()
        .flatten()
}

fn client() -> Option<&'static Client> {
    CLIENT
        .get_or_init(|| {
            sable_core::tls::apply(Client::builder())
                .user_agent(format!("{} (+https://sable.moe)", sable_core::USER_AGENT))
                .connect_timeout(CONNECT_TIMEOUT)
                .timeout(REQUEST_TIMEOUT)
                .build()
                .inspect_err(|err| {
                    log::error!("tile client build failed, tiles will be blocked: {err}");
                })
                .ok()
        })
        .as_ref()
}

fn tile_response(bytes: Vec<u8>, lifetime: Option<Duration>) -> Response<Vec<u8>> {
    let mut response = Response::new(bytes);
    let headers = response.headers_mut();
    headers.insert(header::CONTENT_TYPE, HeaderValue::from_static("image/png"));
    headers.insert(
        header::CACHE_CONTROL,
        lifetime
            .and_then(|lifetime| {
                HeaderValue::from_str(&format!("public, max-age={}", lifetime.as_secs())).ok()
            })
            .unwrap_or_else(|| HeaderValue::from_static("no-store")),
    );
    response
}

fn error_response(status: StatusCode) -> Response<Vec<u8>> {
    let mut response = Response::new(Vec::new());
    *response.status_mut() = status;
    response
}

fn cache_dir<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    app.path()
        .app_cache_dir()
        .map(|dir| dir.join(CACHE_SUBDIR))
        .map_err(|err| err.to_string())
}

fn is_fresh(path: &Path) -> bool {
    let Ok(modified) = fs::metadata(path).and_then(|meta| meta.modified()) else {
        return false;
    };
    modified.elapsed().is_ok_and(|age| age < CACHE_TTL)
}

fn read_fresh(path: &Path) -> Option<(Vec<u8>, Duration)> {
    let age = fs::metadata(path).ok()?.modified().ok()?.elapsed().ok()?;
    let remaining = CACHE_TTL.checked_sub(age)?;
    Some((fs::read(path).ok()?, remaining))
}

fn walk_tiles(dir: &Path) -> Vec<PathBuf> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    entries
        .flatten()
        .flat_map(|entry| {
            let path = entry.path();
            if path.is_dir() {
                walk_tiles(&path)
            } else {
                vec![path]
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::Tile;

    #[test]
    fn parses_tile_paths() {
        let tile = Tile::parse("/16/33202/22539.png").expect("valid tile path");
        assert_eq!((tile.z, tile.x, tile.y), (16, 33202, 22539));
    }

    #[test]
    fn rejects_non_tile_paths() {
        for path in [
            "/",
            "/16/33202",
            "/16/33202/22539.jpg",
            "/16/33202/22539.png/extra",
            "/20/1/1.png",
            "/2/4/1.png",
            "/../../etc/passwd",
        ] {
            assert!(Tile::parse(path).is_none(), "{path} should not parse");
        }
    }
}
