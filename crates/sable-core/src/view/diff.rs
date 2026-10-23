use matrix_sdk_ui::eyeball_im;

use crate::protocol::VectorDiff;

/// Keeps a copy of a list in step with the diffs sent for it.
pub(crate) fn apply_diff<T: Clone>(items: &mut Vec<T>, diff: &VectorDiff<T>) {
    match diff {
        VectorDiff::Append { values } => items.extend(values.iter().cloned()),
        VectorDiff::Clear => items.clear(),
        VectorDiff::PushFront { value } => items.insert(0, value.clone()),
        VectorDiff::PushBack { value } => items.push(value.clone()),
        VectorDiff::PopFront => {
            if !items.is_empty() {
                items.remove(0);
            }
        }
        VectorDiff::PopBack => {
            items.pop();
        }
        VectorDiff::Insert { index, value } => {
            items.insert((*index).min(items.len()), value.clone());
        }
        VectorDiff::Set { index, value } => {
            if let Some(slot) = items.get_mut(*index) {
                *slot = value.clone();
            }
        }
        VectorDiff::Remove { index } => {
            if *index < items.len() {
                items.remove(*index);
            }
        }
        VectorDiff::Truncate { length } => items.truncate(*length),
        VectorDiff::Reset { values } => {
            items.clear();
            items.extend(values.iter().cloned());
        }
    }
}

#[must_use]
pub fn map_diff<T, U: Clone>(
    diff: eyeball_im::VectorDiff<T>,
    mut map: impl FnMut(&T) -> U,
) -> VectorDiff<U> {
    use eyeball_im::VectorDiff as In;

    match diff {
        In::Append { values } => VectorDiff::Append {
            values: values.iter().map(&mut map).collect(),
        },
        In::Clear => VectorDiff::Clear,
        In::PushFront { value } => VectorDiff::PushFront { value: map(&value) },
        In::PushBack { value } => VectorDiff::PushBack { value: map(&value) },
        In::PopFront => VectorDiff::PopFront,
        In::PopBack => VectorDiff::PopBack,
        In::Insert { index, value } => VectorDiff::Insert {
            index,
            value: map(&value),
        },
        In::Set { index, value } => VectorDiff::Set {
            index,
            value: map(&value),
        },
        In::Remove { index } => VectorDiff::Remove { index },
        In::Truncate { length } => VectorDiff::Truncate { length },
        In::Reset { values } => VectorDiff::Reset {
            values: values.iter().map(&mut map).collect(),
        },
    }
}

pub(super) fn diff_values<T>(diff: &eyeball_im::VectorDiff<T>) -> Vec<&T> {
    use eyeball_im::VectorDiff as In;

    match diff {
        In::Append { values } | In::Reset { values } => values.iter().collect(),
        In::PushFront { value }
        | In::PushBack { value }
        | In::Insert { value, .. }
        | In::Set { value, .. } => vec![value],
        In::Clear | In::PopFront | In::PopBack | In::Remove { .. } | In::Truncate { .. } => {
            Vec::new()
        }
    }
}
