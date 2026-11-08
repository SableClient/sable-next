use std::io::{BufRead as _, BufReader, Write as _};
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::time::Duration;

use matrix_sdk::Client;
use matrix_sdk::config::SyncSettings;
use matrix_sdk::executor::JoinHandleExt as _;
use serde_json::{Value, json};
use tokio::sync::mpsc;

use crate::Core;
use crate::protocol::CoreEvent;

fn write(input: &mut std::process::ChildStdin, message: &Value) {
    writeln!(input, "{message}").unwrap();
}

pub(super) async fn exchange(
    cores: [&Arc<Core>; 2],
    clients: [&Client; 2],
    events: [mpsc::UnboundedReceiver<CoreEvent>; 2],
) {
    let _syncs: Vec<_> = clients
        .into_iter()
        .map(|client| {
            let client = client.clone();
            tokio::spawn(async move {
                client
                    .sync(SyncSettings::default().timeout(Duration::from_millis(100)))
                    .await
                    .unwrap();
            })
            .abort_on_drop()
        })
        .collect();
    let script = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../tests/e2e/search-peer-live.mjs");
    let mut child = Command::new("node")
        .arg(script)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .unwrap();
    let output = child.stdout.take().unwrap();
    let mut input = child.stdin.take().unwrap();
    let (send, mut requests) = mpsc::unbounded_channel();
    let reader = std::thread::spawn(move || {
        for line in BufReader::new(output).lines() {
            if send
                .send(serde_json::from_str::<Value>(&line.unwrap()).unwrap())
                .is_err()
            {
                break;
            }
        }
    });
    let [mut left, mut right] = events;
    let mut ticker = tokio::time::interval(Duration::from_millis(50));
    let deadline = tokio::time::Instant::now() + Duration::from_secs(70);
    let status = loop {
        tokio::select! {
            Some(request) = requests.recv() => {
                let side = request["side"].as_u64().unwrap();
                let core = if side == 0 { cores[0] } else { cores[1] };
                let method = request["method"].as_str().unwrap();
                let result = if method == "rtc_data" {
                    let params = &request["params"];
                    let frame: Vec<u8> = serde_json::from_value(params["frame"].clone()).unwrap();
                    core.rtc_data(params["session_id"].as_str().unwrap(), &frame)
                        .await
                        .map(|reply| serde_json::value::to_raw_value(&reply).unwrap())
                } else {
                    core.call(method, &request["params"].to_string()).await
                };
                let response = match result {
                    Ok(value) => json!({ "id": request["id"], "ok": value }),
                    Err(error) => json!({ "id": request["id"], "error": format!("{error:?}") }),
                };
                write(&mut input, &response);
            }
            Some(event @ CoreEvent::Rtc { .. }) = left.recv() => {
                write(&mut input, &json!({ "side": 0, "event": event }));
            }
            Some(event @ CoreEvent::Rtc { .. }) = right.recv() => {
                write(&mut input, &json!({ "side": 1, "event": event }));
            }
            _ = ticker.tick() => {
                if let Some(status) = child.try_wait().unwrap() { break status; }
                if tokio::time::Instant::now() > deadline {
                    child.kill().unwrap();
                    panic!("browser peer-transfer test timed out");
                }
            }
        }
    };
    reader.join().unwrap();
    assert!(
        status.success(),
        "browser peer-transfer test failed: {status}"
    );
}
