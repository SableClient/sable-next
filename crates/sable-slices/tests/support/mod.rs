use sable_runtime::{
    AppEvent, Target,
    testing::{Replica, TestApp},
};

pub async fn feed(harness: &TestApp, replica: &mut Replica) -> Vec<AppEvent> {
    let events = harness.events().await;
    for event in &events {
        replica.apply(event).expect("the patch applies");
    }
    events
}

use serde_json::Value;

pub fn target(slice: &str, key: Value) -> Target {
    Target {
        slice: slice.to_owned(),
        key,
    }
}
