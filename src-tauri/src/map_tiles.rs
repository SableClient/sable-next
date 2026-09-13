use std::{
    fs,
    path::{Path, PathBuf},
    sync::OnceLock,
    time::Duration,
};

use sable_core::reqwest::Client;
use tauri::{
    AppHandle, Manager, Runtime, UriSchemeContext, UriSchemeResponder,
    http::{HeaderValue, Request, Response, StatusCode, header},
};
use tokio::sync::Semaphore;

pub const TILE_URI_SCHEME: &str = "sable-tiles";

const TILE_ORIGIN: &str = "https://tile.openstreetmap.org";
const CACHE_SUBDIR: &str = "sable-tiles";
const CACHE_TTL: Duration = Duration::from_hours(24 * 7);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);
const MAX_CONCURRENT_REQUESTS: usize = 6;
const MAX_ZOOM: u32 = 19;

static CLIENT: OnceLock<Client> = OnceLock::new();
static LANE: Semaphore = Semaphore::const_new(MAX_CONCURRENT_REQUESTS);

#[allow(clippy::needless_pass_by_value)] // Tauri hands the handler both by value.
pub fn respond<R: Runtime>(
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

pub fn cleanup_cache<R: Runtime>(app: &AppHandle<R>) {
    let Ok(dir) = cache_dir(app) else { return };
    tauri::async_runtime::spawn_blocking(move || {
        for tile in walk_tiles(&dir) {
            if !is_fresh(&tile) {
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
    let cache_path = cache_dir(app).ok().map(|dir| tile.cache_path(&dir));

    if let Some(bytes) = cache_path.as_deref().and_then(read_fresh) {
        return Ok(tile_response(bytes));
    }

    let _permit = LANE
        .acquire()
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    let response = client(app)
        .get(tile.url())
        .send()
        .await
        .map_err(|_| StatusCode::BAD_GATEWAY)?;

    if !response.status().is_success() {
        return Err(StatusCode::BAD_GATEWAY);
    }
    if let Some(reason) = response.headers().get("x-blocked") {
        log::warn!("openstreetmap tile request blocked: {reason:?}");
        return Err(StatusCode::BAD_GATEWAY);
    }

    let bytes = response
        .bytes()
        .await
        .map_err(|_| StatusCode::BAD_GATEWAY)?
        .to_vec();

    if let Some(path) = cache_path {
        write_cache(&path, &bytes);
    }
    Ok(tile_response(bytes))
}

fn client<R: Runtime>(app: &AppHandle<R>) -> &'static Client {
    CLIENT.get_or_init(|| {
        let user_agent = format!(
            "Sable/{} (+https://app.sable.moe)",
            app.package_info().version
        );
        sable_core::tls::apply(
            Client::builder()
                .user_agent(user_agent)
                .connect_timeout(CONNECT_TIMEOUT)
                .timeout(REQUEST_TIMEOUT),
        )
        .build()
        .unwrap_or_else(|err| {
            log::error!("tile client build failed, tiles will be blocked: {err}");
            Client::default()
        })
    })
}

fn tile_response(bytes: Vec<u8>) -> Response<Vec<u8>> {
    let mut response = Response::new(bytes);
    let headers = response.headers_mut();
    headers.insert(header::CONTENT_TYPE, HeaderValue::from_static("image/png"));
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("public, max-age=604800"),
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

fn read_fresh(path: &Path) -> Option<Vec<u8>> {
    is_fresh(path).then(|| fs::read(path).ok()).flatten()
}

fn write_cache(path: &Path, bytes: &[u8]) {
    let Some(parent) = path.parent() else { return };
    if fs::create_dir_all(parent).is_err() {
        return;
    }
    let temp = path.with_extension("png.part");
    if fs::write(&temp, bytes).is_ok() && fs::rename(&temp, path).is_err() {
        let _ = fs::remove_file(&temp);
    }
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
