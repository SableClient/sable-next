use sable_protocol::VectorDiff;

const MAX_SPLICE: usize = 64;

#[must_use]
pub fn list_diff<T: Clone + PartialEq>(old: &[T], new: &[T]) -> Vec<VectorDiff<T>> {
    let shared = old.iter().zip(new).take_while(|(a, b)| a == b).count();
    let max_tail = old.len().min(new.len()) - shared;
    let tail = old
        .iter()
        .rev()
        .zip(new.iter().rev())
        .take(max_tail)
        .take_while(|(a, b)| a == b)
        .count();
    let old_mid = old.get(shared..old.len() - tail).unwrap_or_default();
    let new_mid = new.get(shared..new.len() - tail).unwrap_or_default();
    let at_end = tail == 0;

    let mut diffs = Vec::new();
    match (old_mid.is_empty(), new_mid.is_empty()) {
        (true, true) => {}
        (true, false) if at_end => diffs.push(append(new_mid)),
        (true, false) => {
            diffs.extend(
                new_mid
                    .iter()
                    .enumerate()
                    .map(|(offset, value)| VectorDiff::Insert {
                        index: shared + offset,
                        value: value.clone(),
                    }),
            );
        }
        (false, true) if at_end => diffs.push(VectorDiff::Truncate { length: shared }),
        (false, true) => {
            diffs.extend(old_mid.iter().map(|_| VectorDiff::Remove { index: shared }));
        }
        (false, false) if old_mid.len() == new_mid.len() => {
            diffs.extend(sets(shared, old_mid, new_mid));
        }
        (false, false) if at_end => {
            let common = old_mid.len().min(new_mid.len());
            diffs.extend(sets(shared, old_mid, new_mid));
            if new_mid.len() > common {
                diffs.push(append(new_mid.get(common..).unwrap_or_default()));
            } else {
                diffs.push(VectorDiff::Truncate {
                    length: shared + common,
                });
            }
        }
        (false, false) if old_mid.len() + new_mid.len() <= MAX_SPLICE => {
            diffs.extend(old_mid.iter().map(|_| VectorDiff::Remove { index: shared }));
            diffs.extend(
                new_mid
                    .iter()
                    .enumerate()
                    .map(|(offset, value)| VectorDiff::Insert {
                        index: shared + offset,
                        value: value.clone(),
                    }),
            );
        }
        (false, false) => diffs.push(VectorDiff::Reset {
            values: new.to_vec(),
        }),
    }
    diffs
}

fn sets<'a, T: Clone + PartialEq>(
    start: usize,
    old: &'a [T],
    new: &'a [T],
) -> impl Iterator<Item = VectorDiff<T>> + 'a {
    old.iter()
        .zip(new)
        .enumerate()
        .filter(|(_, (before, after))| before != after)
        .map(move |(offset, (_, after))| VectorDiff::Set {
            index: start + offset,
            value: after.clone(),
        })
}

fn append<T: Clone>(values: &[T]) -> VectorDiff<T> {
    match values {
        [value] => VectorDiff::PushBack {
            value: value.clone(),
        },
        _ => VectorDiff::Append {
            values: values.to_vec(),
        },
    }
}

#[cfg(test)]
mod tests {
    use proptest::prelude::*;

    use super::*;
    use crate::patch::apply_diffs;

    fn replayed(old: &[u8], new: &[u8]) -> Vec<u8> {
        let mut list = old.to_vec();
        apply_diffs(&mut list, &list_diff(old, new)).unwrap();
        list
    }

    #[test]
    fn an_unchanged_list_has_no_edits() {
        assert_eq!(list_diff(&[1, 2, 3], &[1, 2, 3]), Vec::new());
    }

    #[test]
    fn a_new_last_row_is_one_push() {
        assert_eq!(
            list_diff(&[1, 2], &[1, 2, 3]),
            [VectorDiff::PushBack { value: 3 }]
        );
    }

    #[test]
    fn a_changed_last_row_and_a_new_one_are_a_set_and_a_push() {
        assert_eq!(
            list_diff(&[1, 2], &[1, 9, 3]),
            [
                VectorDiff::Set { index: 1, value: 9 },
                VectorDiff::PushBack { value: 3 }
            ]
        );
    }

    #[test]
    fn older_rows_are_inserted_in_front() {
        assert_eq!(
            list_diff(&[5, 6], &[3, 4, 5, 6]),
            [
                VectorDiff::Insert { index: 0, value: 3 },
                VectorDiff::Insert { index: 1, value: 4 }
            ]
        );
    }

    #[test]
    fn a_removed_tail_is_a_truncate() {
        assert_eq!(
            list_diff(&[1, 2, 3], &[1]),
            [VectorDiff::Truncate { length: 1 }]
        );
    }

    proptest! {
        #[test]
        fn the_edits_always_replay_to_the_new_list(
            old in prop::collection::vec(0u8..6, 0..40),
            new in prop::collection::vec(0u8..6, 0..40),
        ) {
            prop_assert_eq!(replayed(&old, &new), new);
        }
    }
}
