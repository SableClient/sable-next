//! Turns a parsed search query into the filter the index runs, resolving the
//! names typed after `in:`, `from:` and the rest against what the client knows.

use std::collections::{HashMap, HashSet, VecDeque};

use regex_lite::{Regex, RegexBuilder};
use serde::{Deserialize, Serialize};

use crate::search_query::{ParsedQuery, SearchOperator, SearchToken};
use crate::spaces::SpaceChildEdge;
use crate::text::{tail, trim};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
#[serde(rename_all = "snake_case")]
pub enum SearchAttachment {
    Image,
    Video,
    Audio,
    File,
    Link,
    Poll,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
#[serde(default)]
pub struct SearchFilter {
    pub rooms: Vec<String>,
    pub senders: Vec<String>,
    pub mentions: Vec<String>,
    pub has: Vec<SearchAttachment>,
    pub not_rooms: Vec<String>,
    pub not_senders: Vec<String>,
    pub not_mentions: Vec<String>,
    pub not_has: Vec<SearchAttachment>,
    #[cfg_attr(feature = "typegen", specta(type = Option<specta_typescript::Number>))]
    pub after_ts: Option<u64>,
    #[cfg_attr(feature = "typegen", specta(type = Option<specta_typescript::Number>))]
    pub before_ts: Option<u64>,
    pub phrases: Vec<String>,
    pub exclude: Vec<String>,
    pub pinned: Option<bool>,
    pub in_thread: Option<bool>,
    pub file_types: Vec<String>,
    pub not_file_types: Vec<String>,
    pub pattern: Option<String>,
    pub state_events: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
#[expect(
    clippy::struct_excessive_bools,
    reason = "wire type mirroring the room list"
)]
pub struct SearchRoom {
    pub room_id: String,
    pub name: Option<String>,
    pub canonical_alias: Option<String>,
    pub joined: bool,
    pub is_tombstoned: bool,
    pub is_space: bool,
    pub is_direct: bool,
    pub direct_targets: Vec<String>,
    pub space_children: Vec<SpaceChildEdge>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
pub struct SearchPerson {
    pub user_id: String,
    pub display_name: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
pub struct SearchDirectory {
    pub rooms: Vec<SearchRoom>,
    pub people: Vec<SearchPerson>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
pub struct ResolvedQuery {
    pub filter: SearchFilter,
    /// Tokens naming nothing this client knows, which must stop the search
    /// rather than silently widen it.
    pub unresolved: Vec<SearchToken>,
    /// A space with no joined rooms in it.
    pub matches_nothing: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
pub struct TargetSuggestion {
    pub label: String,
    pub value: String,
}

const FILE_TYPES: [&str; 37] = [
    "pdf", "zip", "txt", "md", "csv", "json", "doc", "docx", "odt", "xls", "xlsx", "ods", "ppt",
    "pptx", "odp", "gif", "png", "jpg", "jpeg", "webp", "svg", "mp3", "ogg", "opus", "wav", "flac",
    "mp4", "mkv", "webm", "mov", "apk", "exe", "tar", "gz", "7z", "rar", "iso",
];

fn attachment(value: &str) -> Option<SearchAttachment> {
    match value {
        "image" => Some(SearchAttachment::Image),
        "video" => Some(SearchAttachment::Video),
        "audio" | "sound" => Some(SearchAttachment::Audio),
        "file" => Some(SearchAttachment::File),
        "link" => Some(SearchAttachment::Link),
        "poll" => Some(SearchAttachment::Poll),
        _ => None,
    }
}

fn file_type(value: &str) -> Option<String> {
    if let Some(extension) = value.strip_prefix('.') {
        let valid = (1..=10).contains(&extension.len())
            && extension.bytes().all(|byte| byte.is_ascii_alphanumeric());
        return valid.then(|| extension.to_owned());
    }
    FILE_TYPES.contains(&value).then(|| value.to_owned())
}

/// A `/…/` value, compiled case-insensitively.
fn pattern(value: &str) -> Option<Regex> {
    let inner = value
        .strip_prefix('/')?
        .strip_suffix('/')
        .filter(|inner| !inner.is_empty())?;
    RegexBuilder::new(inner).case_insensitive(true).build().ok()
}

/// `regex-lite` folds ASCII only, so a lowercase pattern also gets a lowercase
/// text to match.
fn pattern_matches(pattern: &Regex, text: &str) -> bool {
    pattern.is_match(text) || pattern.is_match(&text.to_lowercase())
}

/// `YYYY`, `YYYY-MM` or `YYYY-MM-DD`, and how many of those parts there were.
fn civil_date(value: &str) -> Option<((i32, u32, u32), usize)> {
    let parts: Vec<&str> = value.split('-').collect();
    let number = |part: &str, digits: usize| {
        (part.len() == digits && part.bytes().all(|byte| byte.is_ascii_digit()))
            .then(|| part.parse::<u32>().ok())
            .flatten()
    };
    let year = i32::try_from(number(parts.first()?, 4)?).ok()?;
    let month = parts.get(1).map_or(Some(1), |part| number(part, 2))?;
    let day = parts.get(2).map_or(Some(1), |part| number(part, 2))?;
    let valid = parts.len() <= 3 && (1..=12).contains(&month) && (1..=31).contains(&day);
    valid.then_some(((year, month, day), parts.len()))
}

fn rank(room: &SearchRoom) -> u8 {
    (if room.joined { 0 } else { 4 })
        + (if room.is_tombstoned { 2 } else { 0 })
        + u8::from(room.is_space)
}

fn best<'a>(rooms: impl Iterator<Item = &'a SearchRoom>) -> Option<&'a SearchRoom> {
    rooms.fold(None, |winner: Option<&SearchRoom>, room| match winner {
        Some(winner) if rank(winner) <= rank(room) => Some(winner),
        _ => Some(room),
    })
}

fn localpart(id: &str) -> &str {
    let id = id.char_indices().nth(1).map_or("", |(at, _)| tail(id, at));
    id.split(':').next().unwrap_or_default()
}

fn lower(text: Option<&String>) -> Option<String> {
    text.map(|text| text.to_lowercase())
}

/// The room a typed name, alias or id points at, preferring a joined, live
/// room over a left or replaced one.
fn room_target<'a>(
    rooms: impl Iterator<Item = &'a SearchRoom> + Clone,
    value: &str,
) -> Option<&'a SearchRoom> {
    let wanted = trim(value).to_lowercase();
    if wanted.is_empty() {
        return None;
    }
    let aliased = if wanted.starts_with('#') {
        wanted.clone()
    } else {
        format!("#{wanted}")
    };

    let identified = best(rooms.clone().filter(|room| {
        let alias = lower(room.canonical_alias.as_ref());
        room.room_id.to_lowercase() == wanted
            || alias.as_ref() == Some(&wanted)
            || alias.as_ref() == Some(&aliased)
    }));
    if identified.is_some() {
        return identified;
    }

    let local = format!(
        "#{}",
        tail(&aliased, 1).split(':').next().unwrap_or_default()
    );
    best(rooms.filter(|room| {
        lower(room.name.as_ref()).as_ref() == Some(&wanted)
            || lower(room.canonical_alias.as_ref())
                .is_some_and(|alias| alias.split(':').next() == Some(local.as_str()))
    }))
}

#[must_use]
pub fn resolve_room_target(rooms: &[SearchRoom], value: &str) -> Option<String> {
    room_target(rooms.iter(), value).map(|room| room.room_id.clone())
}

#[must_use]
pub fn resolve_space_target(rooms: &[SearchRoom], value: &str) -> Option<String> {
    room_target(rooms.iter().filter(|room| room.is_space), value).map(|room| room.room_id.clone())
}

/// Every room below a space, through its joined subspaces, that is not a
/// space itself.
fn space_rooms(rooms: &[SearchRoom], value: &str) -> Option<Vec<String>> {
    let space_id = resolve_space_target(rooms, value)?;
    let by_id: HashMap<&str, &SearchRoom> = rooms
        .iter()
        .map(|room| (room.room_id.as_str(), room))
        .collect();
    let mut seen = HashSet::new();
    let mut queue = VecDeque::from([space_id.as_str()]);
    let mut found = Vec::new();
    while let Some(room_id) = queue.pop_front() {
        if !seen.insert(room_id) {
            continue;
        }
        let Some(room) = by_id.get(room_id) else {
            continue;
        };
        if room.is_space && room.joined {
            queue.extend(room.space_children.iter().map(|edge| edge.room_id.as_str()));
        }
        if room.room_id != space_id && !room.is_space {
            found.push(room.room_id.clone());
        }
    }
    Some(found)
}

fn direct_rooms(rooms: &[SearchRoom], value: &str) -> Option<Vec<String>> {
    let wanted = trim(value).to_lowercase();
    if wanted.is_empty() {
        return None;
    }
    let local = wanted.strip_prefix('@').unwrap_or(&wanted);
    let found: Vec<String> = rooms
        .iter()
        .filter(|room| {
            room.is_direct
                && room.direct_targets.iter().any(|user_id| {
                    let folded = user_id.to_lowercase();
                    folded == wanted || localpart(&folded) == local
                })
        })
        .map(|room| room.room_id.clone())
        .collect();
    (!found.is_empty()).then_some(found)
}

/// A typed person: a full user id as it is, otherwise a known person by id,
/// localpart or display name.
#[must_use]
pub fn resolve_person(people: &[SearchPerson], value: &str) -> Option<String> {
    let wanted = trim(value);
    if wanted.is_empty() {
        return None;
    }
    if wanted.starts_with('@') && wanted.contains(':') {
        return Some(wanted.to_owned());
    }
    let folded = wanted.to_lowercase();
    let local = folded.strip_prefix('@').unwrap_or(&folded);
    people
        .iter()
        .find(|person| {
            let user_id = person.user_id.to_lowercase();
            user_id == folded
                || localpart(&user_id) == local
                || person.display_name.to_lowercase() == folded
        })
        .map(|person| person.user_id.clone())
}

#[must_use]
pub fn suggest_room(
    rooms: &[SearchRoom],
    value: &str,
    spaces_only: bool,
) -> Option<TargetSuggestion> {
    let wanted = trim(value).to_lowercase();
    let wanted = wanted.strip_prefix('#').unwrap_or(&wanted);
    if wanted.is_empty() {
        return None;
    }
    let room = best(rooms.iter().filter(|room| {
        room.is_space == spaces_only
            && (lower(room.name.as_ref()).is_some_and(|name| name.contains(wanted))
                || lower(room.canonical_alias.as_ref()).is_some_and(|alias| alias.contains(wanted)))
    }))?;
    let value = room
        .canonical_alias
        .clone()
        .unwrap_or_else(|| room.room_id.clone());
    Some(TargetSuggestion {
        label: room.name.clone().unwrap_or_else(|| value.clone()),
        value,
    })
}

#[must_use]
pub fn suggest_person(people: &[SearchPerson], value: &str) -> Option<TargetSuggestion> {
    let wanted = trim(value).to_lowercase();
    let wanted = wanted.strip_prefix('@').unwrap_or(&wanted);
    if wanted.is_empty() {
        return None;
    }
    people
        .iter()
        .find(|person| {
            person.user_id.to_lowercase().contains(wanted)
                || person.display_name.to_lowercase().contains(wanted)
        })
        .map(|person| TargetSuggestion {
            label: person.display_name.clone(),
            value: person.user_id.clone(),
        })
}

fn later(current: Option<u64>, next: u64) -> u64 {
    current.map_or(next, |current| current.max(next))
}

fn earlier(current: Option<u64>, next: u64) -> u64 {
    current.map_or(next, |current| current.min(next))
}

struct Resolution<'a, F> {
    rooms: &'a [SearchRoom],
    people: &'a [SearchPerson],
    start_of_day: F,
    resolved: ResolvedQuery,
}

impl<F: Fn(i32, u32, u32) -> Option<i64>> Resolution<'_, F> {
    fn day(&self, (year, month, day): (i32, u32, u32)) -> Option<u64> {
        (self.start_of_day)(year, month, day).and_then(|ms| u64::try_from(ms).ok())
    }

    fn period(&self, value: &str) -> Option<(u64, u64)> {
        let (date @ (year, month, day), parts) = civil_date(value)?;
        let next = match parts {
            1 => (year + 1, 1, 1),
            2 => (year, month + 1, 1),
            _ => (year, month, day + 1),
        };
        Some((self.day(date)?, self.day(next)?.checked_sub(1)?))
    }

    fn unresolved(&mut self, token: &SearchToken) {
        self.resolved.unresolved.push(token.clone());
    }

    fn rooms(&mut self, room_ids: Vec<String>, negated: bool) {
        let filter = &mut self.resolved.filter;
        if negated {
            filter.not_rooms.extend(room_ids);
        } else if room_ids.is_empty() {
            self.resolved.matches_nothing = true;
        } else {
            filter.rooms.extend(room_ids);
        }
    }

    fn room(&mut self, token: &SearchToken) {
        let Some(room_id) = resolve_room_target(self.rooms, &token.value) else {
            return self.unresolved(token);
        };
        match space_rooms(self.rooms, &room_id) {
            Some(children) => self.rooms(children, token.negated),
            None => self.rooms(vec![room_id], token.negated),
        }
    }

    fn people(&mut self, token: &SearchToken) {
        let user_ids: Vec<String> = pattern(&token.value).map_or_else(
            || {
                resolve_person(self.people, &token.value)
                    .into_iter()
                    .collect()
            },
            |pattern| {
                self.people
                    .iter()
                    .filter(|person| {
                        pattern_matches(&pattern, &person.user_id)
                            || pattern_matches(&pattern, &person.display_name)
                    })
                    .map(|person| person.user_id.clone())
                    .collect()
            },
        );
        if user_ids.is_empty() {
            return self.unresolved(token);
        }
        let filter = &mut self.resolved.filter;
        let list = match (token.operator == SearchOperator::From, token.negated) {
            (true, false) => &mut filter.senders,
            (true, true) => &mut filter.not_senders,
            (false, false) => &mut filter.mentions,
            (false, true) => &mut filter.not_mentions,
        };
        list.extend(user_ids);
    }

    fn has(&mut self, token: &SearchToken) {
        let value = token.value.to_lowercase();
        let filter = &mut self.resolved.filter;
        if value == "pin" {
            filter.pinned = Some(!token.negated);
        } else if let Some(kind) = attachment(&value) {
            let list = if token.negated {
                &mut filter.not_has
            } else {
                &mut filter.has
            };
            list.push(kind);
        } else if let Some(kind) = file_type(&value) {
            let list = if token.negated {
                &mut filter.not_file_types
            } else {
                &mut filter.file_types
            };
            list.push(kind);
        } else {
            self.unresolved(token);
        }
    }

    fn date(&mut self, token: &SearchToken) {
        let value = token.value.as_str();
        let bounds = match token.operator {
            SearchOperator::After => civil_date(value)
                .and_then(|(date, _)| self.day(date))
                .map(|at| (Some(at), None)),
            SearchOperator::Before => civil_date(value)
                .and_then(|(date, _)| self.day(date))
                .map(|at| (None, Some(at))),
            SearchOperator::On if civil_date(value).is_none_or(|(_, parts)| parts != 3) => None,
            _ => self.period(value).map(|(from, to)| (Some(from), Some(to))),
        };
        let Some((from, to)) = bounds else {
            return self.unresolved(token);
        };
        let filter = &mut self.resolved.filter;
        if let Some(from) = from {
            filter.after_ts = Some(later(filter.after_ts, from));
        }
        if let Some(to) = to {
            filter.before_ts = Some(earlier(filter.before_ts, to));
        }
    }

    fn token(&mut self, token: &SearchToken) {
        let negated = token.negated;
        let value = token.value.as_str();
        match token.operator {
            SearchOperator::In => self.room(token),
            SearchOperator::Space => match space_rooms(self.rooms, value) {
                Some(children) => self.rooms(children, negated),
                None => self.unresolved(token),
            },
            SearchOperator::From | SearchOperator::Mentions => self.people(token),
            SearchOperator::Has => self.has(token),
            SearchOperator::Regex if negated => self.unresolved(token),
            SearchOperator::Regex => {
                let source = pattern(value).map_or(value, |_| {
                    tail(value, 1).strip_suffix('/').unwrap_or_default()
                });
                self.resolved.filter.pattern = Some(source.to_owned());
            }
            SearchOperator::After
            | SearchOperator::Before
            | SearchOperator::During
            | SearchOperator::On => self.date(token),
            SearchOperator::With => {
                let person = resolve_person(self.people, value);
                match direct_rooms(self.rooms, person.as_deref().unwrap_or(value)) {
                    Some(room_ids) if negated => self.resolved.filter.not_rooms.extend(room_ids),
                    Some(room_ids) => self.resolved.filter.rooms.extend(room_ids),
                    None => self.unresolved(token),
                }
            }
            SearchOperator::Is => match value.to_lowercase().as_str() {
                "thread" => self.resolved.filter.in_thread = Some(!negated),
                "state" => self.resolved.filter.state_events = Some(!negated),
                _ => self.unresolved(token),
            },
            SearchOperator::Pinned => match value.to_lowercase().as_str() {
                "true" => self.resolved.filter.pinned = Some(!negated),
                "false" => self.resolved.filter.pinned = Some(negated),
                _ => self.unresolved(token),
            },
        }
    }
}

/// Local midnight of a calendar date in milliseconds, overflowing as JavaScript's `Date` does.
#[must_use]
pub fn resolve(
    parsed: &ParsedQuery,
    directory: &SearchDirectory,
    start_of_day: impl Fn(i32, u32, u32) -> Option<i64>,
) -> ResolvedQuery {
    let mut resolution = Resolution {
        rooms: &directory.rooms,
        people: &directory.people,
        start_of_day,
        resolved: ResolvedQuery {
            filter: SearchFilter {
                phrases: parsed.phrases.clone(),
                exclude: parsed.exclude.clone(),
                ..SearchFilter::default()
            },
            ..ResolvedQuery::default()
        },
    };
    for token in &parsed.tokens {
        resolution.token(token);
    }
    resolution.resolved
}

#[cfg(test)]
mod tests {
    use super::{
        ResolvedQuery, SearchAttachment, SearchDirectory, SearchFilter, SearchPerson, SearchRoom,
        resolve, resolve_room_target, suggest_person, suggest_room,
    };
    use crate::civil::{MS_PER_DAY, days_from_civil};
    use crate::search_query::parse_search_query;
    use crate::spaces::SpaceChildEdge;

    fn room(room_id: &str, name: &str) -> SearchRoom {
        SearchRoom {
            room_id: room_id.to_owned(),
            name: Some(name.to_owned()),
            canonical_alias: None,
            joined: true,
            is_tombstoned: false,
            is_space: false,
            is_direct: false,
            direct_targets: Vec::new(),
            space_children: Vec::new(),
        }
    }

    fn space(room_id: &str, name: &str, children: &[&str]) -> SearchRoom {
        SearchRoom {
            is_space: true,
            space_children: children
                .iter()
                .map(|child| SpaceChildEdge {
                    room_id: (*child).to_owned(),
                    via: Vec::new(),
                    order: None,
                    origin_server_ts: 0,
                    suggested: false,
                })
                .collect(),
            ..room(room_id, name)
        }
    }

    fn directory() -> SearchDirectory {
        SearchDirectory {
            rooms: vec![
                room("!dev:example.org", "dev"),
                room("!ops:example.org", "ops"),
                space(
                    "!eng:example.org",
                    "eng",
                    &["!dev:example.org", "!ops:example.org"],
                ),
                space("!new:example.org", "new", &[]),
                SearchRoom {
                    is_direct: true,
                    direct_targets: vec!["@erwan:example.org".to_owned()],
                    ..room("!dm:example.org", "Erwan")
                },
            ],
            people: vec![
                SearchPerson {
                    user_id: "@erwan:example.org".to_owned(),
                    display_name: "Erwan".to_owned(),
                },
                SearchPerson {
                    user_id: "@meow:example.org".to_owned(),
                    display_name: "Meow".to_owned(),
                },
                SearchPerson {
                    user_id: "@meowmeow:example.org".to_owned(),
                    display_name: "Meow Meow".to_owned(),
                },
            ],
        }
    }

    /// UTC midnight, so the tests do not depend on the machine's zone.
    fn utc_midnight(year: i32, month: u32, day: u32) -> i64 {
        let months = i64::from(year) * 12 + i64::from(month) - 1;
        let days = days_from_civil(months.div_euclid(12), months.rem_euclid(12) + 1, 1)
            + i64::from(day)
            - 1;
        days * MS_PER_DAY
    }

    fn at(year: i32, month: u32, day: u32) -> Option<u64> {
        u64::try_from(utc_midnight(year, month, day)).ok()
    }

    fn resolved(query: &str) -> ResolvedQuery {
        resolve(
            &parse_search_query(query),
            &directory(),
            |year, month, day| Some(utc_midnight(year, month, day)),
        )
    }

    fn filter(query: &str) -> SearchFilter {
        resolved(query).filter
    }

    fn unresolved(query: &str) -> Vec<String> {
        resolved(query)
            .unresolved
            .into_iter()
            .map(|token| token.value)
            .collect()
    }

    #[test]
    fn names_resolve_to_ids_and_unknown_names_are_reported() {
        let resolved = resolved("from:erwan from:nobody in:dev in:missing");

        assert_eq!(resolved.filter.senders, ["@erwan:example.org"]);
        assert_eq!(resolved.filter.rooms, ["!dev:example.org"]);
        assert_eq!(
            resolved
                .unresolved
                .iter()
                .map(|token| token.value.as_str())
                .collect::<Vec<_>>(),
            ["nobody", "missing"]
        );
    }

    #[test]
    fn a_negated_sender_is_denied_by_identity() {
        let filter = filter("deploy -from:erwan");

        assert!(filter.senders.is_empty());
        assert_eq!(filter.not_senders, ["@erwan:example.org"]);
        assert!(filter.exclude.is_empty());
        assert_eq!(unresolved("deploy -from:nobody"), ["nobody"]);
    }

    #[test]
    fn a_full_user_id_needs_no_directory_entry() {
        assert_eq!(
            filter("from:@someone:example.org").senders,
            ["@someone:example.org"]
        );
    }

    #[test]
    fn a_space_expands_to_its_rooms() {
        let both = ["!dev:example.org", "!ops:example.org"];

        assert_eq!(filter("deploy space:eng").rooms, both);
        assert_eq!(filter("deploy -space:eng").not_rooms, both);
        assert_eq!(filter("in:eng deploy").rooms, both);
        assert_eq!(filter("-in:eng deploy").not_rooms, both);
        assert_eq!(unresolved("deploy space:unknown"), ["unknown"]);
    }

    #[test]
    fn a_space_with_no_rooms_matches_nothing_and_excluding_it_excludes_nothing() {
        assert!(resolved("space:new deploy").matches_nothing);
        assert!(!resolved("-space:new deploy").matches_nothing);
        assert!(!resolved("space:eng deploy").matches_nothing);
    }

    #[test]
    fn a_negated_room_is_denied_by_identity() {
        let filter = filter("deploy -in:dev");

        assert!(filter.rooms.is_empty());
        assert_eq!(filter.not_rooms, ["!dev:example.org"]);
    }

    #[test]
    fn has_takes_kinds_aliases_file_types_and_pins() {
        assert_eq!(filter("has:sound").has, [SearchAttachment::Audio]);
        assert_eq!(filter("has:Image").has, [SearchAttachment::Image]);
        assert_eq!(filter("-has:image").not_has, [SearchAttachment::Image]);

        let filter = filter("has:poll has:PDF -has:.zip is:state");
        assert_eq!(filter.has, [SearchAttachment::Poll]);
        assert_eq!(filter.file_types, ["pdf"]);
        assert_eq!(filter.not_file_types, ["zip"]);
        assert_eq!(filter.state_events, Some(true));
        assert_eq!(unresolved("has:embed"), ["embed"]);
    }

    #[test]
    fn pins_threads_and_their_negations() {
        assert_eq!(self::filter("pinned:true").pinned, Some(true));
        assert_eq!(self::filter("has:pin").pinned, Some(true));
        assert_eq!(self::filter("pinned:false").pinned, Some(false));
        assert_eq!(self::filter("-has:pin").pinned, Some(false));
        assert_eq!(self::filter("deploy").pinned, None);
        assert_eq!(unresolved("pinned:maybe"), ["maybe"]);

        assert_eq!(self::filter("is:thread").in_thread, Some(true));
        assert_eq!(self::filter("-is:thread").in_thread, Some(false));
        assert_eq!(unresolved("is:starred"), ["starred"]);
    }

    #[test]
    fn with_scopes_to_the_direct_messages_with_that_person() {
        assert_eq!(filter("deploy with:erwan").rooms, ["!dm:example.org"]);
        assert_eq!(filter("deploy -with:erwan").not_rooms, ["!dm:example.org"]);
        assert_eq!(unresolved("with:nobody"), ["nobody"]);
    }

    #[test]
    fn a_pattern_picks_every_matching_person_and_regex_sets_the_body_pattern() {
        let filter = filter(r#"regex:"me+ow" from:/^@meow/"#);

        assert_eq!(filter.pattern.as_deref(), Some("me+ow"));
        assert_eq!(
            filter.senders,
            ["@meow:example.org", "@meowmeow:example.org"]
        );
        assert_eq!(self::filter("regex:/a+b/").pattern.as_deref(), Some("a+b"));
        assert_eq!(unresolved("from:/nobody/"), ["/nobody/"]);
        assert_eq!(unresolved("-regex:x"), ["x"]);
    }

    #[test]
    fn dates_bound_a_day_a_month_or_a_year() {
        let day = filter("on:2026-03-15");
        assert_eq!(day.after_ts, at(2026, 3, 15));
        assert_eq!(day.before_ts, at(2026, 3, 16).map(|end| end - 1));
        assert_eq!(filter("during:2026-03-15"), day);

        let month = filter("during:2026-12");
        assert_eq!(month.after_ts, at(2026, 12, 1));
        assert_eq!(month.before_ts, at(2027, 1, 1).map(|end| end - 1));

        let year = filter("during:2025");
        assert_eq!(year.after_ts, at(2025, 1, 1));
        assert_eq!(year.before_ts, at(2026, 1, 1).map(|end| end - 1));

        let bounds = filter("after:2026-01-01 before:2026-02-01");
        assert_eq!(bounds.after_ts, at(2026, 1, 1));
        assert_eq!(bounds.before_ts, at(2026, 2, 1));
    }

    #[test]
    fn date_bounds_intersect_whatever_order_they_are_written_in() {
        let later = filter("during:2025 after:2025-06-01");
        assert_eq!(later.after_ts, at(2025, 6, 1));
        assert_eq!(later.before_ts, at(2026, 1, 1).map(|end| end - 1));

        let earlier = filter("after:2025-06-01 during:2025 before:2025-07-01");
        assert_eq!(earlier.after_ts, at(2025, 6, 1));
        assert_eq!(earlier.before_ts, at(2025, 7, 1));
    }

    #[test]
    fn an_unparseable_date_is_reported_rather_than_guessed() {
        assert_eq!(filter("after:not-a-date").after_ts, None);
        assert_eq!(unresolved("after:not-a-date"), ["not-a-date"]);
        assert_eq!(unresolved("during:2026-13"), ["2026-13"]);
        assert_eq!(unresolved("on:2026-03"), ["2026-03"]);
        assert_eq!(unresolved("after:2026-1-5"), ["2026-1-5"]);
    }

    #[test]
    fn a_joined_live_room_wins_over_a_left_or_replaced_one() {
        let rooms = [
            SearchRoom {
                joined: false,
                ..room("!old:example.org", "dev")
            },
            SearchRoom {
                is_tombstoned: true,
                ..room("!replaced:example.org", "dev")
            },
            room("!dev:example.org", "dev"),
        ];

        assert_eq!(
            resolve_room_target(&rooms, "Dev").as_deref(),
            Some("!dev:example.org")
        );
    }

    #[test]
    fn suggestions_complete_a_partial_name() {
        let directory = directory();

        assert_eq!(
            suggest_room(&directory.rooms, "de", false).map(|found| found.value),
            Some("!dev:example.org".to_owned())
        );
        assert_eq!(
            suggest_room(&directory.rooms, "en", true).map(|found| found.label),
            Some("eng".to_owned())
        );
        assert_eq!(
            suggest_person(&directory.people, "@erw").map(|found| found.value),
            Some("@erwan:example.org".to_owned())
        );
        assert_eq!(suggest_person(&directory.people, " "), None);
    }
}
