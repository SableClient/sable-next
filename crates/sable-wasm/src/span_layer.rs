use std::cell::RefCell;

use js_sys::Function;
use tracing::{
    Subscriber,
    span::{Attributes, Id},
};
use tracing_subscriber::{Layer, layer::Context, registry::LookupSpan};
use wasm_bindgen::prelude::*;

/// Shorter spans would flood the worker port without showing anything slow.
const MIN_SPAN_MS: f64 = 10.0;

thread_local! {
    static SPAN_NOTIFIER: RefCell<Option<Function>> = const { RefCell::new(None) };
}

#[wasm_bindgen(js_name = setSpanHandler)]
pub fn set_span_handler(notify: Function) {
    SPAN_NOTIFIER.with_borrow_mut(|slot| *slot = Some(notify));
}

struct SpanStart(f64);

pub(crate) struct JsSpanLayer;

impl<S> Layer<S> for JsSpanLayer
where
    S: Subscriber + for<'lookup> LookupSpan<'lookup>,
{
    fn on_new_span(&self, _attrs: &Attributes<'_>, id: &Id, ctx: Context<'_, S>) {
        if let Some(span) = ctx.span(id) {
            // Epoch milliseconds are comparable across worker and page clocks.
            span.extensions_mut().insert(SpanStart(js_sys::Date::now()));
        }
    }

    fn on_close(&self, id: Id, ctx: Context<'_, S>) {
        let Some(span) = ctx.span(&id) else {
            return;
        };
        let extensions = span.extensions();
        let Some(SpanStart(start_ms)) = extensions.get::<SpanStart>() else {
            return;
        };
        let Some(duration_ms) = duration_ms(*start_ms, js_sys::Date::now()) else {
            return;
        };
        let notify = SPAN_NOTIFIER.with_borrow(Clone::clone);
        if let Some(notify) = notify {
            let _ = notify.call3(
                &JsValue::NULL,
                &JsValue::from_str(span.name()),
                &JsValue::from_f64(*start_ms),
                &JsValue::from_f64(duration_ms),
            );
        }
    }
}

fn duration_ms(start_ms: f64, end_ms: f64) -> Option<f64> {
    let duration = end_ms - start_ms;
    (duration >= MIN_SPAN_MS).then_some(duration)
}

#[cfg(test)]
mod tests {
    use wasm_bindgen_test::wasm_bindgen_test;

    use super::duration_ms;

    #[wasm_bindgen_test]
    fn drops_short_spans_and_reports_elapsed_milliseconds() {
        let start_ms = 1_794_000_000_125.0;
        assert_eq!(duration_ms(start_ms, start_ms + 9.5), None);
        assert_eq!(duration_ms(start_ms, start_ms + 10.0), Some(10.0));
        assert_eq!(duration_ms(start_ms, start_ms + 25.5), Some(25.5));
    }
}
