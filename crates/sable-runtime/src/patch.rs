use eyeball_im::VectorDiff;
#[cfg(any(test, feature = "testing"))]
use serde_json::Value;

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum PatchError {
    #[error("missing field `{0}`")]
    Missing(String),
    #[error("field `{0}` is not a list")]
    NotAList(String),
    #[error("index {index} is out of range for a list of {len}")]
    OutOfRange { index: usize, len: usize },
}

#[cfg(any(test, feature = "testing"))]
pub fn apply(target: &mut Value, ops: &[crate::wire::Op]) -> Result<(), PatchError> {
    for op in ops {
        match op {
            crate::wire::Op::Fields { fields } => {
                let Value::Object(target) = target else {
                    return Err(PatchError::NotAList(String::new()));
                };
                target.extend(fields.clone());
            }
            crate::wire::Op::List { field, diffs } => {
                let Value::Object(target) = target else {
                    return Err(PatchError::Missing(field.clone()));
                };
                let Some(Value::Array(items)) = target.get_mut(field) else {
                    return Err(PatchError::NotAList(field.clone()));
                };
                apply_diffs(items, diffs)?;
            }
        }
    }
    Ok(())
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
            VectorDiff::Reset { values } => {
                items.clear();
                items.extend(values.iter().cloned());
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use eyeball_im::VectorDiff;
    use serde_json::json;

    use super::*;

    #[test]
    fn fields_replace_values_and_lists_apply_diffs() {
        let mut value = json!({"total": 2, "items": [1, 2, 3]});
        apply(
            &mut value,
            &[
                crate::wire::Op::Fields {
                    fields: [
                        (String::from("total"), json!(4)),
                        (String::from("other"), json!(true)),
                    ]
                    .into_iter()
                    .collect(),
                },
                crate::wire::Op::List {
                    field: String::from("items"),
                    diffs: vec![
                        VectorDiff::Remove { index: 0 },
                        VectorDiff::PushBack { value: json!(4) },
                    ],
                },
            ],
        )
        .unwrap();
        assert_eq!(
            value,
            json!({"total": 4, "items": [2, 3, 4], "other": true})
        );
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
