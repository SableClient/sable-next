use serde::Serialize;

use crate::text::is_space;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum MatrixLink {
    User { user_id: String },
    Room { room_id: String },
    Event { room_id: String, event_id: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
pub struct JoinAddress {
    pub address: String,
    pub via: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
pub struct ViaSplit {
    pub href: String,
    pub via: Vec<String>,
}

const fn hex_value(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

fn percent_byte(bytes: &[u8], at: usize) -> Option<u8> {
    let high = hex_value(*bytes.get(at + 1)?)?;
    let low = hex_value(*bytes.get(at + 2)?)?;
    Some(high * 16 + low)
}

/// `decodeURIComponent`: a broken escape or invalid UTF-8 refuses the segment.
fn decode_component(segment: &str) -> Option<String> {
    let bytes = segment.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut at = 0;
    while let Some(&byte) = bytes.get(at) {
        if byte == b'%' {
            decoded.push(percent_byte(bytes, at)?);
            at += 3;
        } else {
            decoded.push(byte);
            at += 1;
        }
    }
    String::from_utf8(decoded).ok()
}

/// `URLSearchParams`: `+` is a space and a broken escape is kept as written.
fn decode_query_value(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut at = 0;
    while let Some(&byte) = bytes.get(at) {
        match byte {
            b'+' => {
                decoded.push(b' ');
                at += 1;
            }
            b'%' if percent_byte(bytes, at).is_some() => {
                decoded.extend(percent_byte(bytes, at));
                at += 3;
            }
            other => {
                decoded.push(other);
                at += 1;
            }
        }
    }
    String::from_utf8_lossy(&decoded).into_owned()
}

fn decoded_segment(segments: &[&str], index: usize) -> Option<String> {
    segments
        .get(index)
        .filter(|segment| !segment.is_empty())
        .and_then(|segment| decode_component(segment))
}

/// The path of a `matrix:` URI, without its query or fragment.
fn parse_path(path: &str) -> Option<MatrixLink> {
    let segments: Vec<&str> = path.trim_start_matches('/').split('/').collect();
    let kind = segments.first()?.to_lowercase();
    let id = decoded_segment(&segments, 1)?;

    if (kind == "u" || kind == "user") && segments.len() == 2 {
        return Some(MatrixLink::User {
            user_id: format!("@{id}"),
        });
    }
    let sigil = match kind.as_str() {
        "r" | "room" => '#',
        "roomid" => '!',
        _ => return None,
    };
    let room_id = format!("{sigil}{id}");
    if segments.len() == 2 {
        return Some(MatrixLink::Room { room_id });
    }
    let event_kind = segments.get(2)?.to_lowercase();
    let event_id = decoded_segment(&segments, 3)?;
    ((event_kind == "e" || event_kind == "event") && segments.len() == 4).then(|| {
        MatrixLink::Event {
            room_id,
            event_id: format!("${event_id}"),
        }
    })
}

fn strip_scheme<'a>(href: &'a str, scheme: &str) -> Option<&'a str> {
    let head = href.get(..scheme.len())?;
    head.eq_ignore_ascii_case(scheme)
        .then(|| href.get(scheme.len()..))
        .flatten()
}

/// `matrix.to` keeps `?via=` inside the fragment, so the first `?` there starts
/// the query; no Matrix id contains one.
fn parse_matrix_to(href: &str) -> Option<MatrixLink> {
    let rest = strip_scheme(href, "https://").or_else(|| strip_scheme(href, "http://"))?;
    let (authority, after) = rest.split_at(rest.find(['/', '?', '#']).unwrap_or(rest.len()));
    let host = authority.rsplit('@').next().unwrap_or(authority);
    let host = host.split(':').next().unwrap_or(host);
    if !host.eq_ignore_ascii_case("matrix.to") {
        return None;
    }
    let fragment = after.split_once('#').map(|(_, fragment)| fragment)?;
    let path = fragment.trim_start_matches('/').split('?').next()?;
    if path.is_empty() {
        return None;
    }
    let segments: Vec<&str> = path.split('/').collect();
    let first = decoded_segment(&segments, 0)?;
    if first.starts_with('@') && segments.len() == 1 {
        return Some(MatrixLink::User { user_id: first });
    }
    if !first.starts_with('!') && !first.starts_with('#') {
        return None;
    }
    if segments.len() == 1 {
        return Some(MatrixLink::Room { room_id: first });
    }
    let event_id = decoded_segment(&segments, 1)?;
    event_id.starts_with('$').then_some(MatrixLink::Event {
        room_id: first,
        event_id,
    })
}

#[must_use]
pub fn parse_matrix_link(href: &str) -> Option<MatrixLink> {
    strip_scheme(href, "matrix:").map_or_else(
        || parse_matrix_to(href),
        |rest| parse_path(rest.split(['?', '#']).next().unwrap_or(rest)),
    )
}

/// The servers a link names to route a room through, and the link without them.
#[must_use]
pub fn split_via(href: &str) -> ViaSplit {
    let after_hash = href.find('#').unwrap_or(0);
    let Some(query) = href
        .get(after_hash..)
        .and_then(|rest| rest.find('?'))
        .map(|offset| after_hash + offset)
    else {
        return ViaSplit {
            href: href.to_owned(),
            via: Vec::new(),
        };
    };
    let mut via: Vec<String> = Vec::new();
    for pair in href.get(query + 1..).unwrap_or_default().split('&') {
        let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
        let value = decode_query_value(value);
        if decode_query_value(key) == "via" && !value.is_empty() && !via.contains(&value) {
            via.push(value);
        }
    }
    ViaSplit {
        href: href.get(..query).unwrap_or(href).to_owned(),
        via,
    }
}

fn is_address_part(part: &str) -> bool {
    !part.is_empty() && !part.chars().any(|c| is_space(c) || c == '?')
}

/// `#alias:server` or `!id`, optionally with a server, as typed.
fn is_room_address(input: &str) -> bool {
    if let Some(alias) = input.strip_prefix('#') {
        return alias
            .split_once(':')
            .is_some_and(|(local, server)| is_address_part(local) && is_address_part(server));
    }
    input
        .strip_prefix('!')
        .is_some_and(|id| match id.split_once(':') {
            Some((local, server)) => is_address_part(local) && is_address_part(server),
            None => is_address_part(id),
        })
}

/// A room address or a link naming a room, with the servers it routes through.
#[must_use]
pub fn parse_join_address(input: &str) -> Option<JoinAddress> {
    let trimmed = input.trim_matches(is_space);
    if trimmed.is_empty() {
        return None;
    }
    if is_room_address(trimmed) {
        return Some(JoinAddress {
            address: trimmed.to_owned(),
            via: Vec::new(),
        });
    }
    let split = split_via(trimmed);
    let address = match parse_matrix_link(&split.href)? {
        MatrixLink::User { .. } => return None,
        MatrixLink::Room { room_id } | MatrixLink::Event { room_id, .. } => room_id,
    };
    Some(JoinAddress {
        address,
        via: split.via,
    })
}

#[cfg(test)]
mod tests {
    use super::{MatrixLink, parse_join_address, parse_matrix_link, split_via};

    #[test]
    fn a_join_address_is_an_id_an_alias_or_a_link_to_a_room() {
        let address =
            |input: &str| parse_join_address(input).map(|found| (found.address, found.via));
        assert_eq!(
            address(" #lobby:example.org "),
            Some(("#lobby:example.org".to_owned(), Vec::new()))
        );
        assert_eq!(address("!abc"), Some(("!abc".to_owned(), Vec::new())));
        assert_eq!(
            address("https://matrix.to/#/!room:example.org?via=a.example"),
            Some(("!room:example.org".to_owned(), vec!["a.example".to_owned()]))
        );
        assert_eq!(address("https://matrix.to/#/@user:example.org"), None);
        assert_eq!(address("#no-server"), None);
        assert_eq!(address(""), None);
    }

    fn user(id: &str) -> MatrixLink {
        MatrixLink::User {
            user_id: id.to_owned(),
        }
    }

    fn room(id: &str) -> MatrixLink {
        MatrixLink::Room {
            room_id: id.to_owned(),
        }
    }

    fn event(room: &str, event: &str) -> MatrixLink {
        MatrixLink::Event {
            room_id: room.to_owned(),
            event_id: event.to_owned(),
        }
    }

    #[test]
    fn parses_both_link_forms() {
        for (href, expected) in [
            ("matrix:u/alice:example.org", user("@alice:example.org")),
            (
                "matrix:roomid/room:example.org/e/event",
                event("!room:example.org", "$event"),
            ),
            (
                "https://matrix.to/#/#lobby:example.org",
                room("#lobby:example.org"),
            ),
            (
                "https://matrix.to/#/!room:example.org/$event",
                event("!room:example.org", "$event"),
            ),
            (
                "https://matrix.to/#/%23lobby%3Aexample.org",
                room("#lobby:example.org"),
            ),
        ] {
            assert_eq!(parse_matrix_link(href), Some(expected), "{href}");
        }
    }

    #[test]
    fn keeps_via_out_of_the_ids() {
        for (href, expected) in [
            (
                "https://matrix.to/#/!somewhere:example.org?via=elsewhere.ca",
                room("!somewhere:example.org"),
            ),
            (
                "https://matrix.to/#/!somewhere:example.org/$event:example.org?via=elsewhere.ca",
                event("!somewhere:example.org", "$event:example.org"),
            ),
            (
                "matrix:roomid/somewhere:example.org/e/event?via=elsewhere.ca",
                event("!somewhere:example.org", "$event"),
            ),
        ] {
            assert_eq!(parse_matrix_link(href), Some(expected), "{href}");
        }
    }

    #[test]
    fn refuses_what_is_not_a_matrix_link() {
        for href in [
            "https://example.org/#/!room:example.org",
            "matrix:u/alice:example.org/e/event",
            "matrix:roomid/room:example.org/e/event/extra",
            "matrix:roomid/room:example.org/x/event",
            "matrix:person/alice:example.org",
            "https://matrix.to/#/",
            "https://matrix.to/#/alice:example.org",
            "https://matrix.to/#/%E0%A4%A",
        ] {
            assert_eq!(parse_matrix_link(href), None, "{href}");
        }
    }

    #[test]
    fn via_is_read_from_the_query_after_the_fragment() {
        let split = split_via(
            "https://matrix.to/#/!room:example.org?via=a.example&via=b.example&via=a.example&via=",
        );
        assert_eq!(split.href, "https://matrix.to/#/!room:example.org");
        assert_eq!(split.via, vec!["a.example", "b.example"]);

        let plain = split_via("#room:example.org");
        assert_eq!(plain.href, "#room:example.org");
        assert!(plain.via.is_empty());
    }
}
