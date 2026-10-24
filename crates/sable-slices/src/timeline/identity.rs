//! Keys that keep a row the same row while its item changes: an echo that
//! becomes the event it sent, a divider that belongs to the event under it.

use std::collections::HashSet;

use sable_protocol::TimelineItemContentView;

use super::view::Shared;

#[derive(Debug, Default)]
pub struct Identity {
    echoes: HashSet<String>,
}

impl Identity {
    /// Forgets the echoes that are no longer in the list.
    pub fn reconcile(&mut self, items: &[Shared]) {
        let active: HashSet<&str> = items.iter().map(|item| item.id.as_str()).collect();
        self.echoes.retain(|id| active.contains(id.as_str()));
    }

    /// One distinct key for each item.
    pub fn keys(&mut self, items: &[Shared]) -> Vec<String> {
        let event_keys: Vec<Option<String>> =
            items.iter().map(|item| self.event_key(item)).collect();
        let mut bases = Vec::with_capacity(items.len());
        let mut later: Option<&str> = None;
        for (item, own) in items.iter().zip(&event_keys).rev() {
            let boundary = matches!(
                item.content,
                TimelineItemContentView::DateDivider { .. }
                    | TimelineItemContentView::TimelineStart
            );
            bases.push(match (own, later, boundary) {
                (Some(own), _, _) => own.clone(),
                (None, Some(later), true) => format!("boundary:{}:{later}", item.id),
                (None, _, _) => format!("item:{}", item.id),
            });
            if let Some(own) = own {
                later = Some(own);
            }
        }
        bases.reverse();

        let mut seen: HashSet<String> = HashSet::with_capacity(bases.len());
        bases
            .into_iter()
            .map(|base| {
                let mut key = base.clone();
                let mut attempt = 1;
                while seen.contains(&key) {
                    key = format!("{base}#{attempt}");
                    attempt += 1;
                }
                seen.insert(key.clone());
                key
            })
            .collect()
    }

    fn event_key(&mut self, item: &Shared) -> Option<String> {
        if item.transaction_id.is_some() {
            self.echoes.insert(item.id.clone());
        }
        if self.echoes.contains(&item.id) {
            return Some(format!("item:{}", item.id));
        }
        if let Some(event_id) = &item.event_id {
            return Some(format!("event:{event_id}"));
        }
        item.transaction_id
            .as_ref()
            .map(|transaction_id| format!("transaction:{transaction_id}"))
    }
}
