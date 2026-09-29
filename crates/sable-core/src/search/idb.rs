use std::cell::RefCell;
use std::collections::HashMap;

use js_sys::{Function, Promise, Uint8Array};
use wasm_bindgen::closure::Closure;
use wasm_bindgen::{JsCast, JsValue};
use wasm_bindgen_futures::JsFuture;
use web_sys::{IdbDatabase, IdbFactory, IdbOpenDbRequest, IdbTransaction, IdbTransactionMode};

const DATABASE_SUFFIX: &str = "::sable-search";
const DATABASE_VERSION: u32 = 1;
const STORE: &str = "values";

struct Connection {
    database: IdbDatabase,
    _on_version_change: Closure<dyn FnMut()>,
}

impl Drop for Connection {
    fn drop(&mut self) {
        self.database.set_onversionchange(None);
        self.database.close();
    }
}

struct Slot {
    connection: Connection,
    closed: bool,
}

pub(super) enum Attached {
    Open(IdbDatabase),
    Closed,
    Detached,
}

thread_local! {
    static CONNECTIONS: RefCell<HashMap<String, Slot>> = RefCell::new(HashMap::new());
}

fn identity(client: &matrix_sdk::Client) -> Option<String> {
    Some(format!("{}|{}", client.user_id()?, client.device_id()?))
}

fn failure(error: &JsValue) -> String {
    error
        .as_string()
        .or_else(|| {
            error
                .dyn_ref::<js_sys::Error>()
                .map(|error| String::from(error.message()))
        })
        .unwrap_or_else(|| format!("{error:?}"))
}

pub(super) fn attached(client: &matrix_sdk::Client) -> Attached {
    let Some(identity) = identity(client) else {
        return Attached::Detached;
    };
    CONNECTIONS.with_borrow(|connections| match connections.get(&identity) {
        Some(slot) if slot.closed => Attached::Closed,
        Some(slot) => Attached::Open(slot.connection.database.clone()),
        None => Attached::Detached,
    })
}

pub(super) async fn attach(client: &matrix_sdk::Client, store_id: &str) -> Result<(), String> {
    let identity = identity(client).ok_or("the client has no session")?;
    CONNECTIONS.with_borrow_mut(|connections| connections.remove(&identity));
    let database = open(&format!("{store_id}{DATABASE_SUFFIX}")).await?;
    let on_version_change = {
        let identity = identity.clone();
        Closure::<dyn FnMut()>::new(move || {
            CONNECTIONS.with_borrow_mut(|connections| {
                if let Some(slot) = connections.get_mut(&identity) {
                    slot.connection.database.close();
                    slot.closed = true;
                }
            });
        })
    };
    database.set_onversionchange(Some(on_version_change.as_ref().unchecked_ref()));
    CONNECTIONS.with_borrow_mut(|connections| {
        connections.insert(
            identity,
            Slot {
                connection: Connection {
                    database,
                    _on_version_change: on_version_change,
                },
                closed: false,
            },
        )
    });
    Ok(())
}

async fn open(name: &str) -> Result<IdbDatabase, String> {
    let factory: IdbFactory = js_sys::Reflect::get(&js_sys::global(), &"indexedDB".into())
        .map_err(|error| failure(&error))?
        .dyn_into()
        .map_err(|_| "IndexedDB is not available".to_owned())?;
    let request = factory
        .open_with_u32(name, DATABASE_VERSION)
        .map_err(|error| failure(&error))?;

    let upgrade = {
        let request = request.clone();
        Closure::<dyn FnMut()>::new(move || {
            let Ok(database) = request.result().and_then(JsCast::dyn_into::<IdbDatabase>) else {
                return;
            };
            if !database.object_store_names().contains(STORE) {
                let _ = database.create_object_store(STORE);
            }
        })
    };
    request.set_onupgradeneeded(Some(upgrade.as_ref().unchecked_ref()));
    let opened = settled_open(&request).await;
    request.set_onupgradeneeded(None);
    drop(upgrade);
    opened?;

    request
        .result()
        .and_then(JsCast::dyn_into::<IdbDatabase>)
        .map_err(|error| failure(&error))
}

async fn settled_open(request: &IdbOpenDbRequest) -> Result<(), String> {
    let mut handlers: Vec<Closure<dyn FnMut()>> = Vec::new();
    let promise = Promise::new(&mut |resolve: Function, reject: Function| {
        let succeeded = Closure::<dyn FnMut()>::new(move || {
            let _ = resolve.call0(&JsValue::NULL);
        });
        let failed = {
            let request = request.clone();
            Closure::<dyn FnMut()>::new(move || {
                let error = request
                    .error()
                    .ok()
                    .flatten()
                    .map_or(JsValue::NULL, JsValue::from);
                let _ = reject.call1(&JsValue::NULL, &error);
            })
        };
        request.set_onsuccess(Some(succeeded.as_ref().unchecked_ref()));
        request.set_onerror(Some(failed.as_ref().unchecked_ref()));
        handlers.push(succeeded);
        handlers.push(failed);
    });
    let result = JsFuture::from(promise).await;
    request.set_onsuccess(None);
    request.set_onerror(None);
    drop(handlers);
    result.map(drop).map_err(|error| failure(&error))
}

async fn finished(transaction: &IdbTransaction) -> Result<(), String> {
    let mut handlers: Vec<Closure<dyn FnMut()>> = Vec::new();
    let promise = Promise::new(&mut |resolve: Function, reject: Function| {
        let completed = Closure::<dyn FnMut()>::new(move || {
            let _ = resolve.call0(&JsValue::NULL);
        });
        let failed = {
            let transaction = transaction.clone();
            Closure::<dyn FnMut()>::new(move || {
                let error = transaction.error().map_or(JsValue::NULL, JsValue::from);
                let _ = reject.call1(&JsValue::NULL, &error);
            })
        };
        transaction.set_oncomplete(Some(completed.as_ref().unchecked_ref()));
        transaction.set_onerror(Some(failed.as_ref().unchecked_ref()));
        transaction.set_onabort(Some(failed.as_ref().unchecked_ref()));
        handlers.push(completed);
        handlers.push(failed);
    });
    let result = JsFuture::from(promise).await;
    transaction.set_oncomplete(None);
    transaction.set_onerror(None);
    transaction.set_onabort(None);
    drop(handlers);
    result.map(drop).map_err(|error| failure(&error))
}

fn transaction(
    database: &IdbDatabase,
    mode: IdbTransactionMode,
) -> Result<(IdbTransaction, web_sys::IdbObjectStore), String> {
    let transaction = database
        .transaction_with_str_and_mode(STORE, mode)
        .map_err(|error| failure(&error))?;
    let store = transaction
        .object_store(STORE)
        .map_err(|error| failure(&error))?;
    Ok((transaction, store))
}

pub(super) async fn get(database: &IdbDatabase, key: &str) -> Result<Option<Vec<u8>>, String> {
    let (transaction, store) = transaction(database, IdbTransactionMode::Readonly)?;
    let request = store
        .get(&JsValue::from_str(key))
        .map_err(|error| failure(&error))?;
    finished(&transaction).await?;
    let value = request.result().map_err(|error| failure(&error))?;
    if value.is_undefined() {
        return Ok(None);
    }
    value
        .dyn_into::<Uint8Array>()
        .map(|bytes| Some(bytes.to_vec()))
        .map_err(|_| format!("{key} does not hold bytes"))
}

pub(super) async fn put(database: &IdbDatabase, key: &str, bytes: &[u8]) -> Result<(), String> {
    let (transaction, store) = transaction(database, IdbTransactionMode::Readwrite)?;
    store
        .put_with_key(&Uint8Array::from(bytes), &JsValue::from_str(key))
        .map_err(|error| failure(&error))?;
    finished(&transaction).await
}

pub(super) async fn delete(database: &IdbDatabase, key: &str) -> Result<(), String> {
    let (transaction, store) = transaction(database, IdbTransactionMode::Readwrite)?;
    store
        .delete(&JsValue::from_str(key))
        .map_err(|error| failure(&error))?;
    finished(&transaction).await
}
