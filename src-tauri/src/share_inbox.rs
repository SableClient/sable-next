use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::ipc::Response;
use tauri::{AppHandle, Runtime};

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ShareItem {
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mime: Option<String>,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ShareTarget {
    pub user_id: String,
    pub room_id: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ShareBatch {
    pub batch_id: String,
    pub items: Vec<ShareItem>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target: Option<ShareTarget>,
}

/// Written by `MainActivity.kt` and the iOS `ShareViewController.swift`.
const SHARE_MANIFEST_VERSION: u32 = 1;

#[derive(Deserialize)]
struct ShareManifest {
    version: u32,
    items: Vec<ShareItem>,
    #[serde(default)]
    target: Option<ShareTarget>,
}

fn validate_component(value: &str) -> Result<(), String> {
    if value.is_empty() || value == "." || value == ".." || value.contains(['/', '\\', '\0']) {
        return Err(format!("invalid path component: {value:?}"));
    }
    Ok(())
}

fn parse_manifest(json: &str) -> Result<ShareManifest, String> {
    let manifest: ShareManifest = serde_json::from_str(json).map_err(|err| err.to_string())?;
    if manifest.version != SHARE_MANIFEST_VERSION {
        return Err(format!(
            "unsupported share manifest version {}",
            manifest.version
        ));
    }
    Ok(manifest)
}

/// The share extension writes into the App Group container, the only directory both can reach.
#[cfg(target_os = "ios")]
fn inbox_root<R: Runtime>(_app: &AppHandle<R>) -> Result<PathBuf, String> {
    Ok(crate::ios::shared_store_dir()?.join("share_inbox"))
}

#[cfg(not(target_os = "ios"))]
fn inbox_root<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    use tauri::Manager as _;
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|err| err.to_string())?
        .join("share_inbox"))
}

#[tauri::command]
pub(crate) async fn share_inbox_drain<R: Runtime>(
    app: AppHandle<R>,
) -> Result<Vec<ShareBatch>, String> {
    let root = inbox_root(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let entries = match std::fs::read_dir(&root) {
            Ok(entries) => entries,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(err) => return Err(err.to_string()),
        };

        let mut batches = Vec::new();
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let Some(batch_id) = path.file_name().and_then(|name| name.to_str()) else {
                continue;
            };
            let manifest = std::fs::read_to_string(path.join("share.json"))
                .map_err(|err| err.to_string())
                .and_then(|json| parse_manifest(&json));
            match manifest {
                Ok(manifest) => batches.push(ShareBatch {
                    batch_id: batch_id.to_owned(),
                    items: manifest.items,
                    target: manifest.target,
                }),
                Err(err) => {
                    log::warn!("dropping unreadable share batch {batch_id}: {err}");
                    let _ = std::fs::remove_dir_all(&path);
                }
            }
        }
        batches.sort_by(|a, b| a.batch_id.cmp(&b.batch_id));
        Ok(batches)
    })
    .await
    .map_err(|err| err.to_string())?
}

#[tauri::command]
pub(crate) async fn share_inbox_read<R: Runtime>(
    app: AppHandle<R>,
    batch_id: String,
    file_name: String,
) -> Result<Response, String> {
    validate_component(&batch_id)?;
    validate_component(&file_name)?;
    let root = inbox_root(&app)?;
    read_inbox_file(root, batch_id, file_name)
        .await
        .map(Response::new)
}

async fn read_inbox_file(
    root: PathBuf,
    batch_id: String,
    file_name: String,
) -> Result<Vec<u8>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = root.join(&batch_id).join(&file_name);
        let canonical = path.canonicalize().map_err(|err| err.to_string())?;
        let canonical_root = root.canonicalize().map_err(|err| err.to_string())?;
        if !canonical.starts_with(&canonical_root) {
            return Err("path escapes share inbox".to_owned());
        }
        std::fs::read(&canonical).map_err(|err| err.to_string())
    })
    .await
    .map_err(|err| err.to_string())?
}

#[tauri::command]
pub(crate) async fn share_inbox_clear<R: Runtime>(
    app: AppHandle<R>,
    batch_id: String,
) -> Result<(), String> {
    validate_component(&batch_id)?;
    let root = inbox_root(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        match std::fs::remove_dir_all(root.join(&batch_id)) {
            Ok(()) => Ok(()),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(err) => Err(err.to_string()),
        }
    })
    .await
    .map_err(|err| err.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_component_rejects_traversal() {
        assert!(validate_component("..").is_err());
        assert!(validate_component(".").is_err());
        assert!(validate_component("").is_err());
        assert!(validate_component("a/b").is_err());
        assert!(validate_component("a\\b").is_err());
        assert!(validate_component("a\0b").is_err());
        validate_component("1752-abc").expect("a batch id is a valid component");
        validate_component("image-0.jpg").expect("a file name is a valid component");
    }

    #[test]
    fn parse_manifest_reads_items() {
        let json = r#"{"version":1,"items":[{"kind":"text","text":"hello"}]}"#;
        let manifest = parse_manifest(json).unwrap();
        assert!(manifest.target.is_none());
        let items = manifest.items;
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].kind, "text");
        assert_eq!(items[0].text.as_deref(), Some("hello"));
    }

    #[test]
    fn parse_manifest_reads_the_picked_conversation() {
        let json = r#"{"version":1,"items":[],"target":{"userId":"@a:b","roomId":"!r:b"}}"#;
        let target = parse_manifest(json).unwrap().target.unwrap();
        assert_eq!(
            (target.user_id.as_str(), target.room_id.as_str()),
            ("@a:b", "!r:b")
        );
    }

    #[test]
    fn parse_manifest_rejects_an_unknown_version() {
        assert!(parse_manifest(r#"{"version":2,"items":[]}"#).is_err());
    }

    #[tokio::test]
    async fn inbox_reads_preserve_bytes_and_report_missing_files() {
        let root = std::env::temp_dir().join(format!("sable-share-read-{}", std::process::id()));
        let batch = root.join("batch");
        std::fs::create_dir_all(&batch).unwrap();
        let bytes = vec![0, 127, 128, 255];
        std::fs::write(batch.join("file.bin"), &bytes).unwrap();

        assert_eq!(
            read_inbox_file(root.clone(), "batch".to_owned(), "file.bin".to_owned())
                .await
                .unwrap(),
            bytes
        );
        let error = read_inbox_file(root.clone(), "batch".to_owned(), "missing.bin".to_owned())
            .await
            .expect_err("missing file is reported");
        assert_ne!(error, "");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn inbox_reads_reject_symlinks_outside_the_inbox() {
        let directory =
            std::env::temp_dir().join(format!("sable-share-symlink-{}", std::process::id()));
        let root = directory.join("inbox");
        std::fs::create_dir_all(root.join("batch")).unwrap();
        let secret = directory.join("secret");
        std::fs::write(&secret, "private").unwrap();
        std::os::unix::fs::symlink(&secret, root.join("batch/link")).unwrap();

        assert_eq!(
            read_inbox_file(root, "batch".to_owned(), "link".to_owned()).await,
            Err("path escapes share inbox".to_owned())
        );
        std::fs::remove_dir_all(directory).unwrap();
    }
}
