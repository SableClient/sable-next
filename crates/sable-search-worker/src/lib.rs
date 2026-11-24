//! Owns the search databases in a dedicated worker: the core sends it batches
//! of statements over a `MessagePort` and it answers with their rows.
#![cfg(target_family = "wasm")]

use std::cell::RefCell;
use std::collections::HashMap;

use rsqlite_vfs::VfsFilesManager as _;
use rusqlite::Connection;
use sable_sql::{OpenError, Request, Response, decode, encode, prepare, run_batch};
use sqlite_wasm_rs::WasmOsCallback;
use sqlite_wasm_vfs::sahpool::{OpfsSAHPoolCfg, OpfsSAHPoolUtil, install};
use wasm_bindgen::prelude::*;
use web_sys::{MessageEvent, MessagePort};

const INSTALL_ATTEMPTS: usize = 6;
const INSTALL_RETRY_MS: i32 = 250;

async fn pause(milliseconds: i32) {
    let promise = js_sys::Promise::new(&mut |resolve, _| {
        let scope: web_sys::WorkerGlobalScope = js_sys::global().unchecked_into();
        let _ = scope.set_timeout_with_callback_and_timeout_and_arguments_0(&resolve, milliseconds);
    });
    let _ = wasm_bindgen_futures::JsFuture::from(promise).await;
}

struct Databases {
    pool: Option<OpfsSAHPoolUtil>,
    open: HashMap<String, Connection>,
}

thread_local! {
    static DATABASES: RefCell<Option<Databases>> = const { RefCell::new(None) };
}

fn warn(message: &str) {
    web_sys::console::warn_1(&JsValue::from_str(message));
}

fn open(databases: &Databases, name: &str) -> Result<Connection, OpenError> {
    let connection = if databases.pool.is_some() {
        Connection::open(name)
    } else {
        Connection::open_in_memory()
    }?;
    prepare(&connection, false)?;
    Ok(connection)
}

fn connection<'a>(databases: &'a mut Databases, name: &str) -> Result<&'a mut Connection, String> {
    if !databases.open.contains_key(name) {
        let opened = open(databases, name)
            .or_else(|error| {
                if !error.starts_over() {
                    return Err(error);
                }
                warn(&format!(
                    "the search database cannot be used, starting it over: {error}"
                ));
                if let Some(pool) = &databases.pool {
                    let _ = pool.remove(name);
                    let _ = pool.remove(&format!("{name}-journal"));
                }
                open(databases, name)
            })
            .map_err(|error| error.to_string())?;
        databases.open.insert(name.to_owned(), opened);
    }
    databases
        .open
        .get_mut(name)
        .ok_or_else(|| "the database vanished".to_owned())
}

fn answer(bytes: &[u8]) -> Response {
    let request: Request = match decode(bytes) {
        Ok(request) => request,
        Err(error) => {
            return Response {
                id: 0,
                result: Err(error),
            };
        }
    };
    let result = DATABASES.with_borrow_mut(|databases| {
        let databases = databases
            .as_mut()
            .ok_or_else(|| "the worker is not serving".to_owned())?;
        if request.remove {
            databases.open.remove(&request.database);
            if let Some(pool) = &databases.pool {
                for suffix in ["", "-journal"] {
                    let _ = pool.remove(&format!("{}{suffix}", request.database));
                }
            }
            return Ok(Vec::new());
        }
        let connection = connection(databases, &request.database)?;
        run_batch(connection, &request.statements).map_err(|error| error.to_string())
    });
    Response {
        id: request.id,
        result,
    }
}

/// Installs the OPFS pool, then answers every batch that arrives on `port`.
/// Without a pool the databases last as long as the worker, and a warning says so.
#[wasm_bindgen]
pub async fn serve(port: MessagePort) {
    let mut pool = None;
    for attempt in 0..INSTALL_ATTEMPTS {
        match install::<WasmOsCallback>(&OpfsSAHPoolCfg::default(), true).await {
            Ok(installed) => {
                pool = Some(installed);
                break;
            }
            Err(error) if attempt + 1 == INSTALL_ATTEMPTS => warn(&format!(
                "the search index cannot persist here, keeping it in memory: {error}"
            )),
            // The worker that had the files before may still be closing.
            Err(_) => pause(INSTALL_RETRY_MS).await,
        }
    }
    DATABASES.with_borrow_mut(|databases| {
        databases.get_or_insert(Databases {
            pool,
            open: HashMap::new(),
        });
    });

    let reply = port.clone();
    let on_message = Closure::<dyn FnMut(MessageEvent)>::new(move |event: MessageEvent| {
        let bytes = js_sys::Uint8Array::new(&event.data()).to_vec();
        let encoded = js_sys::Uint8Array::from(encode(&answer(&bytes)).as_slice());
        let transfer = js_sys::Array::of1(&encoded.buffer());
        if reply
            .post_message_with_transferable(&encoded, &transfer)
            .is_err()
        {
            warn("the search database could not answer");
        }
    });
    port.set_onmessage(Some(on_message.as_ref().unchecked_ref()));
    on_message.forget();
    port.start();
}
