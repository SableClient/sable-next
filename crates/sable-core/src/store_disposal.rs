use crate::store::StoreError;

#[cfg_attr(
    target_family = "wasm",
    expect(clippy::unused_async, reason = "the WASM store has nothing to await")
)]
pub(crate) async fn discard(base_store_id: &str, store_id: &str) -> Result<(), StoreError> {
    if store_id != base_store_id
        && !crate::session::removable_account_store(base_store_id, store_id)
    {
        return Err(StoreError::Invalid(
            "refusing to discard an unrelated account store",
        ));
    }
    #[cfg(not(target_family = "wasm"))]
    return discard_files(base_store_id, store_id).await;
    #[cfg(target_family = "wasm")]
    discard_databases(store_id)
}

pub(crate) async fn carry_room_keys(
    store_id: &str,
    base: &matrix_sdk_base::BaseClient,
) -> Result<usize, StoreError> {
    use matrix_sdk_base::crypto::store::CryptoStore;

    #[cfg(not(target_family = "wasm"))]
    let store = {
        let path = std::path::Path::new(store_id).join("store");
        if !tokio::fs::try_exists(path.join("matrix-sdk-crypto.sqlite3"))
            .await
            .map_err(StoreError::backend)?
        {
            return Ok(0);
        }
        let key = crate::store_encryption::saved_key(store_id)?;
        matrix_sdk::SqliteCryptoStore::open_with_config(&crate::store_encryption::config(
            path,
            key.as_ref(),
        ))
        .await
        .map_err(StoreError::backend)?
    };
    #[cfg(target_family = "wasm")]
    let store = matrix_sdk_indexeddb::IndexeddbCryptoStore::open_with_name(store_id)
        .await
        .map_err(StoreError::backend)?;

    let sessions = store
        .get_inbound_group_sessions()
        .await
        .map_err(StoreError::backend)?;
    drop(store);
    let mut keys = Vec::with_capacity(sessions.len());
    for session in sessions {
        keys.push(session.export().await);
    }
    let machine = base.olm_machine().await;
    let machine = machine
        .as_ref()
        .ok_or(StoreError::Invalid("no olm machine"))?;
    let result = machine
        .store()
        .import_exported_room_keys(keys, |_, _| {})
        .await
        .map_err(StoreError::backend)?;
    Ok(result.imported_count)
}

#[cfg(not(target_family = "wasm"))]
async fn discard_files(base_store_id: &str, store_id: &str) -> Result<(), StoreError> {
    let root = std::path::Path::new(store_id);
    let own_directory = store_id != base_store_id;
    let paths = if own_directory {
        let mut paths = Vec::new();
        match tokio::fs::read_dir(root).await {
            Ok(mut entries) => {
                while let Some(entry) =
                    entries
                        .next_entry()
                        .await
                        .map_err(|source| StoreError::Path {
                            path: root.to_owned(),
                            source,
                        })?
                {
                    if entry.file_name() != crate::store_encryption::KEY_REFERENCE {
                        paths.push(entry.path());
                    }
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(source) => {
                return Err(StoreError::Path {
                    path: root.to_owned(),
                    source,
                });
            }
        }
        paths
    } else {
        vec![
            root.join("store"),
            root.join("store.new"),
            root.join("store.old"),
            root.join("cache"),
            root.join(crate::search::DIRECTORY),
        ]
    };
    for path in paths {
        remove_path(path).await?;
    }
    // After the files, so a failed removal can be retried with the key that still opens what is
    // left. The reference sits beside them and goes with the key.
    crate::store_encryption::forget(store_id);
    if own_directory {
        remove_path(root.to_owned()).await?;
    }
    Ok(())
}

#[cfg(not(target_family = "wasm"))]
async fn remove_path(path: std::path::PathBuf) -> Result<(), StoreError> {
    let removed = match tokio::fs::symlink_metadata(&path).await {
        Ok(metadata) if metadata.is_dir() => tokio::fs::remove_dir_all(&path).await,
        Ok(_) => tokio::fs::remove_file(&path).await,
        Err(error) => Err(error),
    };
    match removed {
        Err(error) if error.kind() != std::io::ErrorKind::NotFound => Err(StoreError::Path {
            path,
            source: error,
        }),
        _ => Ok(()),
    }
}

#[cfg(target_family = "wasm")]
fn discard_databases(store_id: &str) -> Result<(), StoreError> {
    use wasm_bindgen::JsCast;

    crate::search::remove_database(store_id);

    let factory: web_sys::IdbFactory = js_sys::Reflect::get(&js_sys::global(), &"indexedDB".into())
        .map_err(|error| StoreError::Message(format!("{error:?}")))?
        .dyn_into()
        .map_err(|_| StoreError::Message("IndexedDB is not available".to_owned()))?;
    for suffix in [
        "",
        "::matrix-sdk-state",
        "::matrix-sdk-crypto",
        "::matrix-sdk-crypto-meta",
        "::event_cache",
        "::media",
        "::sable-search",
    ] {
        factory
            .delete_database(&format!("{store_id}{suffix}"))
            .map_err(|error| StoreError::Message(format!("{error:?}")))?;
    }
    Ok(())
}

#[cfg(test)]
#[cfg(not(target_family = "wasm"))]
mod tests {
    #[tokio::test]
    async fn legacy_disposal_preserves_the_shared_registry() {
        let directory = tempfile::tempdir().unwrap();
        let base = directory.path().to_str().unwrap();
        for name in ["store", "cache"] {
            tokio::fs::create_dir(directory.path().join(name))
                .await
                .unwrap();
            tokio::fs::write(directory.path().join(name).join("keys"), b"secret")
                .await
                .unwrap();
        }
        tokio::fs::write(directory.path().join("session.json"), b"registry")
            .await
            .unwrap();
        super::discard(base, base).await.unwrap();
        assert!(!directory.path().join("store").exists());
        assert!(!directory.path().join("cache").exists());
        assert_eq!(
            tokio::fs::read(directory.path().join("session.json"))
                .await
                .unwrap(),
            b"registry"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_failed_disposal_keeps_the_key_of_the_files_left_behind() {
        use std::os::unix::fs::PermissionsExt;

        let directory = tempfile::tempdir().unwrap();
        let base = directory.path().join("sable");
        let base = base.to_str().unwrap();
        let account = crate::session::account_store_id(base, "a1");
        let store = std::path::Path::new(&account).join("store");
        tokio::fs::create_dir_all(&store).await.unwrap();
        tokio::fs::write(store.join("keys"), b"secret")
            .await
            .unwrap();
        let reference = std::path::Path::new(&account).join("store-key");
        crate::secrets::load_or_create(&reference).unwrap();
        // A directory that cannot be modified keeps its entries from being removed.
        std::fs::set_permissions(&store, std::fs::Permissions::from_mode(0o500)).unwrap();

        let failed = super::discard(base, &account).await;

        // Skipped where permissions do not bind, such as a root user, who
        // has removed the directory by now.
        if failed.is_ok() {
            return;
        }
        std::fs::set_permissions(&store, std::fs::Permissions::from_mode(0o700)).unwrap();
        assert!(crate::secrets::load(&reference).unwrap().is_some());
        super::discard(base, &account).await.unwrap();
        assert!(crate::secrets::load(&reference).unwrap().is_none());
    }

    #[tokio::test]
    async fn account_disposal_refuses_paths_outside_the_allocated_store() {
        let directory = tempfile::tempdir().unwrap();
        let base = directory.path().join("sable");
        let base = base.to_str().unwrap();
        let account = crate::session::account_store_id(base, "a1");
        tokio::fs::create_dir_all(&account).await.unwrap();
        tokio::fs::write(std::path::Path::new(&account).join("keys"), b"secret")
            .await
            .unwrap();
        assert!(
            super::discard(base, &format!("{base}-account-a1/../other"))
                .await
                .is_err()
        );
        super::discard(base, &account).await.unwrap();
        assert!(!std::path::Path::new(&account).exists());
        super::discard(base, &account).await.unwrap();
    }
}
