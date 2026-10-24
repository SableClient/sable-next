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
        (false, true) => diffs.extend(old_mid.iter().map(|_| VectorDiff::Remove { index: shared })),
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
            values: new.to_vec().into(),
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
            values: values.to_vec().into(),
        },
    }
}
