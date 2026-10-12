use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::matrix_link::parse_join_address;
use crate::member_look::{FieldEdit, MemberLookEdit, PronounView};
use crate::text::{has_space, is_space, trim, trim_start, words};

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
#[serde(rename_all = "snake_case")]
pub enum MessageKind {
    #[default]
    Text,
    Emote,
    Notice,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
#[serde(rename_all = "snake_case")]
pub enum GestureView {
    Hug,
    Cuddle,
    Wave,
    Poke,
    Headpat,
}

/// What a slash command asks for; targets that need the room or account are left to the host.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
#[serde(tag = "command", rename_all = "snake_case")]
pub enum SlashInvocation {
    BugReport,
    GifSearch {
        query: String,
    },
    Gesture {
        gesture: GestureView,
        target: Option<String>,
    },
    Message {
        body: String,
        msgtype: MessageKind,
        formatted: Option<String>,
        verbatim: bool,
    },
    /// `formatted` is the composer's HTML for the text, still to be coloured.
    Rainbow {
        body: String,
        msgtype: MessageKind,
        formatted: Option<String>,
    },
    Html {
        html: String,
    },
    Join {
        address: String,
        via: Vec<String>,
    },
    Knock {
        address: String,
        via: Vec<String>,
        reason: Option<String>,
    },
    Leave,
    Invite {
        user_id: String,
    },
    Kick {
        targets: Vec<String>,
        reason: Option<String>,
    },
    Ban {
        targets: Vec<String>,
        reason: Option<String>,
    },
    Unban {
        user_id: String,
        reason: Option<String>,
    },
    DisplayName {
        name: String,
    },
    MemberLook {
        look: MemberLookEdit,
        in_parent_space: bool,
    },
    Pronouns {
        pronouns: Vec<PronounView>,
        in_parent_space: bool,
    },
    RoomName {
        name: String,
    },
    Topic {
        topic: String,
    },
    Disinvite {
        user_ids: Vec<String>,
    },
    Ignore {
        user_ids: Vec<String>,
    },
    Unignore {
        user_ids: Vec<String>,
    },
    StartDm {
        user_ids: Vec<String>,
    },
    ConvertToDm {
        user_id: Option<String>,
    },
    ConvertToRoom,
    DiscardSession,
    Acl {
        allow: Vec<String>,
        deny: Vec<String>,
        remove_allow: Vec<String>,
        remove_deny: Vec<String>,
    },
    AddWidget {
        url: String,
        name: String,
    },
    Location {
        #[cfg_attr(feature = "typegen", specta(type = specta_typescript::Number))]
        latitude: f64,
        #[cfg_attr(feature = "typegen", specta(type = specta_typescript::Number))]
        longitude: f64,
    },
    ShareMyLocation,
    AddPersona {
        id: String,
        name: Option<String>,
        avatar: Option<String>,
    },
    RemovePersona {
        id: String,
    },
    UsePersona {
        id: String,
        valid_until: Option<f64>,
    },
    ResetPersona,
    DisableRoomPersonas,
    PersonaProxy {
        id: String,
        prefix: Option<String>,
        suffix: Option<String>,
    },
    RawMessage {
        #[cfg_attr(feature = "typegen", specta(type = std::collections::HashMap<String, specta_typescript::Unknown>))]
        content: Map<String, Value>,
    },
    RawEvent {
        event_type: String,
        #[cfg_attr(feature = "typegen", specta(type = std::collections::HashMap<String, specta_typescript::Unknown>))]
        content: Map<String, Value>,
        state_key: Option<String>,
    },
    RawAccountData {
        event_type: String,
        #[cfg_attr(feature = "typegen", specta(type = std::collections::HashMap<String, specta_typescript::Unknown>))]
        content: Map<String, Value>,
    },
    DeleteAccountDataKey {
        event_type: String,
        key: String,
    },
    BulkRedact {
        targets: Vec<String>,
        #[cfg_attr(feature = "typegen", specta(type = specta_typescript::Number))]
        after_ts: i64,
        event_types: Vec<String>,
        reason: Option<String>,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SlashParse {
    None,
    Literal {
        body: String,
    },
    Unknown {
        name: String,
    },
    Usage {
        name: String,
        developer_only: bool,
    },
    Command {
        name: String,
        developer_only: bool,
        invocation: SlashInvocation,
    },
}

pub const SLASH_COMMANDS: [&str; 51] = [
    "bugreport",
    "gif",
    "hug",
    "cuddle",
    "wave",
    "poke",
    "headpat",
    "me",
    "notice",
    "shrug",
    "tableflip",
    "unflip",
    "join",
    "knock",
    "leave",
    "invite",
    "kick",
    "ban",
    "unban",
    "nick",
    "color",
    "scolor",
    "pronoun",
    "spronoun",
    "roomname",
    "topic",
    "disinvite",
    "ignore",
    "unignore",
    "startdm",
    "converttodm",
    "converttoroom",
    "discardsession",
    "acl",
    "addwidget",
    "html",
    "rainbow",
    "rainbowme",
    "location",
    "sharemylocation",
    "myroomnick",
    "myroomavatar",
    "addpmp",
    "delpmp",
    "usepmp",
    "pmpproxy",
    "rawmsg",
    "raw",
    "rawacc",
    "delacc",
    "delete",
];

const DEVELOPER_COMMANDS: [&str; 4] = ["rawmsg", "raw", "rawacc", "delacc"];

const SHRUG: &str = "¯\\_(ツ)_/¯";
const TABLEFLIP: &str = "(╯°□°）╯︵ ┻━┻";
const UNFLIP: &str = "┬─┬ ノ( ゜-゜ノ)";

/// `^@[^:\s]+:\S+$`
fn is_user_id(token: &str) -> bool {
    token
        .strip_prefix('@')
        .and_then(|rest| rest.split_once(':'))
        .is_some_and(|(local, server)| {
            !local.is_empty() && !server.is_empty() && !has_space(local) && !has_space(server)
        })
}

/// `^@\*:(\S+)$`
fn is_server_wildcard(token: &str) -> bool {
    token
        .strip_prefix("@*:")
        .is_some_and(|server| !server.is_empty() && !has_space(server))
}

fn is_target(token: &str) -> bool {
    is_user_id(token) || is_server_wildcard(token)
}

fn is_mxc(value: &str) -> bool {
    value
        .strip_prefix("mxc://")
        .is_some_and(|rest| !rest.is_empty() && !has_space(rest))
}

fn is_hex_color(value: &str) -> bool {
    value
        .strip_prefix('#')
        .is_some_and(|hex| hex.len() == 6 && hex.bytes().all(|byte| byte.is_ascii_hexdigit()))
}

fn non_empty(text: &str) -> Option<String> {
    (!text.is_empty()).then(|| text.to_owned())
}

fn unique(tokens: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut kept: Vec<String> = Vec::new();
    for token in tokens {
        if !kept.contains(&token) {
            kept.push(token);
        }
    }
    kept
}

fn escape_html(text: &str) -> String {
    let mut escaped = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '&' => escaped.push_str("&amp;"),
            '<' => escaped.push_str("&lt;"),
            '>' => escaped.push_str("&gt;"),
            '"' => escaped.push_str("&quot;"),
            _ => escaped.push(c),
        }
    }
    escaped
}

/// The composer's HTML after its own `/name `, or `None` if it does not start
/// with that command.
fn without_prefix(name: &str, formatted: Option<&str>) -> Option<String> {
    let rest = trim_start(formatted.filter(|html| !html.is_empty())?).strip_prefix('/')?;
    let end = rest
        .find(|c: char| !c.is_ascii_alphanumeric())
        .unwrap_or(rest.len());
    let (command, after) = rest.split_at(end);
    if command.is_empty() || !command.eq_ignore_ascii_case(name) {
        return None;
    }
    if !after.is_empty() && !after.starts_with(is_space) {
        return None;
    }
    Some(trim_start(after).to_owned())
}

/// The first word and what follows it, after a trim.
fn first_and_rest(args: &str) -> (&str, &str) {
    let text = trim(args);
    text.split_once(is_space)
        .map_or((text, ""), |(first, rest)| (first, trim(rest)))
}

fn target_user(args: &str) -> Option<(String, Option<String>)> {
    let (first, rest) = first_and_rest(args);
    is_user_id(first).then(|| (first.to_owned(), non_empty(&words(rest).join(" "))))
}

fn targets(args: &str) -> Option<(Vec<String>, Option<String>)> {
    let all = words(args);
    let end = all.iter().take_while(|token| is_target(token)).count();
    if end == 0 {
        return None;
    }
    let reason = all.get(end..).unwrap_or_default().join(" ");
    let tokens = all.get(..end).unwrap_or_default();
    Some((
        tokens.iter().map(|&token| token.to_owned()).collect(),
        non_empty(&reason),
    ))
}

fn user_ids(args: &str) -> Option<Vec<String>> {
    let found = unique(
        words(args)
            .into_iter()
            .filter(|word| is_user_id(word))
            .map(str::to_owned),
    );
    (!found.is_empty()).then_some(found)
}

const fn is_reset(text: &str) -> bool {
    text.is_empty() || text.eq_ignore_ascii_case("reset") || text.eq_ignore_ascii_case("clear")
}

/// `/color [light|dark] <#rrggbb|reset>`
#[must_use]
pub fn color_update(text: &str) -> Option<MemberLookEdit> {
    let parts = words(text);
    let (theme, value) = match parts.as_slice() {
        [value] => ("both".to_owned(), value.to_lowercase()),
        [theme, value] => (theme.to_lowercase(), value.to_lowercase()),
        _ => return None,
    };
    let edit = if is_reset(&value) {
        FieldEdit::Clear
    } else if is_hex_color(&value) {
        FieldEdit::Set { value }
    } else {
        return None;
    };
    let mut look = MemberLookEdit::default();
    match theme.as_str() {
        "both" => {
            look.color_on_light = edit.clone();
            look.color_on_dark = edit;
        }
        "light" => look.color_on_light = edit,
        "dark" => look.color_on_dark = edit,
        _ => return None,
    }
    Some(look)
}

const fn is_line_terminator(c: char) -> bool {
    matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}')
}

/// `en:she/her, fr:elle` — an entry without a two-letter tag is untagged.
#[must_use]
pub fn pronoun_sets(text: &str) -> Vec<PronounView> {
    if is_reset(text) {
        return Vec::new();
    }
    text.split(',')
        .map(|entry| {
            let entry = trim(entry);
            let tagged = entry.split_once(':').filter(|(language, summary)| {
                language.len() == 2
                    && language.bytes().all(|byte| byte.is_ascii_lowercase())
                    && !summary.is_empty()
                    && !summary.contains(is_line_terminator)
            });
            match tagged {
                Some((language, summary)) => PronounView {
                    language: Some(language.to_owned()),
                    summary: trim(summary).to_owned(),
                },
                None => PronounView {
                    language: None,
                    summary: entry.to_owned(),
                },
            }
        })
        .collect()
}

/// `-flag value value -other value`; a repeated flag starts over.
fn flag_values(args: &str) -> Vec<(String, Vec<String>)> {
    let mut values: Vec<(String, Vec<String>)> = Vec::new();
    let mut flag: Option<String> = None;
    for token in words(args) {
        if let Some(name) = token.strip_prefix('-').filter(|name| !name.is_empty()) {
            values.retain(|(held, _)| held != name);
            values.push((name.to_owned(), Vec::new()));
            flag = Some(name.to_owned());
        } else if let Some(flag) = &flag
            && let Some((_, held)) = values.iter_mut().find(|(held, _)| held == flag)
        {
            held.push(token.to_owned());
        }
    }
    values
}

fn flag(values: &[(String, Vec<String>)], name: &str) -> Option<Vec<String>> {
    values
        .iter()
        .find(|(held, _)| held == name)
        .map(|(_, values)| values.clone())
}

fn json_object(text: &str) -> Option<Map<String, Value>> {
    serde_json::from_str(text).ok()
}

/// `<type> <json> [-s <state key>]`
fn raw_event(args: &str) -> Option<SlashInvocation> {
    let trimmed = trim(args);
    let (payload, state_key) = trimmed
        .rsplit_once(is_space)
        .and_then(|(before, key)| {
            let before = before.trim_end_matches(is_space).strip_suffix("-s")?;
            before
                .ends_with(is_space)
                .then(|| (before.trim_end_matches(is_space), Some(key.to_owned())))
        })
        .unwrap_or((trimmed, None));
    let (event_type, content) = payload.split_once(is_space)?;
    Some(SlashInvocation::RawEvent {
        event_type: event_type.to_owned(),
        content: json_object(trim(content))?,
        state_key,
    })
}

const fn is_word_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

/// `<targets> -past <n><d|h|m|s> [-t <type>...] [-r <reason>]`
#[expect(
    clippy::cast_possible_truncation,
    reason = "after_ts is checked to be a safe integer first"
)]
fn bulk_redact(args: &str, now_ms: f64) -> Option<SlashInvocation> {
    let flags_at = args.char_indices().find_map(|(at, c)| {
        let after = args.get(at + c.len_utf8()..)?;
        let mut rest = after.chars();
        (is_space(c) && rest.next() == Some('-') && rest.next().is_some_and(is_word_char))
            .then_some(at)
    });
    let (target_text, flags) = flags_at.map_or_else(
        || (args, Vec::new()),
        |at| {
            (
                args.get(..at).unwrap_or_default(),
                flag_values(args.get(at..).unwrap_or_default()),
            )
        },
    );
    let past = flag(&flags, "past")?;
    let past = past.first()?;
    let unit = past.chars().last()?;
    let unit_ms = match unit {
        'd' => 86_400_000.0,
        'h' => 3_600_000.0,
        'm' => 60_000.0,
        's' => 1000.0,
        _ => return None,
    };
    let amount = past.get(..past.len() - 1)?;
    let (whole, fraction) = amount.split_once('.').unwrap_or((amount, "0"));
    if whole.is_empty()
        || fraction.is_empty()
        || !whole.bytes().all(|byte| byte.is_ascii_digit())
        || !fraction.bytes().all(|byte| byte.is_ascii_digit())
    {
        return None;
    }
    let after_ts = now_ms - amount.parse::<f64>().ok()? * unit_ms;
    if after_ts.fract() != 0.0 || after_ts.abs() > 9_007_199_254_740_991.0 {
        return None;
    }
    let targets: Vec<String> = words(target_text)
        .into_iter()
        .filter(|token| is_target(token))
        .map(str::to_owned)
        .collect();
    if targets.is_empty() {
        return None;
    }
    Some(SlashInvocation::BulkRedact {
        targets,
        after_ts: after_ts as i64,
        event_types: flag(&flags, "t").unwrap_or_default(),
        reason: flag(&flags, "r").and_then(|reason| non_empty(&reason.join(" "))),
    })
}

fn finite_number(value: &str) -> Option<f64> {
    value.parse::<f64>().ok().filter(|value| value.is_finite())
}

fn gesture(gesture: GestureView, args: &str) -> Option<SlashInvocation> {
    let target = trim(args);
    if !target.is_empty() && !is_user_id(target) {
        return None;
    }
    Some(SlashInvocation::Gesture {
        gesture,
        target: non_empty(target),
    })
}

fn speech(
    name: &str,
    msgtype: MessageKind,
    args: &str,
    formatted: Option<&str>,
) -> Option<SlashInvocation> {
    let text = trim(args);
    (!text.is_empty()).then(|| SlashInvocation::Message {
        body: text.to_owned(),
        msgtype,
        formatted: without_prefix(name, formatted),
        verbatim: true,
    })
}

fn decorated(name: &str, suffix: &str, args: &str, formatted: Option<&str>) -> SlashInvocation {
    let text = trim(args);
    if text.is_empty() {
        return SlashInvocation::Message {
            body: suffix.to_owned(),
            msgtype: MessageKind::Text,
            formatted: None,
            verbatim: false,
        };
    }
    SlashInvocation::Message {
        body: format!("{text} {suffix}"),
        msgtype: MessageKind::Text,
        formatted: without_prefix(name, formatted)
            .map(|html| format!("{html} {}", escape_html(suffix))),
        verbatim: true,
    }
}

fn rainbow(
    name: &str,
    msgtype: MessageKind,
    args: &str,
    formatted: Option<&str>,
) -> Option<SlashInvocation> {
    let text = trim(args);
    (!text.is_empty()).then(|| SlashInvocation::Rainbow {
        body: text.to_owned(),
        msgtype,
        formatted: without_prefix(name, formatted),
    })
}

fn no_arguments(args: &str, invocation: SlashInvocation) -> Option<SlashInvocation> {
    trim(args).is_empty().then_some(invocation)
}

fn text_argument(args: &str) -> Option<String> {
    non_empty(trim(args))
}

fn add_persona(args: &str) -> Option<SlashInvocation> {
    let parts = words(args);
    let (&id, pairs) = parts.split_first()?;
    if id == "index" {
        return None;
    }
    let mut name = None;
    let mut avatar = None;
    for pair in pairs {
        let Some((key, value)) = pair.split_once('=').filter(|(key, _)| !key.is_empty()) else {
            continue;
        };
        match key {
            "name" => name = Some(value.to_owned()),
            "avatar" => avatar = Some(value.to_owned()),
            _ => {}
        }
    }
    Some(SlashInvocation::AddPersona {
        id: id.to_owned(),
        name,
        avatar,
    })
}

fn use_persona(args: &str) -> Option<SlashInvocation> {
    match words(args).as_slice() {
        ["reset"] | ["reset", _] => Some(SlashInvocation::ResetPersona),
        ["off"] | ["off", _] => Some(SlashInvocation::DisableRoomPersonas),
        [id] => Some(SlashInvocation::UsePersona {
            id: (*id).to_owned(),
            valid_until: None,
        }),
        [id, until] => Some(SlashInvocation::UsePersona {
            id: (*id).to_owned(),
            valid_until: Some(finite_number(until)?),
        }),
        _ => None,
    }
}

fn persona_proxy(args: &str) -> Option<SlashInvocation> {
    let [id, proxy] = words(args).try_into().ok()?;
    let (prefix, suffix) = proxy.split_once("text")?;
    Some(SlashInvocation::PersonaProxy {
        id: id.to_owned(),
        prefix: non_empty(prefix),
        suffix: non_empty(suffix),
    })
}

fn acl(args: &str) -> Option<SlashInvocation> {
    let flags = flag_values(args);
    let allow = flag(&flags, "a").unwrap_or_default();
    let deny = flag(&flags, "d").unwrap_or_default();
    let remove_allow = unique(flag(&flags, "ra").unwrap_or_default());
    let remove_deny = unique(flag(&flags, "rd").unwrap_or_default());
    if allow.is_empty() && deny.is_empty() && remove_allow.is_empty() && remove_deny.is_empty() {
        return None;
    }
    Some(SlashInvocation::Acl {
        allow,
        deny,
        remove_allow,
        remove_deny,
    })
}

fn address(args: &str, knock: bool) -> Option<SlashInvocation> {
    let (first, rest) = first_and_rest(args);
    let target = parse_join_address(first)?;
    Some(if knock {
        SlashInvocation::Knock {
            address: target.address,
            via: target.via,
            reason: non_empty(&words(rest).join(" ")),
        }
    } else {
        SlashInvocation::Join {
            address: target.address,
            via: target.via,
        }
    })
}

fn location(args: &str) -> Option<SlashInvocation> {
    let [latitude, longitude] = words(args).try_into().ok()?;
    let latitude = finite_number(latitude).filter(|value| (-90.0..=90.0).contains(value))?;
    let longitude = finite_number(longitude).filter(|value| (-180.0..=180.0).contains(value))?;
    Some(SlashInvocation::Location {
        latitude,
        longitude,
    })
}

fn add_widget(args: &str) -> Option<SlashInvocation> {
    let parts = words(args);
    let (&url, name) = parts.split_first()?;
    Some(SlashInvocation::AddWidget {
        url: url.to_owned(),
        name: non_empty(&name.join(" ")).unwrap_or_else(|| "Widget".to_owned()),
    })
}

fn member_profile(name: &str, args: &str) -> Option<SlashInvocation> {
    let value = text_argument(args)?;
    let look = if name == "myroomavatar" {
        if !is_mxc(&value) {
            return None;
        }
        MemberLookEdit {
            avatar_url: FieldEdit::Set { value },
            ..MemberLookEdit::default()
        }
    } else {
        MemberLookEdit {
            display_name: FieldEdit::Set { value },
            ..MemberLookEdit::default()
        }
    };
    Some(SlashInvocation::MemberLook {
        look,
        in_parent_space: false,
    })
}

fn raw_account_data(args: &str) -> Option<SlashInvocation> {
    let (event_type, content) = trim(args).split_once(is_space)?;
    Some(SlashInvocation::RawAccountData {
        event_type: event_type.to_owned(),
        content: json_object(trim(content))?,
    })
}

fn delete_account_data_key(args: &str) -> Option<SlashInvocation> {
    let [event_type, key] = words(args).try_into().ok()?;
    Some(SlashInvocation::DeleteAccountDataKey {
        event_type: event_type.to_owned(),
        key: key.to_owned(),
    })
}

fn invocation(
    name: &str,
    args: &str,
    formatted: Option<&str>,
    now_ms: f64,
) -> Option<SlashInvocation> {
    use SlashInvocation as I;
    match name {
        "bugreport" => no_arguments(args, I::BugReport),
        "gif" => Some(I::GifSearch {
            query: trim(args).to_owned(),
        }),
        "hug" => gesture(GestureView::Hug, args),
        "cuddle" => gesture(GestureView::Cuddle, args),
        "wave" => gesture(GestureView::Wave, args),
        "poke" => gesture(GestureView::Poke, args),
        "headpat" => gesture(GestureView::Headpat, args),
        "me" => speech(name, MessageKind::Emote, args, formatted),
        "notice" => speech(name, MessageKind::Notice, args, formatted),
        "shrug" => Some(decorated(name, SHRUG, args, formatted)),
        "tableflip" => Some(decorated(name, TABLEFLIP, args, formatted)),
        "unflip" => Some(decorated(name, UNFLIP, args, formatted)),
        "join" => address(args, false),
        "knock" => address(args, true),
        "leave" => no_arguments(args, I::Leave),
        "invite" => match target_user(args)? {
            (user_id, None) => Some(I::Invite { user_id }),
            (_, Some(_)) => None,
        },
        "kick" => targets(args).map(|(targets, reason)| I::Kick { targets, reason }),
        "ban" => targets(args).map(|(targets, reason)| I::Ban { targets, reason }),
        "unban" => target_user(args).map(|(user_id, reason)| I::Unban { user_id, reason }),
        "nick" => text_argument(args).map(|name| I::DisplayName { name }),
        "color" | "scolor" => color_update(trim(args)).map(|look| I::MemberLook {
            look,
            in_parent_space: name == "scolor",
        }),
        "pronoun" | "spronoun" => Some(I::Pronouns {
            pronouns: pronoun_sets(trim(args)),
            in_parent_space: name == "spronoun",
        }),
        "roomname" => text_argument(args).map(|name| I::RoomName { name }),
        "topic" => text_argument(args).map(|topic| I::Topic { topic }),
        "disinvite" => user_ids(args).map(|user_ids| I::Disinvite { user_ids }),
        "ignore" => user_ids(args).map(|user_ids| I::Ignore { user_ids }),
        "unignore" => user_ids(args).map(|user_ids| I::Unignore { user_ids }),
        "startdm" => user_ids(args).map(|user_ids| I::StartDm { user_ids }),
        "converttodm" => match words(args).as_slice() {
            [] => Some(I::ConvertToDm { user_id: None }),
            [user_id] if is_user_id(user_id) => Some(I::ConvertToDm {
                user_id: Some((*user_id).to_owned()),
            }),
            _ => None,
        },
        "converttoroom" => no_arguments(args, I::ConvertToRoom),
        "discardsession" => no_arguments(args, I::DiscardSession),
        "acl" => acl(args),
        "addwidget" => add_widget(args),
        "html" => text_argument(args).map(|html| I::Html { html }),
        "rainbow" => rainbow(name, MessageKind::Text, args, formatted),
        "rainbowme" => rainbow(name, MessageKind::Emote, args, formatted),
        "location" => location(args),
        "sharemylocation" => no_arguments(args, I::ShareMyLocation),
        "myroomnick" | "myroomavatar" => member_profile(name, args),
        "addpmp" => add_persona(args),
        "delpmp" => text_argument(args)
            .filter(|id| id != "index")
            .map(|id| I::RemovePersona { id }),
        "usepmp" => use_persona(args),
        "pmpproxy" => persona_proxy(args),
        "rawmsg" => json_object(trim(args)).map(|content| I::RawMessage { content }),
        "raw" => raw_event(args),
        "rawacc" => raw_account_data(args),
        "delacc" => delete_account_data_key(args),
        "delete" => bulk_redact(args, now_ms),
        _ => None,
    }
}

/// `formatted` is the composer's HTML for the whole line, which commands that
/// send a message keep; `now_ms` anchors `/delete -past`.
#[must_use]
pub fn parse_slash(body: &str, formatted: Option<&str>, now_ms: f64) -> SlashParse {
    let Some(command) = body.strip_prefix('/') else {
        return SlashParse::None;
    };
    if command.starts_with('/') {
        return SlashParse::Literal {
            body: command.to_owned(),
        };
    }
    let (name, args) = command.split_once(is_space).unwrap_or((command, ""));
    let name = name.to_lowercase();
    if !SLASH_COMMANDS.contains(&name.as_str()) {
        return SlashParse::Unknown { name };
    }
    let developer_only = DEVELOPER_COMMANDS.contains(&name.as_str());
    match invocation(&name, args, formatted, now_ms) {
        Some(invocation) => SlashParse::Command {
            name,
            developer_only,
            invocation,
        },
        None => SlashParse::Usage {
            name,
            developer_only,
        },
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    const NOW: f64 = 1_000_000_000.0;

    fn parse(body: &str) -> SlashParse {
        parse_slash(body, None, NOW)
    }

    fn invoked_with(body: &str, formatted: Option<&str>) -> SlashInvocation {
        match parse_slash(body, formatted, NOW) {
            SlashParse::Command { invocation, .. } => invocation,
            other => panic!("{body} parsed as {other:?}"),
        }
    }

    fn invoked(body: &str) -> SlashInvocation {
        invoked_with(body, None)
    }

    fn is_usage(body: &str) -> bool {
        matches!(parse(body), SlashParse::Usage { .. })
    }

    #[test]
    fn plain_text_escapes_and_unknown_names() {
        assert_eq!(parse("hello"), SlashParse::None);
        assert_eq!(parse("and/or"), SlashParse::None);
        assert_eq!(
            parse("//me is literal"),
            SlashParse::Literal {
                body: "/me is literal".to_owned()
            }
        );
        assert_eq!(
            parse("/Nope"),
            SlashParse::Unknown {
                name: "nope".to_owned()
            }
        );
    }

    #[test]
    fn every_listed_command_is_understood() {
        for name in SLASH_COMMANDS {
            assert!(
                !matches!(parse(&format!("/{name}")), SlashParse::Unknown { .. }),
                "/{name}"
            );
        }
    }

    #[test]
    fn the_name_ignores_case_and_speech_keeps_the_composer_html() {
        assert_eq!(
            parse_slash("/ME waves", Some("  /me <b>waves</b>"), NOW),
            SlashParse::Command {
                name: "me".to_owned(),
                developer_only: false,
                invocation: SlashInvocation::Message {
                    body: "waves".to_owned(),
                    msgtype: MessageKind::Emote,
                    formatted: Some("<b>waves</b>".to_owned()),
                    verbatim: true,
                },
            }
        );
        assert!(matches!(
            invoked_with("/me waves", Some("/meh waves")),
            SlashInvocation::Message {
                formatted: None,
                ..
            }
        ));
    }

    #[test]
    fn a_decoration_is_escaped_into_the_html() {
        assert_eq!(
            invoked_with("/shrug ok", Some("/shrug <i>ok</i>")),
            SlashInvocation::Message {
                body: format!("ok {SHRUG}"),
                msgtype: MessageKind::Text,
                formatted: Some(format!("<i>ok</i> {SHRUG}")),
                verbatim: true,
            }
        );
        assert_eq!(
            escape_html("<a href=\"x\">&</a>"),
            "&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;"
        );
        assert_eq!(
            invoked("/tableflip"),
            SlashInvocation::Message {
                body: TABLEFLIP.to_owned(),
                msgtype: MessageKind::Text,
                formatted: None,
                verbatim: false,
            }
        );
    }

    #[test]
    fn colors_take_an_optional_theme_and_a_reset() {
        let set = FieldEdit::Set {
            value: "#aabbcc".to_owned(),
        };
        assert_eq!(
            color_update("#AABBCC"),
            Some(MemberLookEdit {
                color_on_light: set.clone(),
                color_on_dark: set,
                ..MemberLookEdit::default()
            })
        );
        assert_eq!(
            color_update("Dark reset"),
            Some(MemberLookEdit {
                color_on_dark: FieldEdit::Clear,
                ..MemberLookEdit::default()
            })
        );
        assert_eq!(color_update("dusk #aabbcc"), None);
        assert_eq!(color_update("#abc"), None);
        assert_eq!(color_update("light #aabbcc extra"), None);
    }

    #[test]
    fn pronouns_are_tagged_only_by_a_two_letter_language() {
        assert_eq!(
            pronoun_sets(" en:she/her , they/them,fra:il "),
            vec![
                PronounView {
                    language: Some("en".to_owned()),
                    summary: "she/her".to_owned()
                },
                PronounView {
                    language: None,
                    summary: "they/them".to_owned()
                },
                PronounView {
                    language: None,
                    summary: "fra:il".to_owned()
                },
            ]
        );
        assert!(pronoun_sets("Clear").is_empty());
    }

    #[test]
    fn moderation_reads_targets_then_a_reason() {
        assert_eq!(
            invoked("/kick @a:x @*:spam.example  being rude "),
            SlashInvocation::Kick {
                targets: vec!["@a:x".to_owned(), "@*:spam.example".to_owned()],
                reason: Some("being rude".to_owned()),
            }
        );
        assert!(is_usage("/kick being rude"));
        assert!(is_usage("/invite @a:x please"));
        assert_eq!(
            invoked("/ignore @a:x nobody @a:x @b:y"),
            SlashInvocation::Ignore {
                user_ids: vec!["@a:x".to_owned(), "@b:y".to_owned()]
            }
        );
        assert!(is_usage("/hug ada"));
    }

    #[test]
    fn raw_events_take_an_optional_state_key() {
        assert_eq!(
            invoked("/raw m.custom {\"a\": 1}  -s  key"),
            SlashInvocation::RawEvent {
                event_type: "m.custom".to_owned(),
                content: json!({"a": 1}).as_object().cloned().unwrap_or_default(),
                state_key: Some("key".to_owned()),
            }
        );
        assert!(is_usage("/raw m.custom {}-s key"));
        assert!(is_usage("/raw m.custom [1]"));
        assert_eq!(
            parse("/rawmsg nope"),
            SlashParse::Usage {
                name: "rawmsg".to_owned(),
                developer_only: true
            }
        );
    }

    #[test]
    fn delete_reaches_back_from_now() {
        assert_eq!(
            invoked("/delete @a:x -past 1.5h -t m.room.message m.sticker -r spam wave"),
            SlashInvocation::BulkRedact {
                targets: vec!["@a:x".to_owned()],
                after_ts: 1_000_000_000 - 5_400_000,
                event_types: vec!["m.room.message".to_owned(), "m.sticker".to_owned()],
                reason: Some("spam wave".to_owned()),
            }
        );
        assert!(is_usage("/delete @a:x"));
        assert!(is_usage("/delete @a:x -past 2w"));
        assert!(is_usage("/delete -past 2h"));
        assert!(is_usage("/delete @a:x -past 0.0001s"));
    }

    #[test]
    fn acl_flags_collect_until_the_next_flag() {
        assert_eq!(
            invoked("/acl -a one two -ra x x -a three"),
            SlashInvocation::Acl {
                allow: vec!["three".to_owned()],
                deny: Vec::new(),
                remove_allow: vec!["x".to_owned()],
                remove_deny: Vec::new(),
            }
        );
        assert!(is_usage("/acl"));
    }

    #[test]
    fn personas_and_locations() {
        assert_eq!(
            invoked("/addpmp ada name=Ada avatar=mxc://x/y name=Lovelace"),
            SlashInvocation::AddPersona {
                id: "ada".to_owned(),
                name: Some("Lovelace".to_owned()),
                avatar: Some("mxc://x/y".to_owned()),
            }
        );
        assert!(is_usage("/addpmp index"));
        assert_eq!(invoked("/usepmp reset 5"), SlashInvocation::ResetPersona);
        assert!(is_usage("/usepmp ada soon"));
        assert_eq!(
            invoked("/pmpproxy ada [text]"),
            SlashInvocation::PersonaProxy {
                id: "ada".to_owned(),
                prefix: Some("[".to_owned()),
                suffix: Some("]".to_owned()),
            }
        );
        assert!(is_usage("/location 91 0"));
        assert_eq!(
            invoked("/location 48.85 2.35"),
            SlashInvocation::Location {
                latitude: 48.85,
                longitude: 2.35
            }
        );
        assert!(is_usage("/myroomavatar https://x/y"));
    }
}
