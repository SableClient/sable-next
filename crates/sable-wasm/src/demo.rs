//! A slice for tests of the shells, built only with the `demo` feature.

use sable_runtime::{Cmd, Cx, Doc, Lifetime, Slice};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Default, Serialize, Deserialize)]
pub struct CounterView {
    count: i64,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum CounterAction {
    Add { n: i64 },
    Double,
    Panic,
}

pub struct Counter;

impl Slice for Counter {
    const NAME: &'static str = "counter";
    const LIFETIME: Lifetime = Lifetime::Singleton;
    const PERSIST: bool = true;

    type Key = ();
    type State = Doc<CounterView>;
    type View = Doc<CounterView>;
    type Action = CounterAction;
    type Input = CounterAction;

    fn init((): &(), cached: Option<Value>) -> (Self::State, Cmd<CounterAction>) {
        let state = cached
            .and_then(Doc::from_cached)
            .unwrap_or_else(|| Doc::new(CounterView::default()));
        (state, Cmd::none())
    }

    fn view(state: &mut Self::State) -> &mut Self::View {
        state
    }

    fn reduce(
        (): &(),
        state: &mut Self::State,
        input: CounterAction,
        cx: &Cx,
    ) -> Cmd<CounterAction> {
        match input {
            CounterAction::Add { n } => {
                state.edit("/count", |view| view.count += n);
                Cmd::none()
            }
            CounterAction::Double => {
                state.edit("/count", |view| view.count *= 2);
                Cmd::reply(
                    cx.req(),
                    Ok::<_, sable_core::protocol::RpcError>(state.view().count),
                )
            }
            #[expect(clippy::panic, reason = "the shells' tests need a worker that aborts")]
            CounterAction::Panic => panic!("the demo slice was told to panic"),
        }
    }
}
