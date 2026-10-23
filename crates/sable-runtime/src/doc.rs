use std::mem;

use sable_protocol::VectorDiff;
use serde::{Serialize, de::DeserializeOwned};
use serde_json::{Value, json};

use crate::{
    error::AppError,
    patch::{PatchError, apply_diffs},
    rt::SendOutsideWasm,
    slice::Render,
    wire::{Op, Window},
};

const ITEMS_PATH: &str = "/items";
const TOTAL_PATH: &str = "/total";

fn encode<T: Serialize>(value: &T) -> Result<Value, AppError> {
    serde_json::to_value(value).map_err(|error| {
        tracing::error!(%error, "state does not serialize");
        AppError::Encode
    })
}

enum Dirty {
    Clean,
    Paths(Vec<String>),
    Whole,
}

/// An untouched document drains in O(1); a touched one is serialized once and cut
/// down to the edited paths.
pub struct Doc<V> {
    view: V,
    dirty: Dirty,
}

impl<V: Serialize> Doc<V> {
    pub const fn new(view: V) -> Self {
        Self {
            view,
            dirty: Dirty::Clean,
        }
    }

    pub const fn view(&self) -> &V {
        &self.view
    }

    /// Edits the document, which is then sent whole.
    pub fn view_mut(&mut self) -> &mut V {
        self.dirty = Dirty::Whole;
        &mut self.view
    }

    /// Edits the document, which is then sent as the value at `path` alone: a
    /// JSON pointer to an object field that `edit` changes and nothing else.
    pub fn edit(&mut self, path: &str, edit: impl FnOnce(&mut V)) {
        edit(&mut self.view);
        match &mut self.dirty {
            Dirty::Whole => {}
            Dirty::Clean => self.dirty = Dirty::Paths(vec![path.to_owned()]),
            Dirty::Paths(paths) => {
                if !paths.iter().any(|known| known == path) {
                    paths.push(path.to_owned());
                }
            }
        }
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
        let paths = match mem::replace(&mut self.dirty, Dirty::Clean) {
            Dirty::Clean => return Ok(None),
            Dirty::Whole => {
                return Ok(Some(vec![Op::Replace {
                    path: String::new(),
                    value: encode(&self.view)?,
                }]));
            }
            Dirty::Paths(paths) => paths,
        };
        let whole = encode(&self.view)?;
        Ok(Some(
            paths
                .into_iter()
                .map(|path| match whole.pointer(&path) {
                    Some(value) => Op::Replace {
                        value: value.clone(),
                        path,
                    },
                    None => Op::Remove { path },
                })
                .collect(),
        ))
    }

    fn project(&self, changes: &Vec<Op>, _window: Option<Window>) -> Result<Vec<Op>, AppError> {
        Ok(changes.clone())
    }
}

/// Diffs stay as items and become JSON only for the part a subscriber follows.
#[derive(Debug, Clone)]
pub struct ListChanges<T> {
    len_before: usize,
    len_after: usize,
    diffs: Vec<VectorDiff<T>>,
}

/// Exposed as `{ "total": n, "items": [...] }`.
#[derive(Debug, Clone)]
pub struct ListDoc<T> {
    items: Vec<T>,
    len_before: usize,
    pending: Vec<VectorDiff<T>>,
}

impl<T: Serialize + Clone> ListDoc<T> {
    #[must_use]
    pub const fn new(items: Vec<T>) -> Self {
        Self {
            len_before: items.len(),
            items,
            pending: Vec::new(),
        }
    }

    #[must_use]
    pub fn items(&self) -> &[T] {
        &self.items
    }

    /// # Errors
    ///
    /// An index past the end, leaving the list as it was.
    pub fn apply(&mut self, diff: VectorDiff<T>) -> Result<(), PatchError> {
        apply_diffs(&mut self.items, std::slice::from_ref(&diff))?;
        self.pending.push(diff);
        Ok(())
    }

    fn window_items(&self, window: Option<Window>) -> &[T] {
        let Some(window) = window else {
            return &self.items;
        };
        let end = window.end.min(self.items.len());
        let start = window.start.min(end);
        self.items.get(start..end).unwrap_or_default()
    }
}

fn values<T: Serialize>(items: &[T]) -> Result<Vec<Value>, AppError> {
    items.iter().map(encode).collect()
}

fn encode_diff<T: Serialize>(diff: &VectorDiff<T>) -> Result<VectorDiff<Value>, AppError> {
    Ok(match diff {
        VectorDiff::Append { values: items } => VectorDiff::Append {
            values: values(items)?,
        },
        VectorDiff::Clear => VectorDiff::Clear,
        VectorDiff::PushFront { value } => VectorDiff::PushFront {
            value: encode(value)?,
        },
        VectorDiff::PushBack { value } => VectorDiff::PushBack {
            value: encode(value)?,
        },
        VectorDiff::PopFront => VectorDiff::PopFront,
        VectorDiff::PopBack => VectorDiff::PopBack,
        VectorDiff::Insert { index, value } => VectorDiff::Insert {
            index: *index,
            value: encode(value)?,
        },
        VectorDiff::Set { index, value } => VectorDiff::Set {
            index: *index,
            value: encode(value)?,
        },
        VectorDiff::Remove { index } => VectorDiff::Remove { index: *index },
        VectorDiff::Truncate { length } => VectorDiff::Truncate { length: *length },
        VectorDiff::Reset { values: items } => VectorDiff::Reset {
            values: values(items)?,
        },
    })
}

impl<T: Serialize + Clone + SendOutsideWasm + 'static> Render for ListDoc<T> {
    type Changes = ListChanges<T>;

    fn snapshot(&self, window: Option<Window>) -> Result<Value, AppError> {
        Ok(json!({
            "total": self.items.len(),
            "items": values(self.window_items(window))?,
        }))
    }

    fn drain(&mut self) -> Result<Option<ListChanges<T>>, AppError> {
        let len_before = mem::replace(&mut self.len_before, self.items.len());
        let diffs = mem::take(&mut self.pending);
        Ok((!diffs.is_empty()).then(|| ListChanges {
            len_before,
            len_after: self.items.len(),
            diffs,
        }))
    }

    fn project(
        &self,
        changes: &ListChanges<T>,
        window: Option<Window>,
    ) -> Result<Vec<Op>, AppError> {
        let diffs = match window {
            None => changes
                .diffs
                .iter()
                .map(encode_diff)
                .collect::<Result<Vec<_>, _>>()?,
            Some(window) => match window_diffs(changes.len_before, &changes.diffs, window) {
                Some(diffs) => diffs
                    .iter()
                    .map(encode_diff)
                    .collect::<Result<Vec<_>, _>>()?,
                None => vec![VectorDiff::Reset {
                    values: values(self.window_items(Some(window)))?,
                }],
            },
        };
        let mut ops = Vec::with_capacity(2);
        if changes.len_after != changes.len_before {
            ops.push(Op::Replace {
                path: TOTAL_PATH.to_owned(),
                value: json!(changes.len_after),
            });
        }
        if !diffs.is_empty() {
            ops.push(Op::List {
                path: ITEMS_PATH.to_owned(),
                diffs,
            });
        }
        Ok(ops)
    }
}

/// In window coordinates, or `None` when only a fresh copy of the window can express an edit.
fn window_diffs<T: Clone>(
    len_before: usize,
    diffs: &[VectorDiff<T>],
    window: Window,
) -> Option<Vec<VectorDiff<T>>> {
    let (start, end) = (window.start, window.end);
    let width = end.saturating_sub(start);
    let mut len = len_before;
    let mut out = Vec::new();
    for diff in diffs {
        match diff {
            VectorDiff::Set { index, value } => {
                if (start..end).contains(index) {
                    out.push(VectorDiff::Set {
                        index: index - start,
                        value: value.clone(),
                    });
                }
            }
            VectorDiff::Insert { index, value } => {
                if *index < start {
                    return None;
                }
                if *index < end {
                    let held = len.saturating_sub(start).min(width);
                    out.push(VectorDiff::Insert {
                        index: index - start,
                        value: value.clone(),
                    });
                    if held == width {
                        out.push(VectorDiff::Truncate { length: width });
                    }
                }
                len += 1;
            }
            VectorDiff::Remove { index } => {
                if *index < start || (len > end && *index < end) {
                    return None;
                }
                if *index < end {
                    out.push(VectorDiff::Remove {
                        index: index - start,
                    });
                }
                len = len.saturating_sub(1);
            }
            VectorDiff::PushBack { value } => {
                if (start..end).contains(&len) {
                    out.push(VectorDiff::PushBack {
                        value: value.clone(),
                    });
                }
                len += 1;
            }
            VectorDiff::Append { values } => {
                let first = start.max(len);
                let last = end.min(len + values.len());
                if first < last {
                    out.push(VectorDiff::Append {
                        values: values
                            .iter()
                            .skip(first - len)
                            .take(last - first)
                            .cloned()
                            .collect(),
                    });
                }
                len += values.len();
            }
            VectorDiff::PopBack => {
                if len > 0 && (start..end).contains(&(len - 1)) {
                    out.push(VectorDiff::PopBack);
                }
                len = len.saturating_sub(1);
            }
            VectorDiff::Truncate { length } => {
                if *length < len && *length < end {
                    out.push(VectorDiff::Truncate {
                        length: length.saturating_sub(start),
                    });
                }
                len = len.min(*length);
            }
            VectorDiff::Clear => {
                out.push(VectorDiff::Clear);
                len = 0;
            }
            VectorDiff::Reset { values } => {
                out.push(VectorDiff::Reset {
                    values: values.iter().skip(start).take(width).cloned().collect(),
                });
                len = values.len();
            }
            VectorDiff::PushFront { .. } | VectorDiff::PopFront => return None,
        }
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };

    use proptest::prelude::*;
    use serde::Deserialize;

    use super::*;
    use crate::patch::apply;

    #[derive(Debug, PartialEq, Serialize, Deserialize)]
    struct Profile {
        name: String,
        count: u32,
        bio: Option<String>,
    }

    fn profile() -> Doc<Profile> {
        Doc::new(Profile {
            name: "a".to_owned(),
            count: 0,
            bio: Some("x".to_owned()),
        })
    }

    #[test]
    fn an_untouched_doc_drains_to_nothing() {
        assert!(profile().drain().unwrap().is_none());
    }

    #[test]
    fn an_edit_sends_only_its_path() {
        let mut doc = profile();
        doc.edit("/count", |view| view.count = 5);
        doc.edit("/count", |view| view.count = 6);
        assert_eq!(
            doc.drain().unwrap(),
            Some(vec![Op::Replace {
                path: "/count".to_owned(),
                value: json!(6)
            }])
        );
        assert!(doc.drain().unwrap().is_none());
    }

    #[test]
    fn a_field_that_went_missing_is_removed() {
        #[derive(Serialize)]
        struct Sparse {
            #[serde(skip_serializing_if = "Option::is_none")]
            bio: Option<String>,
        }

        let mut doc = Doc::new(Sparse {
            bio: Some("x".to_owned()),
        });
        doc.edit("/bio", |view| view.bio = None);
        assert_eq!(
            doc.drain().unwrap(),
            Some(vec![Op::Remove {
                path: "/bio".to_owned()
            }])
        );
    }

    #[test]
    fn a_whole_edit_wins_over_path_edits() {
        let mut doc = profile();
        doc.edit("/count", |view| view.count = 1);
        doc.view_mut().name = "b".to_owned();
        let ops = doc.drain().unwrap().unwrap();
        assert_eq!(ops.len(), 1);
        assert!(matches!(&ops[0], Op::Replace { path, .. } if path.is_empty()));
    }

    #[test]
    fn a_state_that_does_not_serialize_is_an_error_not_null() {
        struct Broken;

        impl Serialize for Broken {
            fn serialize<S: serde::Serializer>(&self, _: S) -> Result<S::Ok, S::Error> {
                Err(serde::ser::Error::custom("broken"))
            }
        }

        let mut doc = Doc::new(Broken);
        assert_eq!(doc.snapshot(None), Err(AppError::Encode));
        let _ = doc.view_mut();
        assert_eq!(doc.drain().err(), Some(AppError::Encode));
    }

    #[test]
    fn a_cached_view_that_no_longer_fits_is_ignored() {
        assert!(Doc::<Profile>::from_cached(json!({"name": 3})).is_none());
        assert!(
            Doc::<Profile>::from_cached(json!({"name": "n", "count": 1, "bio": null})).is_some()
        );
    }

    fn list(count: usize) -> ListDoc<usize> {
        ListDoc::new((0..count).collect())
    }

    #[test]
    fn a_list_drains_what_happened_once() {
        let mut list = list(2);
        list.apply(VectorDiff::PushBack { value: 9 }).unwrap();
        let changes = list.drain().unwrap().unwrap();
        assert_eq!((changes.len_before, changes.len_after), (2, 3));
        assert!(list.drain().unwrap().is_none());
    }

    #[test]
    fn a_rejected_diff_leaves_no_trace() {
        let mut list = list(1);
        assert!(list.apply(VectorDiff::Remove { index: 3 }).is_err());
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
    fn an_insert_before_the_window_resets_it() {
        let mut list = list(10);
        list.apply(VectorDiff::Insert {
            index: 0,
            value: 99,
        })
        .unwrap();
        let changes = list.drain().unwrap().unwrap();
        let ops = list
            .project(&changes, Some(Window { start: 4, end: 6 }))
            .unwrap();
        assert_eq!(
            ops,
            [
                Op::Replace {
                    path: TOTAL_PATH.to_owned(),
                    value: json!(11)
                },
                Op::List {
                    path: ITEMS_PATH.to_owned(),
                    diffs: vec![VectorDiff::Reset {
                        values: vec![json!(3), json!(4)]
                    }]
                }
            ]
        );
    }

    #[test]
    fn edits_after_the_window_are_invisible_to_it() {
        let mut list = list(10);
        list.apply(VectorDiff::PushBack { value: 7 }).unwrap();
        list.apply(VectorDiff::Set { index: 8, value: 5 }).unwrap();
        let changes = list.drain().unwrap().unwrap();
        let ops = list
            .project(&changes, Some(Window { start: 0, end: 3 }))
            .unwrap();
        assert!(ops.iter().all(|op| !matches!(op, Op::List { .. })));
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
                path: ITEMS_PATH.to_owned(),
                diffs: vec![VectorDiff::Append {
                    values: (990..1000).map(|index| json!(index)).collect()
                }]
            })
        );
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
        fn window_patches_replay_to_a_fresh_window(
            initial in 0usize..30,
            start in 0usize..35,
            width in 0usize..12,
            steps in proptest::collection::vec((any::<u8>(), 0usize..64, 0usize..64), 0..40),
        ) {
            let window = Some(Window { start, end: start + width });
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

        #[test]
        fn unwindowed_patches_replay_to_the_whole_list(
            initial in 0usize..30,
            steps in proptest::collection::vec((any::<u8>(), 0usize..64, 0usize..64), 0..40),
        ) {
            let mut list = list(initial);
            let mut replica = list.snapshot(None).unwrap();
            for &(kind, a, b) in &steps {
                if let Some(diff) = diff_for(list.items(), kind, a, b) {
                    list.apply(diff).unwrap();
                }
                if let Some(changes) = list.drain().unwrap() {
                    apply(&mut replica, &list.project(&changes, None).unwrap()).unwrap();
                }
                prop_assert_eq!(&replica, &list.snapshot(None).unwrap());
            }
        }
    }
}
