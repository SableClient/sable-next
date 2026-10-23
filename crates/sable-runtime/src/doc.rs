use std::{collections::BTreeMap, mem};

use eyeball_im::VectorDiff;
use eyeball_im_util::vector::VectorObserverExt;
use futures_util::{FutureExt, StreamExt, stream};
use imbl::Vector;
use serde::{Serialize, de::DeserializeOwned};
use serde_json::{Value, json};

use crate::{
    error::AppError,
    patch::{PatchError, apply_diffs},
    rt::{SendOutsideWasm, SyncOutsideWasm},
    slice::Render,
    wire::{Op, Window},
};

fn encode<T: Serialize>(value: &T) -> Result<Value, AppError> {
    serde_json::to_value(value).map_err(|error| {
        tracing::error!(%error, "state does not serialize");
        AppError::Encode
    })
}

fn changed_fields(before: Option<&Value>, after: &Value) -> BTreeMap<String, Value> {
    let Value::Object(after) = after else {
        return BTreeMap::new();
    };
    let before = before.and_then(Value::as_object);
    after
        .iter()
        .filter(|(field, value)| before.and_then(|old| old.get(*field)) != Some(value))
        .map(|(field, value)| (field.clone(), value.clone()))
        .collect()
}

pub struct Doc<V> {
    view: V,
    before: Option<Value>,
    dirty: bool,
}

impl<V: Serialize> Doc<V> {
    pub const fn new(view: V) -> Self {
        Self {
            view,
            before: None,
            dirty: false,
        }
    }

    pub const fn view(&self) -> &V {
        &self.view
    }

    pub fn edit_fields(&mut self, edit: impl FnOnce(&mut V)) {
        if !self.dirty {
            self.before = encode(&self.view).ok();
        }
        edit(&mut self.view);
        self.dirty = true;
    }
}

impl<V: Serialize + DeserializeOwned> Doc<V> {
    #[must_use]
    pub fn from_cached(cached: Value) -> Option<Self> {
        serde_json::from_value(cached).ok().map(Self::new)
    }
}

impl<V: Serialize + SendOutsideWasm + 'static> Render for Doc<V> {
    type Changes = Vec<Op>;

    fn snapshot(&self, _window: Option<Window>) -> Result<Value, AppError> {
        encode(&self.view)
    }

    fn drain(&mut self) -> Result<Option<Vec<Op>>, AppError> {
        if !self.dirty {
            return Ok(None);
        }
        let after = encode(&self.view)?;
        let fields = changed_fields(self.before.as_ref(), &after);
        self.before = Some(after);
        self.dirty = false;
        Ok((!fields.is_empty()).then_some(vec![Op::Fields { fields }]))
    }

    fn project(&self, changes: &Vec<Op>, _window: Option<Window>) -> Result<Vec<Op>, AppError> {
        Ok(changes.clone())
    }

    fn clear(&mut self) {
        self.before = None;
        self.dirty = false;
    }
}

#[derive(Debug, Clone)]
pub struct ListChanges<T> {
    len_before: usize,
    len_after: usize,
    before: Vector<T>,
    diffs: Vec<VectorDiff<T>>,
}

#[derive(Debug, Clone)]
pub struct ListDoc<T> {
    items: Vec<T>,
    before: Vector<T>,
    pending: Vec<VectorDiff<T>>,
}

impl<T: Serialize + Clone> ListDoc<T> {
    #[must_use]
    pub fn new(items: Vec<T>) -> Self {
        Self {
            before: items.iter().cloned().collect(),
            items,
            pending: Vec::new(),
        }
    }

    #[must_use]
    pub fn items(&self) -> &[T] {
        &self.items
    }

    #[must_use]
    pub fn from_cached(cached: Value) -> Option<Self>
    where
        T: DeserializeOwned,
    {
        let Value::Object(mut cached) = cached else {
            return None;
        };
        serde_json::from_value(cached.remove("items")?)
            .ok()
            .map(Self::new)
    }

    pub fn apply(&mut self, diff: VectorDiff<T>) -> Result<(), PatchError> {
        apply_diffs(&mut self.items, std::slice::from_ref(&diff))?;
        self.pending.push(diff);
        Ok(())
    }

    #[expect(
        clippy::indexing_slicing,
        reason = "the window bounds are clamped to this list"
    )]
    fn window_items(&self, window: Option<Window>) -> &[T] {
        let Some(window) = window else {
            return &self.items;
        };
        let end = window.end.min(self.items.len());
        let start = window.start.min(end);
        &self.items[start..end]
    }
}

fn encode_diff<T: Serialize>(diff: VectorDiff<T>) -> Result<VectorDiff<Value>, AppError> {
    Ok(match diff {
        VectorDiff::Append { values } => VectorDiff::Append {
            values: values
                .into_iter()
                .map(|value| encode(&value))
                .collect::<Result<_, _>>()?,
        },
        VectorDiff::Clear => VectorDiff::Clear,
        VectorDiff::PushFront { value } => VectorDiff::PushFront {
            value: encode(&value)?,
        },
        VectorDiff::PushBack { value } => VectorDiff::PushBack {
            value: encode(&value)?,
        },
        VectorDiff::PopFront => VectorDiff::PopFront,
        VectorDiff::PopBack => VectorDiff::PopBack,
        VectorDiff::Insert { index, value } => VectorDiff::Insert {
            index,
            value: encode(&value)?,
        },
        VectorDiff::Set { index, value } => VectorDiff::Set {
            index,
            value: encode(&value)?,
        },
        VectorDiff::Remove { index } => VectorDiff::Remove { index },
        VectorDiff::Truncate { length } => VectorDiff::Truncate { length },
        VectorDiff::Reset { values } => VectorDiff::Reset {
            values: values
                .into_iter()
                .map(|value| encode(&value))
                .collect::<Result<_, _>>()?,
        },
    })
}

impl<T: Serialize + Clone + SendOutsideWasm + SyncOutsideWasm + 'static> Render for ListDoc<T> {
    type Changes = ListChanges<T>;

    fn snapshot(&self, window: Option<Window>) -> Result<Value, AppError> {
        Ok(json!({
            "total": self.items.len(),
            "items": self
                .window_items(window)
                .iter()
                .map(encode)
                .collect::<Result<Vec<_>, _>>()?,
        }))
    }

    fn drain(&mut self) -> Result<Option<ListChanges<T>>, AppError> {
        if self.pending.is_empty() {
            return Ok(None);
        }
        let before = self.before.clone();
        let diffs = mem::take(&mut self.pending);
        for diff in &diffs {
            diff.clone().apply(&mut self.before);
        }
        Ok(Some(ListChanges {
            len_before: before.len(),
            len_after: self.items.len(),
            before,
            diffs,
        }))
    }

    fn project(
        &self,
        changes: &ListChanges<T>,
        window: Option<Window>,
    ) -> Result<Vec<Op>, AppError> {
        let mut ops = Vec::with_capacity(2);
        if changes.len_after != changes.len_before {
            ops.push(Op::Fields {
                fields: BTreeMap::from([(String::from("total"), json!(changes.len_after))]),
            });
        }
        let diffs = if let Some(window) = window {
            let (_, diffs) = (changes.before.clone(), stream::iter(changes.diffs.clone()))
                .skip(window.start)
                .head(window.end.saturating_sub(window.start));
            diffs.collect().now_or_never().ok_or(AppError::Encode)?
        } else {
            changes.diffs.clone()
        };
        if !diffs.is_empty() {
            ops.push(Op::List {
                field: String::from("items"),
                diffs: diffs
                    .into_iter()
                    .map(encode_diff)
                    .collect::<Result<_, _>>()?,
            });
        }
        Ok(ops)
    }

    fn clear(&mut self) {
        for diff in self.pending.drain(..) {
            diff.apply(&mut self.before);
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };

    use proptest::prelude::*;
    use serde::{Deserialize, Serialize};
    use serde_json::json;

    use super::*;
    use crate::patch::apply;

    #[derive(Debug, PartialEq, Serialize, Deserialize)]
    struct Profile {
        name: String,
        count: u32,
        bio: Option<String>,
    }

    struct Broken;

    impl Serialize for Broken {
        fn serialize<S: serde::Serializer>(&self, _: S) -> Result<S::Ok, S::Error> {
            Err(serde::ser::Error::custom("broken"))
        }
    }

    fn profile() -> Doc<Profile> {
        Doc::new(Profile {
            name: "a".to_owned(),
            count: 0,
            bio: Some("x".to_owned()),
        })
    }

    #[test]
    fn a_doc_sends_changed_top_level_fields_once() {
        let mut doc = profile();
        doc.edit_fields(|view| view.count = 5);
        doc.edit_fields(|view| view.count = 6);
        assert_eq!(
            doc.drain().unwrap(),
            Some(vec![Op::Fields {
                fields: BTreeMap::from([(String::from("count"), json!(6))])
            }])
        );
        assert!(doc.drain().unwrap().is_none());
    }

    #[test]
    fn a_doc_compares_fields_by_value() {
        let mut doc = profile();
        doc.edit_fields(|view| view.count = 0);
        assert!(doc.drain().unwrap().is_none());
    }

    #[test]
    fn a_state_that_does_not_serialize_is_an_error_not_null() {
        let mut doc = Doc::new(Broken);
        assert_eq!(doc.snapshot(None), Err(AppError::Encode));
        doc.edit_fields(|_| {});
        assert_eq!(doc.drain().err(), Some(AppError::Encode));
    }

    #[test]
    fn a_cached_view_that_no_longer_fits_is_ignored() {
        assert!(Doc::<Profile>::from_cached(json!({"name": 3})).is_none());
        assert!(
            Doc::<Profile>::from_cached(json!({"name": "n", "count": 1, "bio": null})).is_some()
        );
    }

    #[test]
    fn clearing_forgets_what_was_edited_without_serializing() {
        let mut doc = Doc::new(Broken);
        doc.edit_fields(|_| {});
        doc.clear();
        assert!(doc.drain().unwrap().is_none());

        let mut list = ListDoc::new(vec![1]);
        list.apply(VectorDiff::PushBack { value: 2 }).unwrap();
        list.clear();
        assert!(list.drain().unwrap().is_none());
        assert_eq!(list.items(), [1, 2]);
    }

    #[test]
    fn clearing_a_batch_keeps_the_next_window_projection_current() {
        let mut list = list(6);
        list.apply(VectorDiff::Remove { index: 0 }).unwrap();
        list.clear();
        let window = Some(Window { start: 1, end: 3 });
        let mut replica = list.snapshot(window).unwrap();
        list.apply(VectorDiff::PopFront).unwrap();
        let changes = list.drain().unwrap().unwrap();
        apply(&mut replica, &list.project(&changes, window).unwrap()).unwrap();
        assert_eq!(replica, list.snapshot(window).unwrap());
    }

    #[test]
    fn empty_pops_and_oversized_truncation_are_valid_in_every_window() {
        let mut list = list(0);
        let windows = [
            None,
            Some(Window { start: 0, end: 3 }),
            Some(Window { start: 5, end: 2 }),
        ];
        let mut replicas = windows.map(|window| list.snapshot(window).unwrap());
        for diff in [
            VectorDiff::PopFront,
            VectorDiff::PopBack,
            VectorDiff::Truncate { length: usize::MAX },
            VectorDiff::PushFront { value: 1 },
            VectorDiff::Truncate { length: usize::MAX },
        ] {
            list.apply(diff).unwrap();
        }
        let changes = list.drain().unwrap().unwrap();
        for (window, replica) in windows.into_iter().zip(&mut replicas) {
            apply(replica, &list.project(&changes, window).unwrap()).unwrap();
            assert_eq!(*replica, list.snapshot(window).unwrap());
        }
    }

    #[test]
    fn a_cached_list_must_have_the_shape_of_its_view() {
        assert_eq!(
            ListDoc::<u32>::from_cached(json!({"total": 2, "items": [1, 2]}))
                .unwrap()
                .items(),
            [1, 2]
        );
        for wrong in [json!([1, 2]), json!({"total": 1}), json!({"items": ["x"]})] {
            assert!(ListDoc::<u32>::from_cached(wrong).is_none());
        }
    }

    fn list(count: usize) -> ListDoc<usize> {
        ListDoc::new((0..count).collect())
    }

    #[test]
    fn a_rejected_diff_leaves_no_trace() {
        let mut list = list(1);
        for diff in [
            VectorDiff::Insert { index: 2, value: 9 },
            VectorDiff::Set { index: 1, value: 9 },
            VectorDiff::Remove { index: 3 },
        ] {
            assert!(list.apply(diff).is_err());
        }
        assert!(list.drain().unwrap().is_none());
        assert_eq!(list.items(), [0]);
    }

    #[test]
    fn the_snapshot_holds_the_window_and_the_total() {
        let list = list(10);
        assert_eq!(
            list.snapshot(Some(Window { start: 2, end: 4 })).unwrap(),
            json!({"total": 10, "items": [2, 3]})
        );
        assert_eq!(
            list.snapshot(Some(Window { start: 8, end: 40 })).unwrap(),
            json!({"total": 10, "items": [8, 9]})
        );
    }

    #[test]
    fn a_list_change_has_a_field_update_and_a_direct_vector_diff() {
        let mut list = list(10);
        list.apply(VectorDiff::Insert {
            index: 0,
            value: 99,
        })
        .unwrap();
        let changes = list.drain().unwrap().unwrap();
        assert_eq!(
            list.project(&changes, Some(Window { start: 4, end: 6 }))
                .unwrap(),
            [
                Op::Fields {
                    fields: BTreeMap::from([(String::from("total"), json!(11))])
                },
                Op::List {
                    field: String::from("items"),
                    diffs: vec![
                        VectorDiff::PopBack,
                        VectorDiff::PushFront { value: json!(3) },
                    ],
                },
            ]
        );
    }

    #[derive(Clone)]
    struct Counted(usize, Arc<AtomicUsize>);

    impl Serialize for Counted {
        fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
            self.1.fetch_add(1, Ordering::SeqCst);
            serializer.serialize_u64(self.0 as u64)
        }
    }

    #[test]
    fn only_the_window_is_turned_into_json() {
        let counter = Arc::new(AtomicUsize::new(0));
        let mut list = ListDoc::new(Vec::new());
        list.apply(VectorDiff::Append {
            values: (0..1000)
                .map(|index| Counted(index, Arc::clone(&counter)))
                .collect(),
        })
        .unwrap();
        let changes = list.drain().unwrap().unwrap();
        let ops = list
            .project(
                &changes,
                Some(Window {
                    start: 990,
                    end: 2000,
                }),
            )
            .unwrap();
        assert_eq!(counter.load(Ordering::SeqCst), 10);
        assert_eq!(
            ops.last(),
            Some(&Op::List {
                field: String::from("items"),
                diffs: vec![VectorDiff::Append {
                    values: (990..1000).map(|index| json!(index)).collect()
                }]
            })
        );
    }

    fn row_for(seed: u8) -> Value {
        json!({
            "key": format!("k{}", seed % 3),
            "flag": seed.is_multiple_of(2),
            "tags": (0..seed % 3).collect::<Vec<_>>(),
            "inner": {"a": seed % 4, "deep": {"b": seed % 5, "c": {"d": seed % 2}}},
            "opt": seed.is_multiple_of(4).then_some(seed),
        })
    }

    fn diff_for(model: &[usize], kind: u8, a: usize, b: usize) -> Option<VectorDiff<usize>> {
        let len = model.len();
        Some(match kind % 11 {
            0 => VectorDiff::Append {
                values: (0..a % 4).map(|n| 1000 + n).collect(),
            },
            1 => VectorDiff::Clear,
            2 => VectorDiff::PushFront { value: 2000 + a },
            3 => VectorDiff::PushBack { value: 3000 + a },
            4 => (len > 0).then_some(VectorDiff::PopFront)?,
            5 => (len > 0).then_some(VectorDiff::PopBack)?,
            6 => VectorDiff::Insert {
                index: a % (len + 1),
                value: 4000 + b,
            },
            7 => (len > 0).then(|| VectorDiff::Set {
                index: a % len,
                value: 5000 + b,
            })?,
            8 => (len > 0).then(|| VectorDiff::Remove { index: a % len })?,
            9 => VectorDiff::Truncate {
                length: a % (len + 2),
            },
            _ => VectorDiff::Reset {
                values: (0..a % 12).map(|n| 6000 + n).collect(),
            },
        })
    }

    proptest! {
        #[test]
        fn patches_replay_to_a_fresh_snapshot(
            initial in 0usize..30,
            start in 0usize..35,
            width in 0usize..12,
            windowed in any::<bool>(),
            steps in proptest::collection::vec((any::<u8>(), 0usize..64, 0usize..64), 0..40),
        ) {
            let window = windowed.then_some(Window { start, end: start + width });
            let mut list = list(initial);
            let mut replica = list.snapshot(window).unwrap();

            for chunk in steps.chunks(3) {
                for &(kind, a, b) in chunk {
                    if let Some(diff) = diff_for(list.items(), kind, a, b) {
                        list.apply(diff).unwrap();
                    }
                }
                if let Some(changes) = list.drain().unwrap() {
                    apply(&mut replica, &list.project(&changes, window).unwrap()).unwrap();
                }
                prop_assert_eq!(&replica, &list.snapshot(window).unwrap());
            }
        }
    }

    proptest! {
        #[test]
        fn changed_rows_are_sent_as_whole_set_values(
            start in 0usize..6,
            width in 0usize..6,
            windowed in any::<bool>(),
            steps in proptest::collection::vec((0u8..4, 0usize..8, any::<u8>()), 0..30),
        ) {
            let window = windowed.then_some(Window { start, end: start + width });
            let mut list = ListDoc::new((0..6).map(row_for).collect());
            let mut replica = list.snapshot(window).unwrap();
            for chunk in steps.chunks(2) {
                for &(kind, at, seed) in chunk {
                    let len = list.items().len();
                    let diff = match kind {
                        0 if len > 0 => VectorDiff::Set { index: at % len, value: row_for(seed) },
                        1 => VectorDiff::PushBack { value: row_for(seed) },
                        2 if len > 0 => VectorDiff::Remove { index: at % len },
                        _ => VectorDiff::Insert { index: at % (len + 1), value: row_for(seed) },
                    };
                    list.apply(diff).unwrap();
                }
                if let Some(changes) = list.drain().unwrap() {
                    apply(&mut replica, &list.project(&changes, window).unwrap()).unwrap();
                }
                prop_assert_eq!(&replica, &list.snapshot(window).unwrap());
            }
        }
    }
}
