pub(crate) async fn discard(base_store_id: &str, store_id: &str) -> Result<(), String> {
    if store_id != base_store_id
        && !crate::session::removable_account_store(base_store_id, store_id)
    {
        return Err("refusing to discard an unrelated account store".to_owned());
    }
    discard_owned(base_store_id, store_id).await
}

#[cfg(not(target_family = "wasm"))]
async fn discard_owned(base_store_id: &str, store_id: &str) -> Result<(), String> {
    let root = std::path::Path::new(store_id);
    let paths = if store_id == base_store_id {
        vec![root.join("store"), root.join("cache")]
    } else {
        vec![root.to_owned()]
    };
    for path in paths {
        match tokio::fs::remove_dir_all(&path).await {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(format!("{}: {error}", path.display())),
        }
    }
    Ok(())
}

#[cfg(target_family = "wasm")]
async fn discard_owned(_base_store_id: &str, store_id: &str) -> Result<(), String> {
    use js_sys::{Function, Promise};
    use wasm_bindgen::{JsCast, JsValue, closure::Closure};
    use wasm_bindgen_futures::JsFuture;
    use web_sys::IdbFactory;

    crate::session::close_account_stores(store_id);
    let factory: IdbFactory = js_sys::Reflect::get(&js_sys::global(), &"indexedDB".into())
        .map_err(|error| format!("{error:?}"))?
        .dyn_into()
        .map_err(|_| "IndexedDB is not available".to_owned())?;
    for suffix in [
        "",
        "::matrix-sdk-state",
        "::matrix-sdk-crypto",
        "::matrix-sdk-crypto-meta",
        "::event_cache",
        "::media",
        "::sable-search",
    ] {
        let name = format!("{store_id}{suffix}");
        let request = factory
            .delete_database(&name)
            .map_err(|error| format!("{error:?}"))?;
        let mut handlers: Vec<Closure<dyn FnMut()>> = Vec::new();
        let promise = Promise::new(&mut |resolve: Function, reject: Function| {
            let success = Closure::<dyn FnMut()>::new(move || {
                let _ = resolve.call0(&JsValue::NULL);
            });
            let failure = Closure::<dyn FnMut()>::new(move || {
                let _ = reject.call1(
                    &JsValue::NULL,
                    &"Account store deletion failed or is blocked".into(),
                );
            });
            request.set_onsuccess(Some(success.as_ref().unchecked_ref()));
            request.set_onerror(Some(failure.as_ref().unchecked_ref()));
            request.set_onblocked(Some(failure.as_ref().unchecked_ref()));
            handlers.push(success);
            handlers.push(failure);
        });
        let result = JsFuture::from(promise).await;
        request.set_onsuccess(None);
        request.set_onerror(None);
        request.set_onblocked(None);
        drop(handlers);
        result.map_err(|error| format!("{name}: {error:?}"))?;
    }
    Ok(())
}

#[cfg(all(test, not(target_family = "wasm")))]
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
