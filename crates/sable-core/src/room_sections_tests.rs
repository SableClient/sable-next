use matrix_sdk::ruma::OwnedRoomId;

use super::*;
use crate::protocol::{NotificationSettingsView, RoomJoinRuleView, SpaceChildEdge};

fn id(room_id: &str) -> OwnedRoomId {
    OwnedRoomId::try_from(format!("!{room_id}:example.org")).expect("a room id")
}

fn ids(room_ids: &[&str]) -> Vec<OwnedRoomId> {
    room_ids.iter().map(|room_id| id(room_id)).collect()
}

fn row(room_id: &str) -> Row {
    Row {
        room_id: id(room_id),
        canonical_alias: None,
        name: None,
        topic: None,
        topic_html: None,
        avatar_url: None,
        display_name: room_id.to_owned(),
        display_avatar_url: None,
        is_direct: false,
        direct_targets: Vec::new(),
        join_rule: RoomJoinRuleView::Invite,
        tags: Vec::new(),
        state: RoomStateView::Joined,
        encrypted: Some(false),
        is_tombstoned: false,
        room_kind: Some(RoomKind::Text),
        call_participants: Vec::new(),
        screen_sharers: Vec::new(),
        supports_knock: false,
        supports_restricted: false,
        supports_knock_restricted: false,
        space_children: Vec::new(),
        bridge: None,
        unread: 0,
        notifying: 0,
        highlight: 0,
        marked_unread: false,
        notification: NotificationSettingsView {
            room: None,
            default: NotificationModeView::All,
        },
        counts: RoomUnreadView::default(),
        latest_event: None,
    }
}

fn direct(room_id: &str) -> Row {
    Row {
        is_direct: true,
        ..row(room_id)
    }
}

fn favourite(mut row: Row) -> Row {
    row.tags.push(RoomTag::Favourite);
    row
}

fn named(room_id: &str, name: &str) -> Row {
    Row {
        display_name: name.to_owned(),
        ..row(room_id)
    }
}

fn unread(mut row: Row, unread: u32, highlight: u32) -> Row {
    row.counts = RoomUnreadView {
        unread,
        notifying: unread,
        highlight,
        marked: false,
    };
    row
}

fn space(room_id: &str, children: &[&str]) -> Row {
    Row {
        room_kind: Some(RoomKind::Space),
        space_children: children
            .iter()
            .map(|child| SpaceChildEdge {
                room_id: id(child).to_string(),
                via: vec!["example.org".to_owned()],
                order: None,
                origin_server_ts: 0,
                suggested: false,
            })
            .collect(),
        ..row(room_id)
    }
}

fn build(rows: &[Row]) -> RoomSections {
    RoomSections::build(rows, &RoomListOptionsView::default())
}

fn section<'s>(sections: &'s RoomSections, key: &str) -> &'s RoomSectionView {
    &sections.sections[key]
}

fn space_section<'s>(sections: &'s RoomSections, room_id: &str) -> &'s RoomSectionView {
    section(sections, id(room_id).as_str())
}

fn node_keys(nodes: &[SpaceTreeNodeView]) -> Vec<String> {
    nodes
        .iter()
        .map(|node| match node {
            SpaceTreeNodeView::Room { key, .. } => format!("room {key}"),
            SpaceTreeNodeView::Link { key, .. } => format!("link {key}"),
            SpaceTreeNodeView::Category { key, children, .. } => {
                format!("category {key} [{}]", node_keys(children).join(", "))
            }
        })
        .collect()
}

#[test]
fn recent_keeps_the_room_list_order_whatever_the_latest_events() {
    let sections = build(&[row("loading"), row("busy"), direct("dm"), row("quiet")]);

    assert_eq!(
        section(&sections, HOME).rooms,
        ids(&["loading", "busy", "dm", "quiet"])
    );
    assert_eq!(section(&sections, DIRECT).rooms, ids(&["dm"]));
}

#[test]
fn unspaced_leaves_out_direct_messages_and_rooms_a_live_space_holds() {
    let mut dead = space("dead", &["orphaned"]);
    dead.is_tombstoned = true;
    let sections = build(&[
        space("live", &["held"]),
        dead,
        row("held"),
        row("orphaned"),
        row("loose"),
        direct("dm"),
    ]);

    assert_eq!(
        section(&sections, UNSPACED).rooms,
        ids(&["orphaned", "loose"])
    );
}

#[test]
fn sections_skip_left_and_replaced_rooms_and_list_spaces_nowhere() {
    let mut replaced = row("replaced");
    replaced.is_tombstoned = true;
    let mut left = row("left");
    left.state = RoomStateView::Left;
    let sections = build(&[replaced, left, space("space", &[]), row("kept")]);

    assert_eq!(section(&sections, HOME).rooms, ids(&["kept"]));
}

#[test]
fn name_sorts_ignore_case_and_accents_and_ties_keep_the_list_order() {
    let rows = [
        named("b", "bravo"),
        named("e2", "Écho"),
        named("a", "alpha"),
        named("e1", "echo"),
    ];
    let options = |room_sort| RoomListOptionsView {
        room_sort,
        ..RoomListOptionsView::default()
    };

    let ascending = RoomSections::build(&rows, &options(RoomSortView::NameAsc));
    let descending = RoomSections::build(&rows, &options(RoomSortView::NameDesc));

    assert_eq!(
        section(&ascending, HOME).rooms,
        ids(&["a", "b", "e2", "e1"])
    );
    assert_eq!(
        section(&descending, HOME).rooms,
        ids(&["e2", "e1", "b", "a"])
    );
}

#[test]
fn direct_messages_follow_their_own_sort() {
    let options = RoomListOptionsView {
        room_sort: RoomSortView::NameAsc,
        direct_sort: RoomSortView::Recent,
        ..RoomListOptionsView::default()
    };
    let sections = RoomSections::build(
        &[
            Row {
                display_name: "zed".to_owned(),
                ..direct("z")
            },
            Row {
                display_name: "amy".to_owned(),
                ..direct("a")
            },
        ],
        &options,
    );

    assert_eq!(section(&sections, DIRECT).rooms, ids(&["z", "a"]));
    assert_eq!(section(&sections, HOME).rooms, ids(&["a", "z"]));
}

#[test]
fn favourites_get_their_own_list_unless_the_view_mixes_them_in() {
    let rows = [row("plain"), favourite(row("starred"))];
    let mixed = RoomListOptionsView {
        ungrouped_favourites: vec![HOME.to_owned()],
        ..RoomListOptionsView::default()
    };

    let grouped = build(&rows);
    let ungrouped = RoomSections::build(&rows, &mixed);

    assert_eq!(section(&grouped, HOME).favourites, ids(&["starred"]));
    assert_eq!(section(&grouped, HOME).rooms, ids(&["plain"]));
    assert_eq!(section(&ungrouped, HOME).favourites, ids(&[]));
    assert_eq!(section(&ungrouped, HOME).rooms, ids(&["plain", "starred"]));
    assert_eq!(section(&ungrouped, UNSPACED).favourites, ids(&["starred"]));
}

#[test]
fn a_space_lists_its_rooms_then_subspaces_that_hold_a_room() {
    let sections = build(&[
        space("root", &["sub", "empty", "top"]),
        space("sub", &["deep"]),
        space("empty", &[]),
        row("top"),
        row("deep"),
    ]);
    let root = id("root");
    let sub = id("sub");

    let section = space_section(&sections, "root");
    assert_eq!(section.rooms, ids(&["top"]));
    assert_eq!(
        node_keys(&section.subspaces),
        vec![format!(
            "category {root}/{sub} [room {root}/{sub}/{}]",
            id("deep")
        )]
    );
}

#[test]
fn subspaces_past_the_depth_limit_become_links_and_cycles_end() {
    let options = RoomListOptionsView {
        subspace_depth: 2,
        ..RoomListOptionsView::default()
    };
    let sections = RoomSections::build(
        &[
            space("root", &["one"]),
            space("one", &["two", "root"]),
            space("two", &["room"]),
            row("room"),
        ],
        &options,
    );
    let (root, one, two) = (id("root"), id("one"), id("two"));

    assert_eq!(
        node_keys(&space_section(&sections, "root").subspaces),
        vec![format!("category {root}/{one} [link {root}/{one}/{two}]")]
    );
}

#[test]
fn a_space_lifts_its_favourites_out_of_subspaces_and_drops_emptied_ones() {
    let sections = build(&[
        space("root", &["sub", "top"]),
        space("sub", &["deep"]),
        row("top"),
        favourite(row("deep")),
    ]);

    let section = space_section(&sections, "root");
    assert_eq!(section.favourites, ids(&["deep"]));
    assert_eq!(section.rooms, ids(&["top"]));
    assert_eq!(section.subspaces, []);
}

#[test]
fn a_space_counts_every_room_under_it_once() {
    let sections = build(&[
        space("root", &["sub", "shared"]),
        space("sub", &["shared", "deep"]),
        unread(row("shared"), 2, 0),
        unread(row("deep"), 1, 1),
    ]);

    let section = space_section(&sections, "root");
    assert_eq!(section.descendants, ids(&["shared", "deep"]));
    assert_eq!(section.unread.unread, 3);
    assert_eq!(section.unread.highlight, 1);
    assert_eq!(section.unread_rooms, ids(&["shared", "deep"]));
}

#[test]
fn badges_follow_the_defaults_and_a_quiet_space_quiets_its_rooms() {
    let options = RoomListOptionsView {
        quiet_rooms: ids(&["hushed"]),
        ..RoomListOptionsView::default()
    };
    let sections = RoomSections::build(
        &[
            space("hushed", &["inside"]),
            unread(row("inside"), 4, 1),
            unread(row("group"), 3, 0),
            unread(direct("dm"), 2, 0),
            row("read"),
        ],
        &options,
    );
    let badge = |room_id: &str| {
        sections
            .badges
            .iter()
            .find(|badge| badge.room_id == id(room_id))
            .map(|badge| badge.counts)
    };

    assert_eq!(sections.quiet_rooms, {
        let mut quiet = ids(&["hushed", "inside"]);
        quiet.sort_unstable();
        quiet
    });
    assert_eq!(badge("inside").map(|counts| counts.unread), Some(1));
    assert_eq!(badge("group").map(|counts| counts.notifying), Some(0));
    assert_eq!(badge("dm").map(|counts| counts.notifying), Some(2));
    assert_eq!(badge("read"), None);
}

#[test]
fn an_update_carries_only_what_changed() {
    let mut sections = RoomSections::default();
    let first = sections
        .update(build(&[row("a"), space("space", &["a"])]))
        .expect("everything is new");
    assert_eq!(first.sections.len(), 4);

    assert_eq!(
        sections.update(build(&[row("a"), space("space", &["a"])])),
        None
    );

    let next = sections
        .update(build(&[row("a"), row("b")]))
        .expect("a room joined and the space left");
    let keys: Vec<_> = next
        .sections
        .iter()
        .map(|section| section.key.as_str())
        .collect();
    assert_eq!(keys, vec![HOME, UNSPACED]);
    assert_eq!(next.removed, vec![id("space").to_string()]);
    assert_eq!(next.badges, None);
}

fn depths(nodes: &[SpaceTreeNodeView], found: &mut Vec<(String, u32)>) {
    for node in nodes {
        match node {
            SpaceTreeNodeView::Room { room_id, depth, .. }
            | SpaceTreeNodeView::Link { room_id, depth, .. } => {
                found.push((room_id.to_string(), *depth));
            }
            SpaceTreeNodeView::Category {
                room_id,
                depth,
                children,
                ..
            } => {
                found.push((room_id.to_string(), *depth));
                depths(children, found);
            }
        }
    }
}

#[test]
fn subspaces_nest_one_indent_below_their_parent_after_the_first_level() {
    let options = RoomListOptionsView {
        subspace_depth: 5,
        ..RoomListOptionsView::default()
    };
    let sections = RoomSections::build(
        &[
            space("root", &["a", "s1"]),
            space("s1", &["b", "s2"]),
            space("s2", &["c", "s3"]),
            space("s3", &["e", "s4"]),
            space("s4", &["f"]),
            row("a"),
            row("b"),
            row("c"),
            row("e"),
            row("f"),
        ],
        &options,
    );
    let mut found = Vec::new();
    depths(&space_section(&sections, "root").subspaces, &mut found);

    let expected = [
        ("s1", 0),
        ("b", 0),
        ("s2", 0),
        ("c", 1),
        ("s3", 1),
        ("e", 2),
        ("s4", 2),
        ("f", 3),
    ];
    assert_eq!(
        found,
        expected.map(|(room, depth)| (id(room).to_string(), depth))
    );
}

fn counts(unread: u32, notifying: u32, highlight: u32, marked: bool) -> RoomUnreadView {
    RoomUnreadView {
        unread,
        notifying,
        highlight,
        marked,
    }
}

fn counted(mut row: Row, counts: RoomUnreadView) -> Row {
    row.counts = counts;
    row
}

fn overridden(mut row: Row, mode: NotificationModeView) -> Row {
    row.notification.room = Some(mode);
    row
}

fn badge(sections: &RoomSections, room_id: &str) -> Option<RoomUnreadView> {
    sections
        .badges
        .iter()
        .find(|badge| badge.room_id == id(room_id))
        .map(|badge| badge.counts)
}

fn group_badges(mode: BadgeModeView) -> RoomListOptionsView {
    RoomListOptionsView {
        badge_default_group: mode,
        ..RoomListOptionsView::default()
    }
}

#[test]
fn mentions_mode_keeps_unread_and_drops_notifying() {
    let sections = RoomSections::build(
        &[unread(row("loud"), 6, 1)],
        &group_badges(BadgeModeView::Mentions),
    );

    assert_eq!(badge(&sections, "loud"), Some(counts(6, 0, 1, false)));
}

#[test]
fn quiet_mode_keeps_only_mentions() {
    let sections = RoomSections::build(
        &[unread(row("mentioned"), 6, 2), unread(row("plain"), 6, 0)],
        &group_badges(BadgeModeView::Quiet),
    );

    assert_eq!(badge(&sections, "mentioned"), Some(counts(2, 0, 2, false)));
    assert_eq!(badge(&sections, "plain"), None);
}

#[test]
fn all_mode_promotes_unread_into_notifying() {
    let sections = RoomSections::build(
        &[counted(row("hushed"), counts(6, 0, 0, false))],
        &group_badges(BadgeModeView::All),
    );

    assert_eq!(badge(&sections, "hushed"), Some(counts(6, 6, 0, false)));
}

#[test]
fn a_room_override_wins_over_the_direct_and_group_defaults() {
    let options = RoomListOptionsView {
        badge_default_direct: BadgeModeView::All,
        badge_default_group: BadgeModeView::Mentions,
        ..RoomListOptionsView::default()
    };
    let loud = counts(5, 0, 0, false);
    let sections = RoomSections::build(
        &[
            counted(row("group"), loud),
            counted(direct("dm"), loud),
            overridden(counted(row("group_all"), loud), NotificationModeView::All),
            overridden(
                counted(direct("dm_mentions"), loud),
                NotificationModeView::Mentions,
            ),
        ],
        &options,
    );
    let notifying = |room_id| badge(&sections, room_id).map(|counts| counts.notifying);

    assert_eq!(notifying("group"), Some(0));
    assert_eq!(notifying("dm"), Some(5));
    assert_eq!(notifying("group_all"), Some(5));
    assert_eq!(notifying("dm_mentions"), Some(0));
}

#[test]
fn a_muted_room_keeps_its_counts_as_given_including_a_hand_mark() {
    let options = RoomListOptionsView {
        badge_default_group: BadgeModeView::All,
        ..RoomListOptionsView::default()
    };
    let sections = RoomSections::build(
        &[
            overridden(
                counted(row("marked"), counts(0, 0, 0, true)),
                NotificationModeView::Mute,
            ),
            overridden(
                counted(row("counted"), counts(7, 0, 2, false)),
                NotificationModeView::Mute,
            ),
        ],
        &options,
    );

    assert_eq!(badge(&sections, "marked"), Some(counts(0, 0, 0, true)));
    assert_eq!(badge(&sections, "counted"), Some(counts(7, 0, 2, false)));
}

#[test]
fn a_muted_child_does_not_make_its_space_unread() {
    let sections = build(&[
        space("space", &["muted"]),
        overridden(row("muted"), NotificationModeView::Mute),
    ]);

    let section = space_section(&sections, "space");
    assert_eq!(section.unread, RoomUnreadView::default());
    assert_eq!(section.unread_rooms, ids(&[]));
}

#[test]
fn a_hand_marked_room_marks_its_space_even_muted() {
    let sections = build(&[
        space("space", &["muted"]),
        overridden(
            counted(row("muted"), counts(0, 0, 0, true)),
            NotificationModeView::Mute,
        ),
    ]);

    let section = space_section(&sections, "space");
    assert_eq!(section.unread, counts(0, 0, 0, true));
    assert_eq!(section.unread_rooms, ids(&["muted"]));
}

#[test]
fn a_space_sums_the_mentions_of_its_nested_rooms_and_so_does_the_subspace() {
    let sections = RoomSections::build(
        &[
            space("root", &["sub", "shared"]),
            space("sub", &["deep", "shared"]),
            unread(row("deep"), 4, 1),
            unread(row("shared"), 2, 2),
        ],
        &group_badges(BadgeModeView::All),
    );

    for key in ["root", "sub"] {
        assert_eq!(
            space_section(&sections, key).unread,
            counts(6, 6, 3, false),
            "{key}"
        );
    }
}

#[test]
fn a_mentions_only_child_still_marks_its_space_unread() {
    let sections = build(&[
        space("space", &["chatty"]),
        counted(row("chatty"), counts(5, 0, 0, false)),
    ]);

    let section = space_section(&sections, "space");
    assert_eq!(section.unread, counts(5, 0, 0, false));
    assert_eq!(section.unread_rooms, ids(&["chatty"]));
}

#[test]
fn a_quiet_space_quiets_every_room_beneath_it_even_around_a_cycle() {
    let rows = [
        space("root", &["sub", "top"]),
        space("sub", &["deep", "root"]),
        row("top"),
        row("deep"),
    ];
    let quiet = |room_ids: &[&str]| {
        let options = RoomListOptionsView {
            quiet_rooms: ids(room_ids),
            ..RoomListOptionsView::default()
        };
        RoomSections::build(&rows, &options).quiet_rooms
    };
    let sorted = |room_ids: &[&str]| {
        let mut sorted = ids(room_ids);
        sorted.sort_unstable();
        sorted
    };

    assert_eq!(quiet(&["sub"]), sorted(&["sub", "deep", "root", "top"]));
    assert_eq!(quiet(&["top"]), sorted(&["top"]));
}

#[test]
fn a_quiet_room_adds_only_its_mentions_to_its_space() {
    let options = RoomListOptionsView {
        quiet_rooms: ids(&["chatty"]),
        ..RoomListOptionsView::default()
    };
    let totals = |rows: &[Row]| space_section(&RoomSections::build(rows, &options), "space").unread;

    assert_eq!(
        totals(&[space("space", &["chatty"]), unread(row("chatty"), 5, 0)]),
        RoomUnreadView::default()
    );
    assert_eq!(
        totals(&[space("space", &["chatty"]), unread(row("chatty"), 5, 1)]),
        counts(1, 0, 1, false)
    );
}

#[test]
fn spaces_that_are_invited_or_whose_edges_lack_servers_do_not_claim_their_children() {
    let mut invited = space("invited", &["from_invite"]);
    invited.state = RoomStateView::Invited;
    let mut removed = space("removed", &["removed_child"]);
    removed.space_children[0].via.clear();
    let sections = build(&[
        space("joined", &["claimed"]),
        invited,
        removed,
        row("claimed"),
        row("from_invite"),
        row("removed_child"),
    ]);

    assert_eq!(
        section(&sections, UNSPACED).rooms,
        ids(&["from_invite", "removed_child"])
    );
}

#[test]
fn a_nickname_renames_and_re_sorts_a_direct_message() {
    use matrix_sdk::ruma::OwnedUserId;

    use crate::nicknames::Nicknames;
    use crate::protocol::{OverrideColorView, OverrideTextView, ProfileOverrideView, VectorDiff};
    use crate::room_list_rows::RoomListRows;

    let peer = |room_id: &str, name: &str, user: &str| {
        let mut row = Row {
            name: Some(name.to_owned()),
            direct_targets: vec![OwnedUserId::try_from(user).expect("a user id")],
            ..direct(room_id)
        };
        Nicknames::default().apply_room(&mut row);
        row
    };
    let mut rows = RoomListRows::default();
    rows.apply(&VectorDiff::Reset {
        values: vec![
            peer("bob", "Bob", "@bob:example.org"),
            peer("carol", "Carol", "@carol:example.org"),
        ],
    });
    let options = RoomListOptionsView {
        direct_sort: RoomSortView::NameAsc,
        ..RoomListOptionsView::default()
    };
    let mut sections = RoomSections::default();
    sections.update(RoomSections::build(rows.rows(), &options));

    let nicknames = Nicknames::from_overrides(
        vec![ProfileOverrideView {
            user_id: OwnedUserId::try_from("@bob:example.org").expect("a user id"),
            display_name: OverrideTextView::Set {
                value: "Zed".to_owned(),
            },
            avatar: OverrideTextView::Unset,
            color: OverrideColorView::Unset,
        }],
        None,
    );
    assert_eq!(
        rows.rename(
            &nicknames,
            &HashMap::<OwnedRoomId, crate::view::RoomInfo>::new()
        )
        .len(),
        1
    );
    let update = sections
        .update(RoomSections::build(rows.rows(), &options))
        .expect("the direct section changed");

    let direct = update
        .sections
        .iter()
        .find(|section| section.key == DIRECT)
        .expect("the direct section is resent");
    assert_eq!(direct.rooms, ids(&["carol", "bob"]));
}
