use std::{
    fs,
    io::{self, ErrorKind},
    path::Path,
    time::UNIX_EPOCH,
};

use serde::Serialize;
use tauri::{AppHandle, Runtime};
use tauri_plugin_dialog::DialogExt;

const MAX_THEME_FILE_BYTES: u64 = 1024 * 1024;

#[derive(Debug, PartialEq, Serialize)]
pub(crate) struct ThemeFile {
    path: String,
    modified: u64,
    css: String,
}

fn read_if_changed(path: &Path, since: Option<u64>) -> io::Result<Option<ThemeFile>> {
    let is_css = path
        .extension()
        .is_some_and(|extension| extension.eq_ignore_ascii_case("css"));
    if !is_css {
        return Err(io::Error::new(ErrorKind::InvalidInput, "not a .css file"));
    }
    let metadata = fs::metadata(path)?;
    let modified = metadata
        .modified()?
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| {
            u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX)
        });
    if since == Some(modified) {
        return Ok(None);
    }
    if metadata.len() > MAX_THEME_FILE_BYTES {
        return Err(io::Error::new(
            ErrorKind::FileTooLarge,
            "theme file too large",
        ));
    }
    Ok(Some(ThemeFile {
        path: path.to_string_lossy().into_owned(),
        modified,
        css: fs::read_to_string(path)?,
    }))
}

#[tauri::command]
pub(crate) async fn pick_theme_files<R: Runtime>(
    app: AppHandle<R>,
) -> Result<Vec<ThemeFile>, String> {
    let picked = app
        .dialog()
        .file()
        .add_filter("CSS", &["css"])
        .blocking_pick_files()
        .unwrap_or_default();
    picked
        .into_iter()
        .filter_map(|file| file.into_path().ok())
        .filter_map(|path| read_if_changed(&path, None).transpose())
        .collect::<io::Result<_>>()
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub(crate) async fn read_theme_file(
    path: String,
    since: Option<u64>,
) -> Result<Option<ThemeFile>, String> {
    read_if_changed(Path::new(&path), since).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_only_when_the_file_changed() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("matugen.sable.css");
        fs::write(&path, "/* @sable-theme */").unwrap();

        let first = read_if_changed(&path, None).unwrap().unwrap();
        assert_eq!(first.css, "/* @sable-theme */");
        assert_eq!(read_if_changed(&path, Some(first.modified)).unwrap(), None);
        assert!(
            read_if_changed(&path, Some(first.modified - 1))
                .unwrap()
                .is_some()
        );
    }

    #[test]
    fn refuses_files_that_are_not_css() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("secrets.json");
        fs::write(&path, "{}").unwrap();

        assert_eq!(
            read_if_changed(&path, None).unwrap_err().kind(),
            ErrorKind::InvalidInput
        );
    }

    #[test]
    fn refuses_files_over_the_theme_limit() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("huge.css");
        fs::write(&path, vec![b' '; 1024 * 1024 + 1]).unwrap();

        assert_eq!(
            read_if_changed(&path, None).unwrap_err().kind(),
            ErrorKind::FileTooLarge
        );
    }
}
