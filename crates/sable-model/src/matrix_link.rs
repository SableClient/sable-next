use ruma_common::matrix_uri::MatrixId;
use ruma_common::{
    MatrixToUri, MatrixUri, OwnedServerName, RoomAliasId, RoomId, ServerName, UserId,
};
use serde::Serialize;

use crate::text::{head, is_space, tail};

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

#[must_use]
pub fn parse_matrix_link(href: &str) -> Option<MatrixLink> {
    let normalized = href
        .strip_prefix("https://link.sable.moe/#/")
        .map(|fragment| format!("https://matrix.to/#/{fragment}"));
    let href = normalized.as_deref().unwrap_or(href);
    let path = href.split(['?', '#']).next().unwrap_or(href);
    let identifier = href
        .find('#')
        .and_then(|hash| Some(head(href, hash + tail(href, hash).find('?')?)))
        .unwrap_or(href);
    let id = MatrixUri::parse(path)
        .map(|uri| uri.id().clone())
        .or_else(|_| MatrixToUri::parse(identifier).map(|uri| uri.id().clone()))
        .ok()?;
    Some(match id {
        MatrixId::User(user_id) => MatrixLink::User {
            user_id: user_id.into(),
        },
        MatrixId::Room(room_id) => MatrixLink::Room {
            room_id: room_id.into(),
        },
        MatrixId::RoomAlias(room_id) => MatrixLink::Room {
            room_id: room_id.into(),
        },
        MatrixId::Event(room_id, event_id) => MatrixLink::Event {
            room_id: room_id.into(),
            event_id: event_id.into(),
        },
        _ => return None,
    })
}

/// The spec's recommended cap on routing servers in a link.
const MAX_VIA: usize = 3;

/// The `matrix:` URI a mention pill links to, routed through `via` for room ids.
#[must_use]
pub fn mention_uri(id: &str, via: &[String]) -> Option<String> {
    let uri = if let Ok(user_id) = UserId::parse(id) {
        user_id.matrix_uri(false)
    } else if let Ok(alias) = RoomAliasId::parse(id) {
        alias.matrix_uri(false)
    } else {
        let via: Vec<OwnedServerName> = via
            .iter()
            .filter_map(|server| ServerName::parse(server).ok())
            .take(MAX_VIA)
            .collect();
        RoomId::parse(id).ok()?.matrix_uri_via(via, false)
    };
    Some(uri.to_string())
}

/// The servers a link names to route a room through, and the link without them.
#[must_use]
pub fn split_via(href: &str) -> ViaSplit {
    // In matrix: URIs the query precedes the fragment; matrix.to puts it inside.
    let native_uri = href
        .get(..7)
        .is_some_and(|scheme| scheme.eq_ignore_ascii_case("matrix:"));
    let fragment_start = if native_uri { href.find('#') } else { None };
    let (resource, fragment) = href.split_at(fragment_start.unwrap_or(href.len()));
    let after_hash = if native_uri {
        0
    } else {
        resource.find('#').unwrap_or(0)
    };
    let Some(query) = resource
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
    let params = resource.get(query + 1..).unwrap_or_default();
    for (key, value) in form_urlencoded::parse(params.as_bytes()) {
        if key == "via" && !value.is_empty() && !via.iter().any(|seen| *seen == value) {
            via.push(value.into_owned());
        }
    }
    ViaSplit {
        href: format!("{}{fragment}", resource.get(..query).unwrap_or(resource)),
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
    use super::{MatrixLink, mention_uri, parse_join_address, parse_matrix_link, split_via};

    #[test]
    fn a_mention_links_a_matrix_uri_with_at_most_three_routing_servers() {
        let via = |servers: &[&str]| servers.iter().map(|s| (*s).to_owned()).collect::<Vec<_>>();
        assert_eq!(
            mention_uri("@alice:example.org", &via(&["a.example"])).as_deref(),
            Some("matrix:u/alice:example.org")
        );
        assert_eq!(
            mention_uri("#lobby:example.org", &[]).as_deref(),
            Some("matrix:r/lobby:example.org")
        );
        assert_eq!(
            mention_uri(
                "!room:example.org",
                &via(&[
                    "a.example",
                    "bad server",
                    "b.example",
                    "c.example",
                    "d.example"
                ])
            )
            .as_deref(),
            Some("matrix:roomid/room:example.org?via=a.example&via=b.example&via=c.example")
        );
        assert_eq!(mention_uri("not an id", &[]), None);
    }

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

    #[test]
    fn a_matrix_uri_ignores_query_parameters_it_does_not_know() {
        for href in [
            "matrix:u/alice:example.org?org.example.label=a+b",
            "matrix:u/alice:example.org?action=chat&org.example.label=a%26b&user=other",
        ] {
            assert_eq!(
                parse_matrix_link(href),
                Some(MatrixLink::User {
                    user_id: "@alice:example.org".to_owned()
                }),
                "{href}"
            );
        }
    }

    #[test]
    fn a_join_address_keeps_via_out_of_every_room_form() {
        let address =
            |input: &str| parse_join_address(input).map(|found| (found.address, found.via));
        let via = |servers: &[&str]| servers.iter().map(|server| (*server).to_owned()).collect();
        let v12 = "!dIz4NfOB_FDBH4ktZeSqqTfPEcBwm4KnNTnJptVRDko";

        assert_eq!(address(v12), Some((v12.to_owned(), Vec::new())));
        assert_eq!(
            address(&format!("https://matrix.to/#/{v12}?via=one.org")),
            Some((v12.to_owned(), via(&["one.org"])))
        );
        assert_eq!(
            address("https://matrix.to/#/!abc:example.org?via=one.org&via=two.org"),
            Some(("!abc:example.org".to_owned(), via(&["one.org", "two.org"])))
        );
        assert_eq!(
            address("matrix:roomid/abc:example.org?via=one.org"),
            Some(("!abc:example.org".to_owned(), via(&["one.org"])))
        );
        assert_eq!(
            address("https://matrix.to/#/#room:example.org/$event"),
            Some(("#room:example.org".to_owned(), Vec::new()))
        );
        assert_eq!(
            address("matrix:roomid/opaque?via=a.example&via=b.example#reserved?via=wrong.example"),
            Some(("!opaque".to_owned(), via(&["a.example", "b.example"])))
        );
        assert_eq!(address("room:example.org"), None);
        assert_eq!(address("https://example.org/#/!abc:example.org"), None);
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
            (
                "https://matrix.to/#/!6DYBIzUfDoKmqk53wyRqcod2G7LTcR9fEm9XBfaenNI?via=sable.moe",
                room("!6DYBIzUfDoKmqk53wyRqcod2G7LTcR9fEm9XBfaenNI"),
            ),
        ] {
            assert_eq!(parse_matrix_link(href), Some(expected), "{href}");
        }
    }

    #[test]
    fn sable_links_support_the_same_ids_and_routing_as_matrix_to() {
        for fragment in [
            "@alice:example.org",
            "%23lobby%3Aexample.org",
            "!room:example.org/$event?via=a.example&via=b.example",
            "!6DYBIzUfDoKmqk53wyRqcod2G7LTcR9fEm9XBfaenNI?via=sable.moe",
        ] {
            let sable = format!("https://link.sable.moe/#/{fragment}");
            let legacy = format!("https://matrix.to/#/{fragment}");
            let expected = parse_matrix_link(&legacy);
            assert!(expected.is_some(), "{legacy}");
            assert_eq!(parse_matrix_link(&sable), expected, "{sable}");
            assert_eq!(parse_join_address(&sable), parse_join_address(&legacy));
        }
        for href in [
            "https://link.sable.moe/#/",
            "https://link.sable.moe/#/%E0%A4%A",
            "https://link.sable.moe/#/@alice:example.org/extra",
            "https://link.sable.moe.evil/#/@alice:example.org",
            "https://link.sable.moe/other/#/@alice:example.org",
            "https://user@link.sable.moe/#/@alice:example.org",
            "https://link.sable.moe:8443/#/@alice:example.org",
            "http://link.sable.moe/#/@alice:example.org",
        ] {
            assert_eq!(parse_matrix_link(href), None, "{href}");
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
        assert_eq!(plain.via, [] as [String; 0]);
    }

    #[test]
    fn matrix_uris_support_reserved_authorities_and_legacy_types() {
        for (href, expected) in [
            ("MATRIX:u/alice:example.org", user("@alice:example.org")),
            ("matrix:user/alice:example.org", user("@alice:example.org")),
            ("matrix:room/lobby:example.org", room("#lobby:example.org")),
            (
                "matrix://reserved.example/u/alice:example.org",
                user("@alice:example.org"),
            ),
            ("matrix:///r/lobby:example.org", room("#lobby:example.org")),
            ("matrix:roomid/opaque", room("!opaque")),
            (
                "matrix:roomid/a%2Fb:example.org/event/c%2Fd",
                event("!a/b:example.org", "$c/d"),
            ),
            (
                "matrix:u/alice:example.org?action=chat#reserved",
                user("@alice:example.org"),
            ),
        ] {
            assert_eq!(parse_matrix_link(href), Some(expected), "{href}");
        }
    }

    #[test]
    fn malformed_uri_paths_are_not_truncated_into_valid_links() {
        for href in [
            "matrix:////u/alice:example.org",
            "matrix://reserved.example",
            "matrix:u/",
            "matrix:u/%FF",
            "matrix:u/%ZZ",
            "https://matrix.to/#@alice:example.org",
            "https://matrix.to/#/@alice:example.org/extra",
            "https://matrix.to/#/!room:example.org/$event/extra",
            "https://matrix.to/other/#/!room:example.org",
            "https://user@matrix.to/#/!room:example.org",
            "https://matrix.to:8443/#/!room:example.org",
            "http://matrix.to/#/!room:example.org",
        ] {
            assert_eq!(parse_matrix_link(href), None, "{href}");
        }
    }

    #[test]
    fn ruma_accepts_optional_path_slashes() {
        for href in ["matrix:/u/alice:example.org", "matrix:u/alice:example.org/"] {
            assert_eq!(parse_matrix_link(href), Some(user("@alice:example.org")));
        }
    }

    #[test]
    fn ruma_rejects_incomplete_identifiers_and_ignores_unknown_matrix_to_parameters() {
        for href in [
            "matrix:u/alice",
            "matrix:r/lobby",
            "https://matrix.to/#/@alice",
            "https://matrix.to/#/@alice?action=chat",
        ] {
            assert_eq!(parse_matrix_link(href), None, "{href}");
        }
        assert_eq!(
            parse_matrix_link("https://matrix.to/#/!room:example.org?action=join&via=a.example"),
            Some(room("!room:example.org"))
        );
    }

    #[test]
    fn native_uri_query_precedes_the_reserved_fragment() {
        let split = split_via(
            "MATRIX:roomid/opaque?via=a.example&via=b.example#reserved?via=wrong.example",
        );
        assert_eq!(
            split.href,
            "MATRIX:roomid/opaque#reserved?via=wrong.example"
        );
        assert_eq!(split.via, ["a.example", "b.example"]);
        assert_eq!(parse_matrix_link(&split.href), Some(room("!opaque")));
        assert_eq!(
            split_via("matrix:roomid/opaque#reserved?via=wrong.example").via,
            [] as [std::string::String; 0]
        );
    }
}
