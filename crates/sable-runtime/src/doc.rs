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

fn covers(outer: &str, inner: &str) -> bool {
    inner
        .strip_prefix(outer)
        .is_some_and(|rest| rest.is_empty() || rest.starts_with('/'))
}

fn add_path(paths: &mut Vec<String>, path: &str) {
    if paths.iter().any(|known| covers(known, path)) {
        return;
    }
    paths.retain(|known| !covers(path, known));
    paths.push(path.to_owned());
}

fn sendable<'a>(whole: &Value, path: &'a str) -> &'a str {
    path.match_indices('/')
        .filter_map(|(end, _)| path.get(..end))
        .find(|prefix| whole.pointer(prefix).is_some_and(Value::is_array))
        .unwrap_or(path)
}

fn encode<T: Serialize>(value: &T) -> Result<Value, AppError> {
    serde_json::to_value(value).map_err(|error| {
        tracing::error!(%error, "state does not serialize");
        AppError::Encode
    })
}

const FIELD_DEPTH: usize = 3;

#[must_use]
fn pointer_token(key: &str) -> String {
    key.replace('~', "~0").replace('/', "~1")
}

fn field_ops(old: &Value, new: &Value, path: &str, depth: usize, ops: &mut Vec<Op>) {
    if old == new {
        return;
    }
    let (Value::Object(old_fields), Value::Object(new_fields), true) =
        (old, new, depth < FIELD_DEPTH)
    else {
        ops.push(Op::Replace {
            path: path.to_owned(),
            value: new.clone(),
        });
        return;
    };
    for (key, value) in new_fields {
        let path = format!("{path}/{}", pointer_token(key));
        match old_fields.get(key) {
            Some(before) => field_ops(before, value, &path, depth + 1, ops),
            None => ops.push(Op::Replace {
                path,
                value: value.clone(),
            }),
        }
    }
    for key in old_fields
        .keys()
        .filter(|key| !new_fields.contains_key(*key))
    {
        ops.push(Op::Remove {
            path: format!("{path}/{}", pointer_token(key)),
        });
    }
}

fn op_size(op: &Op) -> usize {
    serde_json::to_string(op).map_or(usize::MAX, |json| json.len())
}

enum Dirty {
    Clean,
    Paths(Vec<String>),
    Whole,
}

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

    fn mark(&mut self, path: &str) {
        match &mut self.dirty {
            Dirty::Whole => (),
            Dirty::Clean => self.dirty = Dirty::Paths(vec![path.to_owned()]),
            Dirty::Paths(paths) => add_path(paths, path),
        }
    }

    pub fn edit_fields(&mut self, edit: impl FnOnce(&mut V)) {
        if matches!(self.dirty, Dirty::Whole) {
            edit(&mut self.view);
            return;
        }
        let before = encode(&self.view);
        edit(&mut self.view);
        let (Ok(Value::Object(before)), Ok(Value::Object(after))) = (before, encode(&self.view))
        else {
            self.dirty = Dirty::Whole;
            return;
        };
        let changed = after
            .iter()
            .filter(|(key, value)| before.get(*key) != Some(value))
            .map(|(key, _)| key)
            .chain(before.keys().filter(|key| !after.contains_key(*key)));
        let paths: Vec<String> = changed
            .map(|key| format!("/{}", pointer_token(key)))
            .collect();
        for path in paths {
            self.mark(&path);
        }
    }

    /// Only the value at `path` is sent, so `edit` must change nothing outside it.
    /// A path into an array sends the whole array.
    pub fn edit(&mut self, path: &str, edit: impl FnOnce(&mut V)) {
        edit(&mut self.view);
        self.mark(path);
    }

    pub fn set<T: PartialEq>(
        &mut self,
        path: &str,
        field: impl FnOnce(&mut V) -> &mut T,
        value: T,
    ) {
        let field = field(&mut self.view);
        if *field != value {
            *field = value;
            self.mark(path);
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
        let mut sent = Vec::with_capacity(paths.len());
        let mut ops = Vec::new();
        if !paths.is_empty() {
            let whole = encode(&self.view)?;
            for path in &paths {
                add_path(&mut sent, sendable(&whole, path));
            }
            ops.extend(sent.iter().map(|path| {
                whole.pointer(path).map_or_else(
                    || Op::Remove { path: path.clone() },
                    |value| Op::Replace {
                        value: value.clone(),
                        path: path.clone(),
                    },
                )
            }));
        }
        Ok(Some(ops))
    }

    fn project(&self, changes: &Vec<Op>, _window: Option<Window>) -> Result<Vec<Op>, AppError> {
        Ok(changes.clone())
    }

    fn clear(&mut self) {
        self.dirty = Dirty::Clean;
    }
}

#[derive(Debug, Clone)]
struct Edit<T> {
    diff: VectorDiff<T>,
    replaced: Option<T>,
}

impl<T> Edit<T> {
    const fn plain(diff: VectorDiff<T>) -> Self {
        Self {
            diff,
            replaced: None,
        }
    }
}

#[derive(Debug, Clone)]
pub struct ListChanges<T> {
    len_before: usize,
    len_after: usize,
    edits: Vec<Edit<T>>,
}

#[derive(Debug, Clone)]
pub struct ListDoc<T> {
    items: Vec<T>,
    len_before: usize,
    pending: Vec<Edit<T>>,
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
        let replaced = match &diff {
            VectorDiff::Set { index, .. } => self.items.get(*index).cloned(),
            _ => None,
        };
        apply_diffs(&mut self.items, std::slice::from_ref(&diff))?;
        self.pending.push(Edit { diff, replaced });
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

fn set_fields<T: Serialize>(path: &str, edit: &Edit<T>) -> Result<Option<Vec<Op>>, AppError> {
    let (VectorDiff::Set { index, value }, Some(replaced)) = (&edit.diff, &edit.replaced) else {
        return Ok(None);
    };
    let (old, new) = (encode(replaced)?, encode(value)?);
    if !old.is_object() || !new.is_object() {
        return Ok(None);
    }
    let mut ops = Vec::new();
    field_ops(&old, &new, &format!("{path}/{index}"), 0, &mut ops);
    let sent: usize = ops.iter().map(op_size).sum();
    Ok((sent < new.to_string().len()).then_some(ops))
}

fn flush(path: &str, run: &mut Vec<VectorDiff<Value>>, ops: &mut Vec<Op>) {
    if run.is_empty() {
        return;
    }
    match ops.last_mut() {
        Some(Op::List { path: last, diffs }) if last == path => diffs.append(run),
        _ => ops.push(Op::List {
            path: path.to_owned(),
            diffs: mem::take(run),
        }),
    }
}

fn list_ops<T: Serialize>(
    path: &str,
    edits: &[Edit<T>],
    ops: &mut Vec<Op>,
) -> Result<(), AppError> {
    let mut run = Vec::new();
    for edit in edits {
        if let Some(fields) = set_fields(path, edit)? {
            flush(path, &mut run, ops);
            ops.extend(fields);
        } else {
            run.push(encode_diff(&edit.diff)?);
        }
    }
    flush(path, &mut run, ops);
    Ok(())
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
        let edits = mem::take(&mut self.pending);
        Ok((!edits.is_empty()).then(|| ListChanges {
            len_before,
            len_after: self.items.len(),
            edits,
        }))
    }

    fn project(
        &self,
        changes: &ListChanges<T>,
        window: Option<Window>,
    ) -> Result<Vec<Op>, AppError> {
        let mut ops = Vec::with_capacity(2);
        if changes.len_after != changes.len_before {
            ops.push(Op::Replace {
                path: TOTAL_PATH.to_owned(),
                value: json!(changes.len_after),
            });
        }
        match window {
            None => list_ops(ITEMS_PATH, &changes.edits, &mut ops)?,
            Some(window) => match window_edits(changes.len_before, &changes.edits, window) {
                Some(edits) => list_ops(ITEMS_PATH, &edits, &mut ops)?,
                None => ops.push(Op::List {
                    path: ITEMS_PATH.to_owned(),
                    diffs: vec![VectorDiff::Reset {
                        values: values(self.window_items(Some(window)))?,
                    }],
                }),
            },
        }
        Ok(ops)
    }

    fn clear(&mut self) {
        self.len_before = self.items.len();
        self.pending.clear();
    }
}

fn window_edits<T: Clone>(
    len_before: usize,
    edits: &[Edit<T>],
    window: Window,
) -> Option<Vec<Edit<T>>> {
    let (start, end) = (window.start, window.end);
    let width = end.saturating_sub(start);
    let mut len = len_before;
    let mut out = Vec::new();
    for Edit { diff, replaced } in edits {
        match diff {
            VectorDiff::Set { index, value } => {
                if (start..end).contains(index) {
                    out.push(Edit {
                        diff: VectorDiff::Set {
                            index: index - start,
                            value: value.clone(),
                        },
                        replaced: replaced.clone(),
                    });
                }
            }
            VectorDiff::Insert { index, value } => {
                if *index < start {
                    return None;
                }
                if *index < end {
                    let held = len.saturating_sub(start).min(width);
                    out.push(Edit::plain(VectorDiff::Insert {
                        index: index - start,
                        value: value.clone(),
                    }));
                    if held == width {
                        out.push(Edit::plain(VectorDiff::Truncate { length: width }));
                    }
                }
                len += 1;
            }
            VectorDiff::Remove { index } => {
                if *index < start || (len > end && *index < end) {
                    return None;
                }
                if *index < end {
                    out.push(Edit::plain(VectorDiff::Remove {
                        index: index - start,
                    }));
                }
                len = len.saturating_sub(1);
            }
            VectorDiff::PushBack { value } => {
                if (start..end).contains(&len) {
                    out.push(Edit::plain(VectorDiff::PushBack {
                        value: value.clone(),
                    }));
                }
                len += 1;
            }
            VectorDiff::Append { values } => {
                let first = start.max(len);
                let last = end.min(len + values.len());
                if first < last {
                    out.push(Edit::plain(VectorDiff::Append {
                        values: values
                            .iter()
                            .skip(first - len)
                            .take(last - first)
                            .cloned()
                            .collect(),
                    }));
                }
                len += values.len();
            }
            VectorDiff::PopBack => {
                if len > 0 && (start..end).contains(&(len - 1)) {
                    out.push(Edit::plain(VectorDiff::PopBack));
                }
                len = len.saturating_sub(1);
            }
            VectorDiff::Truncate { length } => {
                if *length < len && *length < end {
                    out.push(Edit::plain(VectorDiff::Truncate {
                        length: length.saturating_sub(start),
                    }));
                }
                len = len.min(*length);
            }
            VectorDiff::Clear => {
                out.push(Edit::plain(VectorDiff::Clear));
                len = 0;
            }
            VectorDiff::Reset { values } => {
                out.push(Edit::plain(VectorDiff::Reset {
                    values: values.iter().skip(start).take(width).cloned().collect(),
                }));
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
    fn a_state_that_does_not_serialize_is_an_error_not_null() {
        let mut doc = Doc::new(Broken);
        assert_eq!(doc.snapshot(None), Err(AppError::Encode));
        doc.edit("", |_| {});
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
    fn overlapping_paths_collapse_to_the_shallowest_and_siblings_stay_apart() {
        let root = json!({"a": {"b": 1, "bb": 2}, "rows": [{"x": 1}, {"x": 2}], "c": 3});
        for (edits, sent) in [
            (["/a/b", "/a"], vec!["/a"]),
            (["/a", "/a/b"], vec!["/a"]),
            (["/a/b", "/a/bb"], vec!["/a/b", "/a/bb"]),
            (["/rows/1/x", "/rows/0"], vec!["/rows"]),
        ] {
            let mut doc = Doc::new(root.clone());
            for path in edits {
                doc.edit(path, |_| {});
            }
            let expected: Vec<Op> = sent
                .iter()
                .map(|path| Op::Replace {
                    path: (*path).to_owned(),
                    value: root.pointer(path).unwrap().clone(),
                })
                .collect();
            assert_eq!(doc.drain().unwrap(), Some(expected), "{edits:?}");
        }
    }

    #[test]
    fn clearing_forgets_what_was_edited_without_serializing() {
        let mut doc = Doc::new(Broken);
        doc.edit("", |_| {});
        doc.clear();
        assert!(doc.drain().unwrap().is_none());

        let mut list = ListDoc::new(vec![1]);
        list.apply(VectorDiff::PushBack { value: 2 }).unwrap();
        list.clear();
        assert!(list.drain().unwrap().is_none());
        assert_eq!(list.items(), [1, 2]);
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

    fn rows() -> ListDoc<Value> {
        ListDoc::new(vec![
            json!({"id": "a", "read": ["x"], "item": {"body": "hello world, a message long enough that its row is dearer than one field", "edited": false}}),
            json!({"id": "b", "read": [], "item": {"body": "hello world, a message long enough that its row is dearer than one field", "edited": false}}),
        ])
    }

    fn projected(list: &mut ListDoc<Value>, window: Option<Window>) -> Vec<Op> {
        let changes = list.drain().unwrap().unwrap();
        list.project(&changes, window).unwrap()
    }

    #[test]
    fn a_set_sends_the_fields_that_changed() {
        let mut list = rows();
        let mut row = list.items()[0].clone();
        row["read"] = json!([]);
        row["item"]["edited"] = json!(true);
        list.apply(VectorDiff::Set {
            index: 0,
            value: row,
        })
        .unwrap();
        assert_eq!(
            projected(&mut list, None),
            [
                Op::Replace {
                    path: "/items/0/read".to_owned(),
                    value: json!([])
                },
                Op::Replace {
                    path: "/items/0/item/edited".to_owned(),
                    value: json!(true)
                },
            ]
        );
    }

    #[test]
    fn a_field_in_a_window_is_named_in_window_coordinates() {
        let mut list = rows();
        let mut row = list.items()[1].clone();
        row["id"] = json!("c");
        list.apply(VectorDiff::Set {
            index: 1,
            value: row,
        })
        .unwrap();
        assert_eq!(
            projected(&mut list, Some(Window { start: 1, end: 2 })),
            [Op::Replace {
                path: "/items/0/id".to_owned(),
                value: json!("c")
            }]
        );
    }

    #[test]
    fn a_set_that_changes_nothing_sends_nothing() {
        let mut list = rows();
        let row = list.items()[0].clone();
        list.apply(VectorDiff::Set {
            index: 0,
            value: row,
        })
        .unwrap();
        assert_eq!(projected(&mut list, None), Vec::new());
    }

    #[test]
    fn a_row_replaced_for_the_most_part_is_sent_whole() {
        let mut list = rows();
        list.apply(VectorDiff::Set {
            index: 0,
            value: json!({"id": "z", "read": ["y", "w"], "item": {"body": "other", "edited": true}}),
        })
        .unwrap();
        let ops = projected(&mut list, None);
        assert!(matches!(
            ops.as_slice(),
            [Op::List { diffs, .. }] if matches!(diffs.as_slice(), [VectorDiff::Set { .. }])
        ));
    }

    #[test]
    fn a_removed_field_and_an_awkward_key_are_named_in_the_path() {
        let before = json!({
            "seen": {"a/b": 1, "~": 2},
            "note": "n".repeat(200),
            "gone": "x"
        });
        let mut list = ListDoc::new(vec![before.clone()]);
        let mut replica = json!({"total": 1, "items": [before]});
        let mut row = before;
        row["seen"]["a/b"] = json!(5);
        row["seen"]["~"] = json!(6);
        row.as_object_mut().unwrap().remove("gone");
        list.apply(VectorDiff::Set {
            index: 0,
            value: row.clone(),
        })
        .unwrap();
        let ops = projected(&mut list, None);
        for path in ["/items/0/seen/a~1b", "/items/0/seen/~0"] {
            assert!(
                ops.iter()
                    .any(|op| matches!(op, Op::Replace { path: sent, .. } if sent == path))
            );
        }
        assert!(
            ops.iter()
                .any(|op| matches!(op, Op::Remove { path } if path == "/items/0/gone"))
        );
        apply(&mut replica, &ops).unwrap();
        assert_eq!(replica["items"][0], row);
    }

    #[test]
    fn editing_fields_sends_only_the_ones_that_changed() {
        let mut doc = profile();
        doc.edit_fields(|view| {
            view.count = 3;
            view.bio = None;
        });
        assert_eq!(
            doc.drain().unwrap(),
            Some(vec![
                Op::Replace {
                    path: "/count".to_owned(),
                    value: json!(3)
                },
                Op::Replace {
                    path: "/bio".to_owned(),
                    value: json!(null)
                },
            ])
        );
        doc.edit_fields(|view| view.count = 3);
        assert!(doc.drain().unwrap().is_none());
    }

    #[test]
    fn a_field_set_to_what_it_holds_sends_nothing() {
        let mut doc = profile();
        doc.set("/count", |view| &mut view.count, 0);
        assert!(doc.drain().unwrap().is_none());
        doc.set("/count", |view| &mut view.count, 4);
        assert_eq!(
            doc.drain().unwrap(),
            Some(vec![Op::Replace {
                path: "/count".to_owned(),
                value: json!(4)
            }])
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

    proptest! {
        #[test]
        fn field_patches_replay_to_a_fresh_snapshot(
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
}
