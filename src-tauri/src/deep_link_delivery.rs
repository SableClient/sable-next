use std::sync::Arc;

pub(super) type Handler = Arc<dyn Fn(String) + Send + Sync>;

#[derive(Default)]
pub(super) struct Delivery {
    pending: Vec<String>,
    handler: Option<Handler>,
    ready: bool,
}

impl Delivery {
    pub(super) fn install(&mut self, handler: Handler) {
        self.handler = Some(handler);
    }

    pub(super) fn push(&mut self, url: String) -> Option<(Handler, String)> {
        match &self.handler {
            Some(handler) if self.ready => Some((handler.clone(), url)),
            _ => {
                self.pending.push(url);
                None
            }
        }
    }

    pub(super) fn take_pending(&mut self) -> Vec<String> {
        self.ready = true;
        std::mem::take(&mut self.pending)
    }
}

#[cfg(test)]
mod tests {
    use super::Delivery;
    use std::sync::{Arc, Mutex};

    #[test]
    fn installing_a_handler_does_not_discard_startup_redirects() {
        let mut delivery = Delivery::default();
        assert!(delivery.push("sable://before-setup".to_owned()).is_none());
        delivery.install(Arc::new(|_| panic!("frontend is not listening yet")));
        assert!(
            delivery
                .push("sable://before-listener".to_owned())
                .is_none()
        );
        assert_eq!(
            delivery.take_pending(),
            ["sable://before-setup", "sable://before-listener"]
        );
        assert!(delivery.take_pending().is_empty());
    }

    #[test]
    fn redirects_after_the_pending_query_are_delivered_once() {
        let mut delivery = Delivery::default();
        let received = Arc::new(Mutex::new(Vec::new()));
        let sink = received.clone();
        delivery.install(Arc::new(move |url| sink.lock().unwrap().push(url)));
        assert!(delivery.take_pending().is_empty());
        let (handler, url) = delivery
            .push("sable://live".to_owned())
            .expect("frontend is ready");
        handler(url);
        assert_eq!(*received.lock().unwrap(), ["sable://live"]);
        assert!(delivery.take_pending().is_empty());
    }
}
