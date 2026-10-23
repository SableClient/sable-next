use sable_protocol::VectorDiff;
#[cfg(any(test, feature = "testing"))]
use serde_json::Value;

#[cfg(any(test, feature = "testing"))]
use crate::wire::Op;

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum PatchError {
    #[error("no value at `{0}`")]
    Missing(String),
    #[error("`{0}` is not an array")]
    NotAnArray(String),
    #[error("index {index} is out of range for a list of {len}")]
    OutOfRange { index: usize, len: usize },
}

#[cfg(any(test, feature = "testing"))]
fn unescape(token: &str) -> String {
    token.replace("~1", "/").replace("~0", "~")
}

#[cfg(any(test, feature = "testing"))]
pub fn apply(target: &mut Value, ops: &[Op]) -> Result<(), PatchError> {
    for op in ops {
        match op {
            Op::Replace { path, value } => {
                set(target, path, value.clone())?;
            }
            Op::Remove { path } => remove(target, path)?,
            Op::List { path, diffs } => {
                let list = target
                    .pointer_mut(path)
                    .ok_or_else(|| PatchError::Missing(path.clone()))?
                    .as_array_mut()
                    .ok_or_else(|| PatchError::NotAnArray(path.clone()))?;
                apply_diffs(list, diffs)?;
            }
        }
    }
    Ok(())
}

#[cfg(any(test, feature = "testing"))]
fn split_parent(path: &str) -> Result<(&str, String), PatchError> {
    path.rsplit_once('/')
        .map(|(parent, key)| (parent, unescape(key)))
        .ok_or_else(|| PatchError::Missing(path.to_owned()))
}

#[cfg(any(test, feature = "testing"))]
fn set(target: &mut Value, path: &str, value: Value) -> Result<(), PatchError> {
    if path.is_empty() {
        *target = value;
        return Ok(());
    }
    let (parent, key) = split_parent(path)?;
    match target
        .pointer_mut(parent)
        .ok_or_else(|| PatchError::Missing(parent.to_owned()))?
    {
        Value::Object(map) => {
            map.insert(key, value);
            Ok(())
        }
        _ => Err(PatchError::Missing(path.to_owned())),
    }
}

#[cfg(any(test, feature = "testing"))]
fn remove(target: &mut Value, path: &str) -> Result<(), PatchError> {
    let (parent, key) = split_parent(path)?;
    match target
        .pointer_mut(parent)
        .ok_or_else(|| PatchError::Missing(parent.to_owned()))?
    {
        Value::Object(map) => map
            .shift_remove(&key)
            .map(drop)
            .ok_or_else(|| PatchError::Missing(path.to_owned())),
        _ => Err(PatchError::Missing(path.to_owned())),
    }
}

pub fn apply_diffs<T: Clone>(
    items: &mut Vec<T>,
    diffs: &[VectorDiff<T>],
) -> Result<(), PatchError> {
    for diff in diffs {
        let len = items.len();
        match diff {
            VectorDiff::Append { values } => items.extend(values.iter().cloned()),
            VectorDiff::Clear => items.clear(),
            VectorDiff::PushFront { value } => items.insert(0, value.clone()),
            VectorDiff::PushBack { value } => items.push(value.clone()),
            VectorDiff::PopFront => {
                if len > 0 {
                    items.remove(0);
                }
            }
            VectorDiff::PopBack => {
                items.pop();
            }
            VectorDiff::Insert { index, value } => {
                if *index > len {
                    return Err(PatchError::OutOfRange { index: *index, len });
                }
                items.insert(*index, value.clone());
            }
            VectorDiff::Set { index, value } => {
                let slot = items
                    .get_mut(*index)
                    .ok_or(PatchError::OutOfRange { index: *index, len })?;
                *slot = value.clone();
            }
            VectorDiff::Remove { index } => {
                if *index >= len {
                    return Err(PatchError::OutOfRange { index: *index, len });
                }
                items.remove(*index);
            }
            VectorDiff::Truncate { length } => items.truncate(*length),
            VectorDiff::Reset { values } => items.clone_from(values),
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn list_ops_edit_the_array_at_their_path() {
        let mut value = json!({"items": [1, 2, 3]});
        apply(
            &mut value,
            &[Op::List {
                path: "/items".to_owned(),
                diffs: vec![
                    VectorDiff::Remove { index: 0 },
                    VectorDiff::PushBack { value: json!(4) },
                ],
            }],
        )
        .unwrap();
        assert_eq!(value, json!({"items": [2, 3, 4]}));
    }

    #[test]
    fn keys_with_slashes_and_tildes_are_escaped() {
        let mut value = json!({});
        apply(
            &mut value,
            &[Op::Replace {
                path: "/a~1b~0c".to_owned(),
                value: json!(1),
            }],
        )
        .unwrap();
        assert_eq!(value, json!({"a/b~c": 1}));
    }

    #[test]
    fn a_bad_index_is_an_error_not_a_panic() {
        let mut items = vec![1];
        assert_eq!(
            apply_diffs(&mut items, &[VectorDiff::Remove { index: 4 }]),
            Err(PatchError::OutOfRange { index: 4, len: 1 })
        );
    }
}
