//! Who has read up to each row.

use std::collections::HashSet;

use super::view::{Shared, TimelineReceiptsView};

/// For each item that carries a reader's receipt, the readers whose latest
/// receipt is on a later item. The item's own readers are in its `read_by`.
pub(super) fn later(items: &[Shared]) -> Vec<Option<TimelineReceiptsView>> {
    let mut receipts = vec![None; items.len()];
    let mut seen = HashSet::new();
    let mut later = TimelineReceiptsView::default();
    for (index, item) in items.iter().enumerate().rev() {
        let fresh: Vec<&str> = item
            .read_by
            .iter()
            .map(|reader| reader.as_str())
            .filter(|reader| seen.insert(*reader))
            .collect();
        if fresh.is_empty() {
            continue;
        }
        if !later.readers.is_empty()
            && let Some(slot) = receipts.get_mut(index)
        {
            *slot = Some(later.clone());
        }
        for reader in &fresh {
            if let Some(at) = item.read_timestamps.get(*reader) {
                later.timestamps.insert((*reader).to_owned(), *at);
            }
        }
        later
            .readers
            .splice(0..0, fresh.iter().map(|reader| (*reader).to_owned()));
    }
    receipts
}
