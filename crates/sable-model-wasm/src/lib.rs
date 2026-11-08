#![cfg(target_family = "wasm")]
#![expect(
    clippy::missing_errors_doc,
    reason = "every export throws for one reason, an argument that does not decode"
)]
#![expect(
    clippy::needless_pass_by_value,
    reason = "wasm-bindgen takes an optional string only as Option<String>"
)]

use std::collections::HashSet;

use sable_model::bot_commands::{
    self, ArgumentDrafts, BotCommand, BotCommandDescription, LiteralValue,
};
use sable_model::calendar::{self, CalendarItem, CalendarRsvpView, EventDraft};
use sable_model::emote_picker::{self, EmoteRecentsInput};
use sable_model::markdown::{self, ComposerPill};
use sable_model::notifications::{self, NotificationModeView, PushNotification};
use sable_model::power_levels::{self, PowerLevelLocation, RoomPowerLevelsView};
use sable_model::rtc_invites::{self, InvitePresentation};
use sable_model::search_filter::{self, SearchDirectory, SearchPerson, SearchRoom};
use sable_model::sidebar::{self, DropInstruction, LayoutRef, SidebarItemView};
use sable_model::spaces::{
    self, ChildOrderOverride, HierarchyRoomView, HierarchySection, RoomJoinRuleView, SectionInputs,
    SuggestedOverride,
};
use sable_model::{event_preview, matrix_link, mfm, search_query, shortcodes, slash};
use serde::Deserialize;
use serde::de::DeserializeOwned;
use wasm_bindgen::prelude::*;

/// Everything crosses as JSON, typed on the other side by the generated
/// protocol types.
fn json(value: &impl serde::Serialize) -> Result<String, JsError> {
    serde_json::to_string(value).map_err(|error| JsError::new(&format!("sable-model: {error}")))
}

/// Arguments are written by the typed wrappers in `model.ts`, so one that does
/// not decode is a bug there: it is thrown rather than read as a default.
fn decode<T: DeserializeOwned>(text: &str) -> Result<T, JsError> {
    serde_json::from_str(text).map_err(|error| JsError::new(&format!("sable-model: {error}")))
}

#[wasm_bindgen(js_name = quickReactions)]
pub fn quick_reactions(frequent: &str, limit: usize) -> Result<String, JsError> {
    json(&emote_picker::quick_reactions(
        &decode::<Vec<String>>(frequent)?,
        limit,
    ))
}

#[wasm_bindgen(js_name = emoteRecents)]
pub fn emote_recents(input: &str) -> Result<String, JsError> {
    json(&emote_picker::emote_recents(&decode::<EmoteRecentsInput>(
        input,
    )?))
}

#[wasm_bindgen(js_name = searchOperators)]
pub fn search_operators() -> Result<String, JsError> {
    json(&search_query::SearchOperator::ALL)
}

#[wasm_bindgen(js_name = visibleName)]
#[must_use]
pub fn visible_name(name: &str) -> Option<String> {
    sable_model::text::visible_name(name).map(str::to_owned)
}

#[wasm_bindgen(js_name = parseSearchQuery)]
pub fn parse_search_query(input: &str) -> Result<String, JsError> {
    json(&search_query::parse_search_query(input))
}

#[wasm_bindgen(js_name = parseMatrixLink)]
pub fn parse_matrix_link(href: &str) -> Result<String, JsError> {
    json(&matrix_link::parse_matrix_link(href))
}

#[wasm_bindgen(js_name = parseJoinAddress)]
pub fn parse_join_address(input: &str) -> Result<String, JsError> {
    json(&matrix_link::parse_join_address(input))
}

#[wasm_bindgen(js_name = splitVia)]
pub fn split_via(href: &str) -> Result<String, JsError> {
    json(&matrix_link::split_via(href))
}

#[wasm_bindgen(js_name = parseBotCommand)]
pub fn parse_bot_command(description: &str) -> Result<String, JsError> {
    let description = decode::<BotCommandDescription>(description)?;
    json(&bot_commands::parse_description(&description))
}

#[wasm_bindgen(js_name = matchBotCommand)]
pub fn match_bot_command(line: &str, commands: &str) -> Result<String, JsError> {
    let commands = decode::<Vec<BotCommand>>(commands)?;
    json(&bot_commands::match_bot_command(line, &commands))
}

#[wasm_bindgen(js_name = draftsFromText)]
pub fn drafts_from_text(command: &str, args: &str) -> Result<String, JsError> {
    json(&bot_commands::drafts_from_text(
        &decode::<BotCommand>(command)?,
        args,
    ))
}

#[wasm_bindgen(js_name = buildInvocation)]
pub fn build_invocation(command: &str, drafts: &str, prefix: &str) -> Result<String, JsError> {
    json(&bot_commands::build_invocation(
        &decode::<BotCommand>(command)?,
        &decode::<ArgumentDrafts>(drafts)?,
        prefix,
    ))
}

#[wasm_bindgen(js_name = literalLabel)]
pub fn literal_label(value: &str) -> Result<String, JsError> {
    Ok(bot_commands::literal_label(&decode::<LiteralValue>(value)?))
}

#[wasm_bindgen(js_name = parsePushPayload)]
pub fn parse_push_payload(raw: &str) -> Result<String, JsError> {
    json(&notifications::parse_push_payload(raw))
}

#[wasm_bindgen(js_name = validateRtcInviteSnapshot)]
pub fn validate_rtc_invite_snapshot(
    event: &str,
    events: &str,
    user_id: &str,
    now_ms: f64,
) -> Result<String, JsError> {
    let event = decode::<serde_json::Value>(event)?;
    let events = decode::<Vec<serde_json::Value>>(events)?;
    if !now_ms.is_finite() || now_ms < 0.0 || now_ms.fract() != 0.0 {
        return json(&Option::<InvitePresentation>::None);
    }
    #[expect(
        clippy::cast_possible_truncation,
        clippy::cast_sign_loss,
        reason = "validated non-negative whole milliseconds"
    )]
    let now_ms = now_ms as u64;
    let presentation = rtc_invites::validate_snapshot(&event, &events, user_id, now_ms)
        .and_then(|invite| InvitePresentation::from_invite(&invite, &events));
    json(&presentation)
}

#[wasm_bindgen(js_name = webPushValidation)]
pub fn web_push_validation(raw: &str) -> Result<String, JsError> {
    json(&notifications::web_push_validation(raw))
}

#[wasm_bindgen(js_name = pushContent)]
pub fn push_content(content: &str) -> Result<String, JsError> {
    json(&notifications::push_content(&decode::<serde_json::Value>(
        content,
    )?))
}

#[wasm_bindgen(js_name = roomTag)]
#[must_use]
pub fn room_tag(user_id: &str, room_id: &str) -> String {
    notifications::room_tag(Some(user_id), room_id)
}

#[wasm_bindgen(js_name = silencedByRoomMode)]
pub fn silenced_by_room_mode(notification: &str, mode: &str) -> Result<bool, JsError> {
    Ok(notifications::silenced_by_room_mode(
        &decode::<PushNotification>(notification)?,
        decode::<Option<NotificationModeView>>(mode)?,
    ))
}

#[wasm_bindgen(js_name = pushAlert)]
pub fn push_alert(
    notification: &str,
    room_name: Option<String>,
    show_content: bool,
) -> Result<String, JsError> {
    json(&notifications::alert(
        &decode::<PushNotification>(notification)?,
        room_name.as_deref(),
        show_content,
    ))
}

#[wasm_bindgen(js_name = activeElsewhere)]
#[must_use]
pub fn active_elsewhere(content: &str, own_device_id: &str, now_ms: f64) -> bool {
    #[expect(
        clippy::cast_possible_truncation,
        clippy::cast_sign_loss,
        reason = "a non-negative whole number of milliseconds from Date.now()"
    )]
    let now_ms = now_ms.max(0.0) as u64;
    notifications::active_elsewhere_json(content, own_device_id, now_ms)
}

#[wasm_bindgen(js_name = slashCommandNames)]
pub fn slash_command_names() -> Result<String, JsError> {
    json(&slash::SLASH_COMMANDS.as_slice())
}

#[wasm_bindgen(js_name = parseSlash)]
pub fn parse_slash(body: &str, formatted: Option<String>, now_ms: f64) -> Result<String, JsError> {
    json(&slash::parse_slash(body, formatted.as_deref(), now_ms))
}

#[wasm_bindgen(js_name = markdownToContent)]
pub fn markdown_to_content(markdown: &str, pills: &str) -> Result<String, JsError> {
    json(&markdown::markdown_to_content(
        markdown,
        &decode::<Vec<ComposerPill>>(pills)?,
    ))
}

#[wasm_bindgen(js_name = topicToHtml)]
#[must_use]
pub fn topic_to_html(topic: &str) -> String {
    markdown::topic_to_html(topic)
}

#[wasm_bindgen(js_name = markdownToDoc)]
pub fn markdown_to_doc(markdown: &str, pills: &str) -> Result<String, JsError> {
    json(&markdown::markdown_to_doc(
        markdown,
        &decode::<Vec<ComposerPill>>(pills)?,
    ))
}

#[wasm_bindgen(js_name = receiverFormats)]
#[must_use]
pub fn receiver_formats(text: &str) -> bool {
    markdown::receiver_formats(text)
}

#[wasm_bindgen(js_name = pronounSets)]
pub fn pronoun_sets(text: &str) -> Result<String, JsError> {
    json(&slash::pronoun_sets(text))
}

#[wasm_bindgen(js_name = normalizeMfmHex)]
#[must_use]
pub fn normalize_mfm_hex(value: &str) -> Option<String> {
    mfm::normalize_mfm_hex(value)
}

#[wasm_bindgen(js_name = isOpaqueMatrixColor)]
#[must_use]
pub fn is_opaque_matrix_color(value: &str) -> bool {
    mfm::is_opaque_matrix_color(value)
}

#[wasm_bindgen(js_name = parseMfmColor)]
pub fn parse_mfm_color(src: &str) -> Result<String, JsError> {
    json(&mfm::parse_mfm_color(src))
}

#[wasm_bindgen(js_name = parseMfmUnixtime)]
pub fn parse_mfm_unixtime(src: &str) -> Result<String, JsError> {
    json(&mfm::parse_mfm_unixtime(src))
}

#[wasm_bindgen(js_name = canonicalDatetime)]
#[must_use]
pub fn canonical_datetime(value: &str) -> Option<String> {
    mfm::canonical_datetime(value)
}

#[wasm_bindgen(js_name = parseZonedDatetime)]
pub fn parse_zoned_datetime(value: &str) -> Result<String, JsError> {
    json(&mfm::parse_zoned_datetime(value))
}

#[wasm_bindgen(js_name = unixSecondsOf)]
#[must_use]
pub fn unix_seconds_of(datetime: &str) -> Option<String> {
    mfm::unix_seconds_of(datetime)
}

#[derive(Deserialize)]
struct CalendarEntry {
    event_id: String,
    sender: String,
    event: serde_json::Value,
}

#[wasm_bindgen(js_name = readCalendarEntries)]
pub fn read_calendar_entries(entries: &str) -> Result<String, JsError> {
    let items: Vec<CalendarItem> = decode::<Vec<CalendarEntry>>(entries)?
        .iter()
        .filter_map(|entry| calendar::read_entry(&entry.event_id, &entry.sender, &entry.event))
        .collect();
    json(&items)
}

#[wasm_bindgen(js_name = calendarWallTimes)]
pub fn calendar_wall_times(item: &str, before: &str) -> Result<String, JsError> {
    json(&calendar::wall_times(
        &decode::<CalendarItem>(item)?,
        before,
    ))
}

#[wasm_bindgen(js_name = tallyRsvps)]
pub fn tally_rsvps(
    rsvps: &str,
    uid: &str,
    recurrence_id: Option<String>,
    user_id: Option<String>,
) -> Result<String, JsError> {
    json(&calendar::tally_rsvps(
        &decode::<Vec<CalendarRsvpView>>(rsvps)?,
        uid,
        recurrence_id.as_deref(),
        user_id.as_deref(),
    ))
}

#[wasm_bindgen(js_name = buildCalendarEvent)]
pub fn build_calendar_event(
    draft: &str,
    base: &str,
    uid: &str,
    now_ms: f64,
    time_zone: &str,
) -> Result<String, JsError> {
    let draft = decode::<EventDraft>(draft)?;
    let base = decode::<Option<serde_json::Map<String, serde_json::Value>>>(base)?;
    #[expect(
        clippy::cast_possible_truncation,
        reason = "Date.now() is a whole number of milliseconds"
    )]
    let now_ms = now_ms as i64;
    json(&calendar::build_event(
        &draft,
        base.as_ref(),
        uid,
        now_ms,
        time_zone,
    ))
}

#[wasm_bindgen(js_name = lobbyAction)]
pub fn lobby_action(join_rule: &str, invited: bool, in_parent: bool) -> Result<String, JsError> {
    json(&spaces::lobby_action(
        decode::<RoomJoinRuleView>(join_rule)?,
        invited,
        in_parent,
    ))
}

#[wasm_bindgen(js_name = joinCandidates)]
pub fn join_candidates(sections: &str, joined: Vec<String>) -> Result<String, JsError> {
    let joined: HashSet<String> = joined.into_iter().collect();
    json(&spaces::join_candidates(
        &decode::<Vec<HierarchySection>>(sections)?,
        &joined,
    ))
}

#[wasm_bindgen(js_name = mergeHierarchyRooms)]
pub fn merge_hierarchy_rooms(local: &str, fetched: &str) -> Result<String, JsError> {
    json(&spaces::merge_hierarchy_rooms(
        &decode::<Vec<HierarchyRoomView>>(local)?,
        &decode::<Vec<HierarchyRoomView>>(fetched)?,
    ))
}

#[wasm_bindgen(js_name = buildHierarchySections)]
pub fn build_hierarchy_sections(
    rooms: &str,
    root_id: &str,
    inputs: &str,
) -> Result<String, JsError> {
    json(&spaces::build_hierarchy_sections(
        &decode::<Vec<HierarchyRoomView>>(rooms)?,
        root_id,
        &decode::<SectionInputs>(inputs)?,
    ))
}

#[wasm_bindgen(js_name = applyChildOverrides)]
pub fn apply_child_overrides(rooms: &str, overrides: &str) -> Result<String, JsError> {
    json(&spaces::apply_child_overrides(
        &decode::<Vec<HierarchyRoomView>>(rooms)?,
        &decode::<Vec<ChildOrderOverride>>(overrides)?,
    ))
}

#[wasm_bindgen(js_name = applySuggestedOverrides)]
pub fn apply_suggested_overrides(rooms: &str, overrides: &str) -> Result<String, JsError> {
    json(&spaces::apply_suggested_overrides(
        &decode::<Vec<HierarchyRoomView>>(rooms)?,
        &decode::<Vec<SuggestedOverride>>(overrides)?,
    ))
}

fn sidebar_items(items: &str) -> Result<Vec<SidebarItemView>, JsError> {
    decode(items)
}

fn room_ids(ids: &str) -> Result<Vec<String>, JsError> {
    decode(ids)
}

#[wasm_bindgen(js_name = layoutSpaceIds)]
pub fn layout_space_ids(items: &str) -> Result<String, JsError> {
    json(&sidebar::layout_space_ids(&sidebar_items(items)?))
}

#[wasm_bindgen(js_name = mergeSpaces)]
pub fn merge_spaces(items: &str, space_ids: &str) -> Result<String, JsError> {
    json(&sidebar::merge_spaces(
        &sidebar_items(items)?,
        &room_ids(space_ids)?,
    ))
}

#[wasm_bindgen(js_name = withSpace)]
pub fn with_space(items: &str, room_id: &str) -> Result<String, JsError> {
    json(&sidebar::with_space(&sidebar_items(items)?, room_id))
}

#[wasm_bindgen(js_name = withoutSpace)]
pub fn without_space(items: &str, room_id: &str) -> Result<String, JsError> {
    json(&sidebar::without_space(&sidebar_items(items)?, room_id))
}

#[wasm_bindgen(js_name = rememberSpaceIds)]
pub fn remember_space_ids(known: &str, current: &str) -> Result<String, JsError> {
    json(&sidebar::remember_space_ids(
        &room_ids(known)?,
        &room_ids(current)?,
    ))
}

#[wasm_bindgen(js_name = orderedKnownSpaceIds)]
pub fn ordered_known_space_ids(known: &str, current: &str) -> Result<String, JsError> {
    json(&sidebar::ordered_known_space_ids(
        &room_ids(known)?,
        &room_ids(current)?,
    ))
}

#[wasm_bindgen(js_name = renameFolder)]
pub fn rename_folder(items: &str, folder_id: &str, name: &str) -> Result<String, JsError> {
    json(&sidebar::rename_folder(
        &sidebar_items(items)?,
        folder_id,
        name,
    ))
}

#[wasm_bindgen(js_name = ungroupFolder)]
pub fn ungroup_folder(items: &str, folder_id: &str) -> Result<String, JsError> {
    json(&sidebar::ungroup_folder(&sidebar_items(items)?, folder_id))
}

#[wasm_bindgen(js_name = removeFromFolder)]
pub fn remove_from_folder(items: &str, room_id: &str, folder_id: &str) -> Result<String, JsError> {
    json(&sidebar::remove_from_folder(
        &sidebar_items(items)?,
        room_id,
        folder_id,
    ))
}

#[wasm_bindgen(js_name = applyDrop)]
pub fn apply_drop(
    items: &str,
    source: &str,
    target: &str,
    instruction: &str,
    new_folder_id: &str,
) -> Result<String, JsError> {
    json(&sidebar::apply_drop(
        &sidebar_items(items)?,
        &decode::<LayoutRef>(source)?,
        &decode::<LayoutRef>(target)?,
        decode::<DropInstruction>(instruction)?,
        new_folder_id,
    ))
}

#[wasm_bindgen(js_name = eventPreview)]
pub fn event_preview(source: &str) -> Result<String, JsError> {
    json(&event_preview::event_preview(&decode::<serde_json::Value>(
        source,
    )?))
}

#[wasm_bindgen(js_name = permissionGroups)]
pub fn permission_groups(is_space: bool) -> Result<String, JsError> {
    json(&power_levels::permission_groups(is_space))
}

#[wasm_bindgen(js_name = levelAt)]
pub fn level_at(levels: &str, location: &str) -> Result<String, JsError> {
    json(&power_levels::level_at(
        &decode::<RoomPowerLevelsView>(levels)?,
        &decode::<PowerLevelLocation>(location)?,
    ))
}

#[wasm_bindgen(js_name = canSendState)]
pub fn can_send_state(levels: &str, own_level: f64, event_type: &str) -> Result<bool, JsError> {
    #[expect(
        clippy::cast_possible_truncation,
        reason = "a power level is an integer below 2^53"
    )]
    let own_level = own_level as i64;
    Ok(power_levels::can_send_state(
        &decode::<RoomPowerLevelsView>(levels)?,
        own_level,
        event_type,
    ))
}

/// Local midnight through the page's own `Date`, so the time zone and its
/// clock changes are the reader's.
fn local_start_of_day(year: i32, month: u32, day: u32) -> Option<i64> {
    let date = js_sys::Date::new_0();
    date.set_full_year_with_month_date(
        u32::try_from(year).ok()?,
        i32::try_from(month).ok()? - 1,
        i32::try_from(day).ok()?,
    );
    date.set_hours(0);
    date.set_minutes(0);
    date.set_seconds(0);
    date.set_milliseconds(0);
    let ms = date.get_time();
    #[expect(
        clippy::cast_possible_truncation,
        reason = "a JavaScript time value is a whole number of milliseconds"
    )]
    ms.is_finite().then_some(ms as i64)
}

#[wasm_bindgen(js_name = resolveSearchQuery)]
pub fn resolve_search_query(query: &str, directory: &str) -> Result<String, JsError> {
    json(&search_filter::resolve(
        &search_query::parse_search_query(query),
        &decode::<SearchDirectory>(directory)?,
        local_start_of_day,
    ))
}

#[wasm_bindgen(js_name = resolveRoomTarget)]
pub fn resolve_room_target(rooms: &str, value: &str) -> Result<Option<String>, JsError> {
    Ok(search_filter::resolve_room_target(
        &decode::<Vec<SearchRoom>>(rooms)?,
        value,
    ))
}

#[wasm_bindgen(js_name = resolveSpaceTarget)]
pub fn resolve_space_target(rooms: &str, value: &str) -> Result<Option<String>, JsError> {
    Ok(search_filter::resolve_space_target(
        &decode::<Vec<SearchRoom>>(rooms)?,
        value,
    ))
}

#[wasm_bindgen(js_name = suggestRoomTarget)]
pub fn suggest_room_target(rooms: &str, value: &str, spaces_only: bool) -> Result<String, JsError> {
    json(&search_filter::suggest_room(
        &decode::<Vec<SearchRoom>>(rooms)?,
        value,
        spaces_only,
    ))
}

#[wasm_bindgen(js_name = suggestPersonTarget)]
pub fn suggest_person_target(people: &str, value: &str) -> Result<String, JsError> {
    json(&search_filter::suggest_person(
        &decode::<Vec<SearchPerson>>(people)?,
        value,
    ))
}

#[wasm_bindgen(js_name = normalizeShortcode)]
#[must_use]
pub fn normalize_shortcode(raw: &str) -> String {
    shortcodes::normalize_shortcode(raw)
}

#[wasm_bindgen(js_name = uniqueShortcode)]
#[must_use]
pub fn unique_shortcode(shortcode: &str, taken: Vec<String>) -> String {
    let taken: HashSet<String> = taken.into_iter().collect();
    shortcodes::unique_shortcode(shortcode, |candidate| taken.contains(candidate))
}

#[wasm_bindgen(js_name = invalidShortcode)]
#[must_use]
pub fn invalid_shortcode(shortcodes: Vec<String>, original: Vec<String>) -> Option<String> {
    shortcodes::invalid_shortcode(
        shortcodes.iter().map(String::as_str),
        original.iter().map(String::as_str),
    )
    .map(ToOwned::to_owned)
}

#[wasm_bindgen(js_name = shortcodeWithoutExtension)]
#[must_use]
pub fn shortcode_without_extension(file_name: &str) -> String {
    shortcodes::shortcode_without_extension(file_name).to_owned()
}

#[wasm_bindgen(js_name = reactionKey)]
pub fn reaction_key(content: &str) -> Result<Option<String>, JsError> {
    Ok(event_preview::reaction_key(&decode::<serde_json::Value>(
        content,
    )?))
}
