use serde_json::json;

use super::{
    super::{
        unread::{Unread, Viewing},
        view::Shared,
    },
    fixtures::{item, read_marker, text, with},
};

fn message(id: &str) -> Shared {
    Shared::new(text(id))
}

fn own(id: &str) -> Shared {
    Shared::new(with(&text(id), &json!({ "is_own": true })))
}

fn marker() -> Shared {
    Shared::new(read_marker())
}

fn membership(id: &str) -> Shared {
    Shared::new(item(
        json!({ "kind": "membership", "user_id": "@a:x", "change": "joined", "display_name": null, "reason": null }),
        id,
    ))
}

fn first(unread: &Unread) -> Option<&str> {
    unread.first_event_id()
}

#[test]
fn background_arrivals_block_receipts_until_their_first_message_is_seen() {
    let mut unread = Unread::default();
    let initial = [message("read")];
    unread.initialize(&initial, false, &initial, None);
    unread.track_background(&initial, true);
    let arrived = [
        message("read"),
        own("own"),
        message("first"),
        message("next"),
    ];
    unread.track_background(&arrived, false);
    let view = unread.view(&arrived);
    assert!(unread.active());
    assert!(view.blocking);
    assert_eq!(view.first_event_id.as_deref(), Some("$first"));
    assert_eq!(view.read_event_id.as_deref(), Some("$read"));
    assert_eq!(view.count, 2);
    unread.track_background(&arrived, true);
    assert!(unread.blocking());
    unread.observe(Some("$first"));
    assert!(!unread.blocking());
    assert!(!unread.blocking());
}

#[test]
fn background_tracking_ignores_history_own_messages_and_foreground_arrivals() {
    let mut unread = Unread::default();
    unread.track_background(&[message("read")], true);
    unread.track_background(&[message("history"), message("read")], false);
    unread.track_background(&[message("read"), own("own")], false);
    unread.track_background(&[message("read"), own("own"), message("latest")], true);
    assert!(!unread.active());
    assert!(!unread.active());
}

#[test]
fn background_arrivals_preserve_an_existing_unread_target() {
    let mut unread = Unread::default();
    let items = [marker(), message("first"), message("read")];
    unread.initialize(&items, true, &items, None);
    unread.observe(Some("$first"));
    unread.track_background(&items, true);
    let arrived = [
        marker(),
        message("first"),
        message("read"),
        message("missed"),
    ];
    unread.track_background(&arrived, false);
    assert_eq!(first(&unread), Some("$first"));
    assert!(unread.blocking());
    assert!(unread.blocking());
}

#[test]
fn reading_one_background_batch_allows_the_next_batch_to_start_a_new_boundary() {
    let mut unread = Unread::default();
    unread.track_background(&[message("read")], true);
    let first = [message("read"), message("first")];
    unread.track_background(&first, false);
    unread.dismiss();
    let second = [message("read"), message("first"), message("second")];
    unread.track_background(&second, false);
    assert_eq!(unread.first_event_id(), Some("$second"));
    assert_eq!(
        unread.view(&second).read_event_id.as_deref(),
        Some("$first")
    );
}

#[test]
fn background_tracking_starts_from_an_observed_empty_timeline_but_not_an_unknown_snapshot() {
    let mut unread = Unread::default();
    unread.track_background(&[message("already_there")], false);
    assert!(!unread.active());
    unread.track_background(&[], true);
    unread.track_background(&[message("new")], false);
    assert_eq!(first(&unread), Some("$new"));
}

#[test]
fn interrupting_a_marker_lookup_allows_the_new_subscription_to_retry_it() {
    let mut unread = Unread::default();
    let items = [message("latest")];
    assert!(unread.initialize(&items, true, &items, None));
    unread.interrupt_load();
    assert!(unread.initialize(&items, true, &items, None));
}

#[test]
fn landing_below_the_unread_boundary_holds_receipts_until_its_first_message_is_seen() {
    let mut unread = Unread::default();
    let items = [
        message("read"),
        marker(),
        own("own"),
        message("first"),
        message("later"),
    ];
    unread.initialize(&items, true, &items, None);
    assert_eq!(first(&unread), Some("$first"));
    assert_eq!(unread.count(&items), 2);
    unread.observe(Some("$later"));
    assert!(unread.blocking());
    unread.observe(Some("$first"));
    assert!(!unread.blocking());
    let moved = [
        message("read"),
        own("own"),
        message("first"),
        marker(),
        message("later"),
    ];
    unread.resolve(&moved, false, &moved);
    assert_eq!(first(&unread), Some("$first"));
}

#[test]
fn an_unloaded_boundary_resolves_after_history_arrives_and_skips_hidden_events() {
    let mut unread = Unread::default();
    let later = [message("later")];
    assert!(unread.initialize(&later, true, &later, None));
    unread.loaded(Ok(Some("$read".to_owned())));
    unread.resolve(&later, false, &later);
    assert!(unread.blocking());
    assert_eq!(first(&unread), None);

    let items = [
        message("read"),
        membership("hidden"),
        own("own"),
        message("first"),
        message("later"),
    ];
    unread.resolve(&items, false, &items);
    assert_eq!(first(&unread), Some("$first"));
}

#[test]
fn a_room_without_a_read_marker_starts_from_its_oldest_visible_unread_message() {
    let mut unread = Unread::default();
    let later = [message("later")];
    unread.initialize(&later, true, &later, None);
    unread.loaded(Ok(None));
    unread.resolve(&later, false, &later);
    assert_eq!(first(&unread), None);
    let items = [message("first"), message("later")];
    unread.resolve(&items, true, &items);
    assert_eq!(first(&unread), Some("$first"));
}

#[test]
fn a_failed_marker_lookup_keeps_receipts_blocked_and_can_be_retried() {
    let mut unread = Unread::default();
    let later = [message("later")];
    assert!(unread.initialize(&later, true, &later, None));
    unread.loaded(Err(()));
    unread.resolve(&later, true, &later);
    assert!(unread.blocking());
    assert!(unread.view(&later).failed);

    let items = [message("read"), message("first")];
    assert!(unread.initialize(&items, false, &items, None));
    unread.loaded(Ok(Some("$read".to_owned())));
    unread.resolve(&items, false, &items);
    assert_eq!(first(&unread), Some("$first"));
    assert!(!unread.view(&items).failed);
}

#[test]
fn a_read_boundary_already_at_the_latest_event_needs_no_history_or_unread_bar() {
    let mut unread = Unread::default();
    let latest = [message("latest")];
    unread.initialize(&latest, true, &latest, None);
    unread.loaded(Ok(Some("$latest".to_owned())));
    unread.resolve(&latest, false, &latest);
    assert!(!unread.active());
    assert!(!unread.blocking());
}

#[test]
fn dismissing_while_a_marker_lookup_is_in_flight_cannot_restore_the_unread_state() {
    let mut unread = Unread::default();
    let later = [message("later")];
    unread.initialize(&later, true, &later, None);
    unread.dismiss();
    unread.loaded(Ok(Some("$read".to_owned())));
    let items = [message("read"), message("first")];
    unread.resolve(&items, false, &items);
    assert!(!unread.active());
    assert!(!unread.blocking());
}

#[test]
fn a_fully_read_event_hidden_by_preferences_still_defines_the_unread_boundary() {
    let mut unread = Unread::default();
    let raw = [
        message("old"),
        membership("read"),
        message("first"),
        message("later"),
    ];
    let visible = [raw[0].clone(), raw[2].clone(), raw[3].clone()];
    unread.initialize(&raw, true, &visible, None);
    unread.loaded(Ok(Some("$read".to_owned())));
    unread.resolve(&raw, false, &visible);
    assert_eq!(first(&unread), Some("$first"));
    assert_eq!(unread.count(&visible), 2);
}

#[test]
fn redacting_an_unread_target_advances_the_jump_to_the_next_visible_message() {
    let mut unread = Unread::default();
    let items = [marker(), message("first"), message("next")];
    unread.initialize(&items, true, &items, None);
    assert_eq!(first(&unread), Some("$first"));
    let redacted = Shared::new(item(json!({ "kind": "redacted", "reason": null }), "first"));
    let items = [marker(), redacted, message("next")];
    let visible = [marker(), message("next")];
    unread.resolve(&items, false, &visible);
    assert_eq!(first(&unread), Some("$next"));
    assert!(unread.blocking());
}

#[test]
fn reaching_the_latest_message_unblocks_receipts_even_when_the_marker_lookup_failed() {
    let mut unread = Unread::default();
    let later = [message("later")];
    unread.initialize(&later, true, &later, None);
    unread.loaded(Err(()));
    assert!(unread.view(&later).failed);
    assert!(unread.blocking());
    unread.reach_latest();
    assert!(!unread.blocking());
}

#[test]
fn a_second_initialize_while_the_marker_loads_waits_for_it() {
    let mut unread = Unread::default();
    let later = [message("later")];
    assert!(unread.initialize(&later, true, &later, None));
    assert!(!unread.initialize(&later, true, &later, None));
    assert!(unread.loading_marker());
}

#[test]
fn clearing_forgets_the_first_unread_message() {
    let mut unread = Unread::default();
    let items = [marker(), message("first")];
    unread.initialize(&items, true, &items, None);
    unread.clear();
    assert_eq!(first(&unread), None);
    assert!(!unread.blocking());
}

fn viewing(focused: bool, newest: Option<&str>) -> Viewing {
    Viewing {
        focused,
        newest: newest.map(ToOwned::to_owned),
    }
}

#[test]
fn a_window_reaches_the_unread_messages_only_when_focused_and_showing_the_newest_row() {
    let items = [marker(), message("first"), message("last")];
    let mut unread = Unread::default();
    unread.initialize(&items, true, &items, None);
    let latest = Some("$last");

    unread.attend(&viewing(true, None), latest, &items);
    unread.attend(&viewing(true, Some("$first")), latest, &items);
    unread.attend(&viewing(false, Some("$last")), latest, &items);
    assert!(unread.blocking());

    unread.attend(&viewing(true, Some("$last")), latest, &items);
    assert!(!unread.blocking());
}

#[test]
fn showing_the_newest_row_does_not_reach_a_background_boundary() {
    let mut unread = Unread::default();
    unread.track_background(&[message("read")], true);
    let arrived = [message("read"), message("new")];
    unread.attend(&viewing(false, None), Some("$new"), &arrived);
    assert!(unread.blocking());

    unread.attend(&viewing(true, Some("$new")), Some("$new"), &arrived);
    assert!(unread.blocking());
}

#[test]
fn a_receipt_dismisses_the_boundary_only_at_the_newest_event() {
    let items = [marker(), message("first"), message("last")];
    let mut unread = Unread::default();
    unread.initialize(&items, true, &items, None);

    unread.read("$first", Some("$last"));
    assert!(unread.active());
    unread.read("$last", Some("$last"));
    assert!(!unread.active());
}
