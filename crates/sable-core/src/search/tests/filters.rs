use super::{attachment_pages, document, filtered_index, found, picture};
use crate::protocol::SearchAttachment;
use crate::search::{IndexFilter, MessageIndex};
use matrix_sdk::ruma::event_id;

#[test]
fn test_from_narrows_to_one_sender() {
    let (index, _room) = filtered_index();

    let hits = found(
        &index,
        "deploy",
        &IndexFilter {
            senders: vec![matrix_sdk::ruma::user_id!("@alice:localhost").to_owned()],
            ..IndexFilter::default()
        },
    );

    assert_eq!(hits.len(), 2);
    assert!(!hits.contains(&"$kris".to_owned()));
}

#[test]
fn test_mentions_matches_only_messages_pinging_the_user() {
    let (index, _room) = filtered_index();

    let hits = found(
        &index,
        "deploy",
        &IndexFilter {
            mentions: vec![matrix_sdk::ruma::user_id!("@kris:localhost").to_owned()],
            ..IndexFilter::default()
        },
    );

    assert_eq!(hits, vec!["$alice"]);
}

#[test]
fn test_has_image_and_has_link_select_by_content() {
    let (index, _room) = filtered_index();

    assert_eq!(
        found(
            &index,
            "deploy",
            &IndexFilter {
                has: vec![SearchAttachment::Image],
                ..IndexFilter::default()
            }
        ),
        vec!["$screenshot"]
    );
    assert_eq!(
        found(
            &index,
            "deploy",
            &IndexFilter {
                has: vec![SearchAttachment::Link],
                ..IndexFilter::default()
            }
        ),
        vec!["$alice"]
    );
}

#[test]
fn test_date_bounds_are_inclusive_on_both_ends() {
    let (index, _room) = filtered_index();

    let hits = found(
        &index,
        "deploy",
        &IndexFilter {
            after_ts: Some(2_000),
            before_ts: Some(3_000),
            ..IndexFilter::default()
        },
    );

    assert_eq!(hits.len(), 2);
    assert!(!hits.contains(&"$kris".to_owned()));
}

#[test]
fn test_a_quoted_phrase_must_appear_verbatim() {
    let (index, _room) = filtered_index();

    assert_eq!(
        found(
            &index,
            "deploy",
            &IndexFilter {
                phrases: vec!["pipeline is broken".to_owned()],
                ..IndexFilter::default()
            }
        ),
        vec!["$kris"]
    );
}

#[test]
fn test_an_excluded_term_removes_matches() {
    let (index, _room) = filtered_index();

    let hits = found(
        &index,
        "deploy",
        &IndexFilter {
            exclude: vec!["screenshot".to_owned()],
            ..IndexFilter::default()
        },
    );

    assert!(!hits.contains(&"$screenshot".to_owned()));
}

#[test]
fn test_recent_order_ignores_relevance() {
    let (index, _room) = filtered_index();

    let hits: Vec<String> = index
        .search(
            "deploy",
            &IndexFilter::default(),
            crate::api::search::SearchOrder::Recent,
            20,
            0,
        )
        .into_iter()
        .map(|hit| hit.event_id.to_string())
        .collect();

    assert_eq!(hits, vec!["$screenshot", "$alice", "$kris"]);
}

#[test]
fn test_date_orders_match_whole_words_only() {
    let (index, room) = filtered_index();
    for (seed, body) in [
        ("mute", "please mute it"),
        ("muted", "so I muted it"),
        ("mutex", "a tokio mutex"),
    ] {
        index.upsert(
            &room,
            document(seed, body, "@kris:localhost", 4_000, None, Vec::new()),
        );
    }
    let search = |order| {
        let mut hits: Vec<String> = index
            .search("mute", &IndexFilter::default(), order, 20, 0)
            .into_iter()
            .map(|hit| hit.event_id.to_string())
            .collect();
        hits.sort();
        hits
    };

    assert_eq!(
        search(crate::api::search::SearchOrder::Rank),
        ["$mute", "$muted", "$mutex"]
    );
    assert_eq!(
        search(crate::api::search::SearchOrder::Recent),
        ["$mute", "$muted"]
    );
    assert_eq!(
        search(crate::api::search::SearchOrder::Oldest),
        ["$mute", "$muted"]
    );
}

#[test]
fn test_an_empty_query_with_filters_still_lists_messages() {
    let (index, _room) = filtered_index();

    let hits = found(
        &index,
        "",
        &IndexFilter {
            senders: vec![matrix_sdk::ruma::user_id!("@alice:localhost").to_owned()],
            ..IndexFilter::default()
        },
    );

    assert_eq!(hits.len(), 2);
}

#[test]
fn test_a_room_filter_excludes_other_rooms() {
    let (index, room) = filtered_index();
    let other = ruma::RoomId::parse("!other:localhost").expect("room id");
    index.upsert(
        &other,
        document(
            "elsewhere",
            "deploy elsewhere",
            "@kris:localhost",
            4_000,
            None,
            Vec::new(),
        ),
    );

    let hits = found(
        &index,
        "deploy",
        &IndexFilter {
            rooms: vec![room],
            ..IndexFilter::default()
        },
    );

    assert!(!hits.contains(&"$elsewhere".to_owned()));
    assert_eq!(hits.len(), 3);
}

#[test]
fn test_pinned_keeps_or_drops_the_pinned_events() {
    let (index, _room) = filtered_index();
    let pinned: std::collections::HashSet<_> =
        [event_id!("$alice").to_owned()].into_iter().collect();

    let search = |wanted| {
        index
            .search_pinned_sync(
                "deploy",
                &IndexFilter {
                    pinned: Some(wanted),
                    ..IndexFilter::default()
                },
                pinned.clone(),
                crate::api::search::SearchOrder::Recent,
                10,
                0,
            )
            .into_iter()
            .map(|hit| hit.event_id.to_string())
            .collect::<Vec<_>>()
    };

    assert_eq!(search(true), vec!["$alice"]);
    assert_eq!(search(false), vec!["$screenshot", "$kris"]);
}

#[test]
fn test_oldest_orders_hits_by_ascending_time() {
    let (index, _room) = filtered_index();

    let hits: Vec<String> = index
        .search(
            "deploy",
            &IndexFilter::default(),
            crate::api::search::SearchOrder::Oldest,
            10,
            0,
        )
        .into_iter()
        .map(|hit| hit.event_id.to_string())
        .collect();

    assert_eq!(hits, vec!["$kris", "$alice", "$screenshot"]);
}

#[test]
fn test_a_denied_sender_is_dropped_by_identity() {
    let (index, room) = filtered_index();

    let hits = found(
        &index,
        "deploy",
        &IndexFilter {
            rooms: vec![room],
            not_senders: vec![matrix_sdk::ruma::user_id!("@alice:localhost").to_owned()],
            ..IndexFilter::default()
        },
    );

    assert_eq!(hits, vec!["$kris".to_owned()]);
}

#[test]
fn test_state_events_file_types_and_patterns_filter_documents() {
    let (index, room) = filtered_index();
    index.upsert(
        &room,
        crate::search::Document {
            state: true,
            ..document(
                "renamed",
                "deploy crew",
                "@alice:localhost",
                4_000,
                None,
                Vec::new(),
            )
        },
    );
    index.upsert(
        &room,
        crate::search::Document {
            media: vec![(
                None,
                crate::protocol::RoomAttachmentContentView::File {
                    filename: "deploy-notes.pdf".to_owned(),
                    source: "mxc://localhost/notes".to_owned(),
                    mime: Some("application/pdf".to_owned()),
                    size: None,
                },
            )],
            ..document(
                "notes",
                "deploy-notes.pdf",
                "@alice:localhost",
                5_000,
                Some(SearchAttachment::File),
                Vec::new(),
            )
        },
    );
    let filter = |filter: IndexFilter| {
        found(
            &index,
            "deploy",
            &IndexFilter {
                rooms: vec![room.clone()],
                ..filter
            },
        )
    };

    let plain = filter(IndexFilter::default());
    assert!(!plain.contains(&"$renamed".to_owned()));
    assert_eq!(
        filter(IndexFilter {
            state_events: Some(true),
            ..IndexFilter::default()
        }),
        vec!["$renamed".to_owned()]
    );
    assert_eq!(
        filter(IndexFilter {
            file_types: vec!["PDF".to_owned()],
            ..IndexFilter::default()
        }),
        vec!["$notes".to_owned()]
    );
    assert!(
        filter(IndexFilter {
            pattern: Some(r"pipe\w+ is".to_owned()),
            ..IndexFilter::default()
        })
        .contains(&"$kris".to_owned())
    );
    assert_eq!(
        filter(IndexFilter {
            pattern: Some("(unclosed".to_owned()),
            ..IndexFilter::default()
        }),
        Vec::<String>::new()
    );
}

#[test]
fn test_a_denied_attachment_is_dropped_by_kind() {
    let (index, room) = filtered_index();

    let hits = found(
        &index,
        "deploy",
        &IndexFilter {
            rooms: vec![room],
            not_has: vec![SearchAttachment::Image],
            ..IndexFilter::default()
        },
    );

    assert!(!hits.contains(&"$screenshot".to_owned()));
    assert!(hits.contains(&"$kris".to_owned()));
}

#[test]
fn test_a_denied_mention_is_dropped_by_identity() {
    let (index, room) = filtered_index();

    let hits = found(
        &index,
        "deploy",
        &IndexFilter {
            rooms: vec![room],
            not_mentions: vec![matrix_sdk::ruma::user_id!("@kris:localhost").to_owned()],
            ..IndexFilter::default()
        },
    );

    assert!(!hits.contains(&"$alice".to_owned()));
}

#[test]
fn test_a_denied_room_is_skipped_even_with_no_room_filter() {
    let (index, room) = filtered_index();
    let other = ruma::RoomId::parse("!other:localhost").expect("room id");
    index.upsert(
        &other,
        document(
            "elsewhere",
            "deploy elsewhere",
            "@kris:localhost",
            4_000,
            None,
            Vec::new(),
        ),
    );

    let hits = found(
        &index,
        "deploy",
        &IndexFilter {
            not_rooms: vec![other],
            ..IndexFilter::default()
        },
    );

    assert!(!hits.contains(&"$elsewhere".to_owned()));
    assert!(hits.contains(&"$kris".to_owned()));
    drop(room);
}

#[test]
fn test_attachment_pages_walk_every_picture_once_across_a_timestamp_tie() {
    let room = ruma::RoomId::parse("!pictures:localhost").expect("room id");
    let index = MessageIndex::new();
    for (seed, ts) in [("a", 3), ("d", 2), ("b", 2), ("c", 2), ("e", 1)] {
        index.upsert(&room, picture(seed, "@kris:localhost", ts));
    }
    index.upsert(
        &room,
        document(
            "text",
            "no picture here",
            "@kris:localhost",
            2,
            None,
            Vec::new(),
        ),
    );

    assert_eq!(
        attachment_pages(&index, &room, &[], 2),
        [vec!["$a", "$d"], vec!["$c", "$b"], vec!["$e"],]
    );
}

#[test]
fn test_attachment_pages_skip_ignored_senders() {
    let room = ruma::RoomId::parse("!pictures:localhost").expect("room id");
    let index = MessageIndex::new();
    index.upsert(&room, picture("kept", "@kris:localhost", 2));
    index.upsert(&room, picture("hidden", "@troll:localhost", 1));

    assert_eq!(
        attachment_pages(
            &index,
            &room,
            &[matrix_sdk::ruma::user_id!("@troll:localhost").to_owned()],
            10,
        ),
        [vec!["$kept"]]
    );
}
