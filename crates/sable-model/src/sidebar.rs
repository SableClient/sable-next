//! The space sidebar: top-level spaces and folders of spaces, in the reader's
//! order, and the edits a drag or a menu makes to it.

use std::collections::HashSet;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SidebarItemView {
    Space {
        room_id: String,
    },
    Folder {
        id: String,
        name: Option<String>,
        content: Vec<String>,
    },
}

/// What a drag picked up or landed on: a space, possibly inside a folder, or a
/// whole folder.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum LayoutRef {
    Space {
        room_id: String,
        folder_id: Option<String>,
    },
    Folder {
        folder_id: String,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
#[serde(rename_all = "snake_case")]
pub enum DropInstruction {
    Above,
    Below,
    Into,
}

type Items = Vec<SidebarItemView>;

#[must_use]
pub fn layout_space_ids(items: &[SidebarItemView]) -> Vec<String> {
    items
        .iter()
        .flat_map(|item| match item {
            SidebarItemView::Space { room_id } => std::slice::from_ref(room_id),
            SidebarItemView::Folder { content, .. } => content.as_slice(),
        })
        .cloned()
        .collect()
}

/// The layout kept to the spaces the reader is in, each once, with any space
/// it does not place yet appended.
#[must_use]
pub fn merge_spaces(items: &[SidebarItemView], space_ids: &[String]) -> Items {
    let active: HashSet<&str> = space_ids.iter().map(String::as_str).collect();
    let mut placed: HashSet<String> = HashSet::new();
    let mut merged = Vec::new();
    for item in items {
        match item {
            SidebarItemView::Space { room_id } => {
                if active.contains(room_id.as_str()) && placed.insert(room_id.clone()) {
                    merged.push(item.clone());
                }
            }
            SidebarItemView::Folder { id, name, content } => {
                let content: Vec<String> = content
                    .iter()
                    .filter(|room_id| {
                        active.contains(room_id.as_str()) && !placed.contains(*room_id)
                    })
                    .cloned()
                    .collect();
                if content.is_empty() {
                    continue;
                }
                placed.extend(content.iter().cloned());
                merged.push(SidebarItemView::Folder {
                    id: id.clone(),
                    name: name.clone(),
                    content,
                });
            }
        }
    }
    for room_id in space_ids {
        if !placed.contains(room_id) {
            merged.push(SidebarItemView::Space {
                room_id: room_id.clone(),
            });
        }
    }
    merged
}

#[must_use]
pub fn with_space(items: &[SidebarItemView], room_id: &str) -> Items {
    let mut items = items.to_vec();
    if !layout_space_ids(&items).iter().any(|id| id == room_id) {
        items.push(SidebarItemView::Space {
            room_id: room_id.to_owned(),
        });
    }
    items
}

/// `items` without `rooms`, dropping a folder left empty.
fn without_rooms(items: &[SidebarItemView], rooms: &[String]) -> Items {
    items
        .iter()
        .filter_map(|item| match item {
            SidebarItemView::Space { room_id } => (!rooms.contains(room_id)).then(|| item.clone()),
            SidebarItemView::Folder { id, name, content } => {
                let content: Vec<String> = content
                    .iter()
                    .filter(|room_id| !rooms.contains(*room_id))
                    .cloned()
                    .collect();
                (!content.is_empty()).then(|| SidebarItemView::Folder {
                    id: id.clone(),
                    name: name.clone(),
                    content,
                })
            }
        })
        .collect()
}

#[must_use]
pub fn without_space(items: &[SidebarItemView], room_id: &str) -> Items {
    without_rooms(items, &[room_id.to_owned()])
}

/// `known` with the spaces it has not seen yet appended.
#[must_use]
pub fn remember_space_ids(known: &[String], current: &[String]) -> Vec<String> {
    let mut remembered = known.to_vec();
    remembered.extend(
        current
            .iter()
            .filter(|room_id| !known.contains(room_id))
            .cloned(),
    );
    remembered
}

/// The current spaces, in the order they were first seen.
#[must_use]
pub fn ordered_known_space_ids(known: &[String], current: &[String]) -> Vec<String> {
    let mut ordered: Vec<String> = known
        .iter()
        .filter(|room_id| current.contains(room_id))
        .cloned()
        .collect();
    let placed = ordered.clone();
    ordered.extend(
        current
            .iter()
            .filter(|room_id| !placed.contains(room_id))
            .cloned(),
    );
    ordered
}

/// An empty name clears it.
#[must_use]
pub fn rename_folder(items: &[SidebarItemView], folder_id: &str, name: &str) -> Items {
    let trimmed = name.trim();
    items
        .iter()
        .map(|item| match item {
            SidebarItemView::Folder { id, content, .. } if id == folder_id => {
                SidebarItemView::Folder {
                    id: id.clone(),
                    name: (!trimmed.is_empty()).then(|| trimmed.to_owned()),
                    content: content.clone(),
                }
            }
            _ => item.clone(),
        })
        .collect()
}

#[must_use]
pub fn ungroup_folder(items: &[SidebarItemView], folder_id: &str) -> Items {
    items
        .iter()
        .flat_map(|item| match item {
            SidebarItemView::Folder { id, content, .. } if id == folder_id => content
                .iter()
                .map(|room_id| SidebarItemView::Space {
                    room_id: room_id.clone(),
                })
                .collect(),
            _ => vec![item.clone()],
        })
        .collect()
}

#[must_use]
pub fn remove_from_folder(items: &[SidebarItemView], room_id: &str, folder_id: &str) -> Items {
    apply_drop(
        items,
        &LayoutRef::Space {
            room_id: room_id.to_owned(),
            folder_id: Some(folder_id.to_owned()),
        },
        &LayoutRef::Folder {
            folder_id: folder_id.to_owned(),
        },
        DropInstruction::Below,
        "",
    )
}

fn find_folder<'a>(items: &'a [SidebarItemView], folder_id: &str) -> Option<&'a SidebarItemView> {
    items
        .iter()
        .find(|item| matches!(item, SidebarItemView::Folder { id, .. } if id == folder_id))
}

fn index_of_ref(items: &[SidebarItemView], target: &LayoutRef) -> Option<usize> {
    items.iter().position(|item| match (target, item) {
        (LayoutRef::Folder { folder_id }, SidebarItemView::Folder { id, .. })
        | (
            LayoutRef::Space {
                folder_id: Some(folder_id),
                ..
            },
            SidebarItemView::Folder { id, .. },
        ) => id == folder_id,
        (
            LayoutRef::Space {
                room_id,
                folder_id: None,
            },
            SidebarItemView::Space { room_id: placed },
        ) => placed == room_id,
        _ => false,
    })
}

fn without_source(items: &[SidebarItemView], source: &LayoutRef) -> Items {
    match source {
        LayoutRef::Folder { folder_id } => items
            .iter()
            .filter(|item| !matches!(item, SidebarItemView::Folder { id, .. } if id == folder_id))
            .cloned()
            .collect(),
        LayoutRef::Space {
            room_id,
            folder_id: None,
        } => items
            .iter()
            .filter(|item| {
                !matches!(item, SidebarItemView::Space { room_id: placed } if placed == room_id)
            })
            .cloned()
            .collect(),
        LayoutRef::Space {
            room_id,
            folder_id: Some(folder_id),
        } => items
            .iter()
            .filter_map(|item| match item {
                SidebarItemView::Folder { id, name, content } if id == folder_id => {
                    let content: Vec<String> =
                        content.iter().filter(|id| *id != room_id).cloned().collect();
                    (!content.is_empty()).then(|| SidebarItemView::Folder {
                        id: id.clone(),
                        name: name.clone(),
                        content,
                    })
                }
                _ => Some(item.clone()),
            })
            .collect(),
    }
}

fn splice(items: &mut Items, at: usize, inserted: Items) {
    let at = at.min(items.len());
    items.splice(at..at, inserted);
}

/// The layout after dropping `source` on `target`: a folder dissolves into its target, and two spaces
/// make a folder named `new_folder_id` unless one came from a dissolving folder.
#[must_use]
pub fn apply_drop(
    items: &[SidebarItemView],
    source: &LayoutRef,
    target: &LayoutRef,
    instruction: DropInstruction,
    new_folder_id: &str,
) -> Items {
    if source == target {
        return items.to_vec();
    }
    let target_in_folder = matches!(
        target,
        LayoutRef::Space {
            folder_id: Some(_),
            ..
        }
    );
    let dissolves = matches!(source, LayoutRef::Folder { .. })
        && (instruction == DropInstruction::Into || target_in_folder);
    let source_folder = match source {
        LayoutRef::Folder { folder_id } => find_folder(items, folder_id),
        LayoutRef::Space { .. } => None,
    };
    let moved: Vec<String> = match (source, source_folder) {
        (LayoutRef::Space { room_id, .. }, _) => vec![room_id.clone()],
        (LayoutRef::Folder { .. }, Some(SidebarItemView::Folder { content, .. })) if dissolves => {
            content.clone()
        }
        _ => Vec::new(),
    };
    let moved_folder = source_folder.filter(|_| !dissolves);
    if moved.is_empty() && moved_folder.is_none() {
        return items.to_vec();
    }

    let target_index = index_of_ref(items, target);
    let mut remaining = without_rooms(&without_source(items, source), &moved);
    let insertion: Items = moved_folder.map_or_else(
        || {
            moved
                .iter()
                .map(|room_id| SidebarItemView::Space {
                    room_id: room_id.clone(),
                })
                .collect()
        },
        |folder| vec![folder.clone()],
    );

    let Some(at) = index_of_ref(&remaining, target) else {
        splice(&mut remaining, target_index.unwrap_or(0), insertion);
        return remaining;
    };

    if instruction == DropInstruction::Into {
        let Some(entry) = remaining.get_mut(at) else {
            return remaining;
        };
        *entry = match entry {
            SidebarItemView::Folder { id, name, content } => SidebarItemView::Folder {
                id: id.clone(),
                name: name.clone(),
                content: [content.as_slice(), moved.as_slice()].concat(),
            },
            SidebarItemView::Space { room_id } => {
                let (id, name) = match source_folder {
                    Some(SidebarItemView::Folder { id, name, .. }) => (id.clone(), name.clone()),
                    _ => (new_folder_id.to_owned(), None),
                };
                SidebarItemView::Folder {
                    id,
                    name,
                    content: [std::slice::from_ref(room_id), moved.as_slice()].concat(),
                }
            }
        };
        return remaining;
    }

    let offset = usize::from(instruction == DropInstruction::Below);
    if let (
        LayoutRef::Space {
            room_id,
            folder_id: Some(_),
        },
        Some(SidebarItemView::Folder { content, .. }),
    ) = (target, remaining.get_mut(at))
        && let Some(content_at) = content.iter().position(|id| id == room_id)
    {
        let content_at = content_at + offset;
        content.splice(content_at..content_at, moved);
        return remaining;
    }
    splice(&mut remaining, at + offset, insertion);
    remaining
}

#[cfg(test)]
mod tests {
    use super::*;

    fn space(room_id: &str) -> SidebarItemView {
        SidebarItemView::Space {
            room_id: room_id.to_owned(),
        }
    }

    fn folder(id: &str, content: &[&str]) -> SidebarItemView {
        SidebarItemView::Folder {
            id: id.to_owned(),
            name: None,
            content: content
                .iter()
                .map(|room_id| (*room_id).to_owned())
                .collect(),
        }
    }

    fn at(room_id: &str, folder_id: Option<&str>) -> LayoutRef {
        LayoutRef::Space {
            room_id: room_id.to_owned(),
            folder_id: folder_id.map(str::to_owned),
        }
    }

    fn ids(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).to_owned()).collect()
    }

    #[test]
    fn merging_keeps_only_joined_spaces_once_and_appends_the_rest() {
        let items = [
            space("!a"),
            folder("f", &["!b", "!a", "!gone"]),
            space("!gone"),
        ];
        assert_eq!(
            merge_spaces(&items, &ids(&["!a", "!b", "!c"])),
            [space("!a"), folder("f", &["!b"]), space("!c")]
        );
    }

    #[test]
    fn a_space_dropped_into_a_space_makes_a_folder() {
        let items = [space("!a"), space("!b")];
        assert_eq!(
            apply_drop(
                &items,
                &at("!b", None),
                &at("!a", None),
                DropInstruction::Into,
                "new"
            ),
            [folder("new", &["!a", "!b"])]
        );
    }

    #[test]
    fn a_folder_dropped_into_a_space_dissolves_and_keeps_its_name() {
        let named = SidebarItemView::Folder {
            id: "f".to_owned(),
            name: Some("Work".to_owned()),
            content: ids(&["!b", "!c"]),
        };
        let items = [space("!a"), named];
        assert_eq!(
            apply_drop(
                &items,
                &LayoutRef::Folder {
                    folder_id: "f".to_owned()
                },
                &at("!a", None),
                DropInstruction::Into,
                "new"
            ),
            [SidebarItemView::Folder {
                id: "f".to_owned(),
                name: Some("Work".to_owned()),
                content: ids(&["!a", "!b", "!c"]),
            }]
        );
    }

    #[test]
    fn a_space_moves_within_and_out_of_a_folder() {
        let items = [folder("f", &["!a", "!b", "!c"]), space("!d")];
        assert_eq!(
            apply_drop(
                &items,
                &at("!a", Some("f")),
                &at("!c", Some("f")),
                DropInstruction::Below,
                "new"
            ),
            [folder("f", &["!b", "!c", "!a"]), space("!d")]
        );
        assert_eq!(
            remove_from_folder(&items, "!b", "f"),
            [folder("f", &["!a", "!c"]), space("!b"), space("!d")]
        );
        assert_eq!(
            ungroup_folder(&items, "f"),
            [space("!a"), space("!b"), space("!c"), space("!d")]
        );
    }

    #[test]
    fn known_spaces_keep_their_first_seen_order() {
        assert_eq!(
            remember_space_ids(&ids(&["!a", "!b"]), &ids(&["!c", "!a"])),
            ids(&["!a", "!b", "!c"])
        );
        assert_eq!(
            ordered_known_space_ids(&ids(&["!b", "!a", "!x"]), &ids(&["!a", "!c", "!b"])),
            ids(&["!b", "!a", "!c"])
        );
    }
}
