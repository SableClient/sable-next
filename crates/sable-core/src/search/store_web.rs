//! The web database lives in a dedicated worker that owns the OPFS file. The
//! tab that owns the store starts it and hands the core one end of a channel.

use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;
use std::time::Duration;

use futures_util::future::{Either, select};
use js_sys::Uint8Array;
use sable_sql::{Request, Response, Rows, Statement, decode, encode};
use tokio::sync::oneshot;
use tracing::{info, warn};
use wasm_bindgen::JsCast;
use wasm_bindgen::prelude::*;
use web_sys::{MessageEvent, MessagePort};

use super::exec::{Exec, Result, SqlError};
use super::store::Store;

const REPLY_TIMEOUT: Duration = Duration::from_secs(20);

type Pending = Rc<RefCell<HashMap<u32, oneshot::Sender<Result<Vec<Rows>>>>>>;

struct Link {
    port: MessagePort,
    pending: Pending,
    next: u32,
    _on_message: Closure<dyn FnMut(MessageEvent)>,
}

thread_local! {
    static LINK: RefCell<Option<Link>> = const { RefCell::new(None) };
}

fn file_name(store_id: &str) -> String {
    format!("{store_id}-search.sqlite3")
}

pub(super) fn open_account(store_id: &str) -> Store {
    Store::from_exec(Exec::Web(Some(file_name(store_id))))
}

pub(super) fn attached() -> bool {
    LINK.with_borrow(Option::is_some)
}

/// Fails what waits on the old worker, so a new owner starts clean.
fn drop_link() {
    if let Some(link) = LINK.with_borrow_mut(Option::take) {
        link.port.close();
        for (_, waiting) in link.pending.borrow_mut().drain() {
            let _ = waiting.send(Err(SqlError("the search database went away".to_owned())));
        }
    }
}

/// Takes the port of a search worker, in place of one that went away.
pub fn attach_search_port(port: MessagePort) {
    drop_link();
    let pending: Pending = Rc::default();
    let replies = pending.clone();
    let on_message = Closure::<dyn FnMut(MessageEvent)>::new(move |event: MessageEvent| {
        let bytes = Uint8Array::new(&event.data()).to_vec();
        let Ok(response) = decode::<Response>(&bytes) else {
            return;
        };
        if let Some(waiting) = replies.borrow_mut().remove(&response.id) {
            let _ = waiting.send(response.result.map_err(SqlError));
        }
    });
    port.set_onmessage(Some(on_message.as_ref().unchecked_ref()));
    port.start();
    LINK.with_borrow_mut(|link| {
        *link = Some(Link {
            port,
            pending,
            next: 1,
            _on_message: on_message,
        });
    });
    info!("the search database is attached");
}

fn post(request: &Request) -> Result<(u32, oneshot::Receiver<Result<Vec<Rows>>>)> {
    LINK.with_borrow_mut(|link| {
        let link = link
            .as_mut()
            .ok_or_else(|| SqlError("no search database yet".to_owned()))?;
        let id = link.next;
        link.next = link.next.wrapping_add(1);
        let (sender, receiver) = oneshot::channel();
        link.pending.borrow_mut().insert(id, sender);
        let bytes = Uint8Array::from(
            encode(&Request {
                id,
                ..request.clone()
            })
            .as_slice(),
        );
        let transfer = js_sys::Array::of1(&bytes.buffer());
        link.port
            .post_message_with_transferable(&bytes, &transfer)
            .map_err(|_| SqlError("the search database cannot be reached".to_owned()))?;
        Ok((id, receiver))
    })
}

async fn exchange(request: Request) -> Result<Vec<Rows>> {
    let (id, answer) = post(&request)?;
    let timeout = Box::pin(matrix_sdk::sleep::sleep(REPLY_TIMEOUT));
    match select(answer, timeout).await {
        Either::Left((Ok(result), _)) => result,
        Either::Left((Err(_), _)) => Err(SqlError("the search database went away".to_owned())),
        // Keep the link: the core gets a new port only when another tab takes
        // the database over, so dropping it would end local search over one
        // slow batch.
        Either::Right(_) => {
            warn!("the search database took too long to answer");
            LINK.with_borrow(|link| {
                if let Some(link) = link {
                    link.pending.borrow_mut().remove(&id);
                }
            });
            Err(SqlError(
                "the search database took too long to answer".to_owned(),
            ))
        }
    }
}

pub(super) async fn send(database: &str, statements: Vec<Statement>) -> Result<Vec<Rows>> {
    exchange(Request {
        id: 0,
        database: database.to_owned(),
        statements,
        remove: false,
    })
    .await
}

pub(crate) fn remove(store_id: &str) {
    let request = Request {
        id: 0,
        database: file_name(store_id),
        statements: Vec::new(),
        remove: true,
    };
    wasm_bindgen_futures::spawn_local(async move {
        if attached() {
            let _ = exchange(request).await;
        }
    });
}
