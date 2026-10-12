//! MSC4391 bot command descriptions, and the form that fills one in.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

use crate::matrix_link::{MatrixLink, parse_matrix_link, split_via};
use crate::text::{has_space, is_space, trim, trim_start, words};

const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
#[serde(rename_all = "snake_case")]
pub enum PrimitiveType {
    String,
    Integer,
    Boolean,
    UserId,
    ServerName,
    RoomAlias,
    RoomId,
    EventId,
}

impl PrimitiveType {
    fn parse(name: &str) -> Option<Self> {
        Some(match name {
            "string" => Self::String,
            "integer" => Self::Integer,
            "boolean" => Self::Boolean,
            "user_id" => Self::UserId,
            "server_name" => Self::ServerName,
            "room_alias" => Self::RoomAlias,
            "room_id" => Self::RoomId,
            "event_id" => Self::EventId,
            _ => return None,
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
#[serde(rename_all = "snake_case")]
pub enum RoomReferenceKind {
    RoomId,
    EventId,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
pub struct RoomReference {
    #[serde(rename = "type")]
    pub kind: RoomReferenceKind,
    pub id: String,
    pub via: Option<Vec<String>>,
    pub event_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
#[serde(untagged)]
pub enum LiteralValue {
    Boolean(bool),
    Integer(#[cfg_attr(feature = "typegen", specta(type = specta_typescript::Number))] i64),
    Text(String),
    Room(RoomReference),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
#[serde(untagged)]
pub enum ArgumentValue {
    Many(Vec<LiteralValue>),
    One(LiteralValue),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
#[serde(tag = "schema_type", rename_all = "snake_case")]
pub enum ScalarSchema {
    Primitive {
        #[serde(rename = "type")]
        primitive: PrimitiveType,
    },
    Literal {
        value: LiteralValue,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
#[serde(tag = "schema_type", rename_all = "snake_case")]
pub enum ItemSchema {
    Primitive {
        #[serde(rename = "type")]
        primitive: PrimitiveType,
    },
    Literal {
        value: LiteralValue,
    },
    Union {
        variants: Vec<ScalarSchema>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
#[serde(tag = "schema_type", rename_all = "snake_case")]
pub enum ParameterSchema {
    Primitive {
        #[serde(rename = "type")]
        primitive: PrimitiveType,
    },
    Literal {
        value: LiteralValue,
    },
    Union {
        variants: Vec<ScalarSchema>,
    },
    Array {
        items: ItemSchema,
    },
}

impl ParameterSchema {
    fn item(&self) -> ItemSchema {
        match self {
            Self::Primitive { primitive } => ItemSchema::Primitive {
                primitive: *primitive,
            },
            Self::Literal { value } => ItemSchema::Literal {
                value: value.clone(),
            },
            Self::Union { variants } => ItemSchema::Union {
                variants: variants.clone(),
            },
            Self::Array { items } => items.clone(),
        }
    }

    const fn is_boolean(&self) -> bool {
        matches!(
            self,
            Self::Primitive {
                primitive: PrimitiveType::Boolean
            }
        )
    }

    const fn is_array(&self) -> bool {
        matches!(self, Self::Array { .. })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
pub struct BotCommandParameter {
    pub key: String,
    pub schema: ParameterSchema,
    pub description: Option<String>,
    pub optional: bool,
    pub default_value: Option<ArgumentValue>,
    /// `moe.sable.flag`: the option name the bot's own parser expects.
    pub flag: Option<String>,
}

/// An `org.matrix.msc4391.command_description` and who it came from.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
pub struct BotCommandDescription {
    pub sender: String,
    pub sender_name: Option<String>,
    pub sender_avatar: Option<String>,
    #[cfg_attr(feature = "typegen", specta(type = specta_typescript::Unknown))]
    pub content: Value,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
pub struct BotCommand {
    pub sender: String,
    pub sender_name: Option<String>,
    pub sender_avatar: Option<String>,
    pub command: String,
    pub aliases: Vec<String>,
    pub description: Option<String>,
    pub parameters: Vec<BotCommandParameter>,
    /// Takes the rest of the line, spaces and all.
    pub tail_parameter: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
#[serde(untagged)]
pub enum ArgumentDraft {
    Flag(bool),
    Words(Vec<String>),
    Text(String),
}

pub type ArgumentDrafts = BTreeMap<String, ArgumentDraft>;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
pub struct BotCommandMatch {
    pub command: BotCommand,
    pub args: String,
    pub raw_args: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
#[serde(rename_all = "snake_case")]
pub enum ArgumentError {
    Required,
    Invalid,
}

/// The `org.matrix.msc4391.command` block; an argument leaves out whatever it
/// does not set, as bots compare these objects field by field.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
pub struct BotCommandInvocation {
    pub command: String,
    #[cfg_attr(feature = "typegen", specta(type = std::collections::BTreeMap<String, specta_typescript::Unknown>))]
    pub arguments: Map<String, Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum InvocationResult {
    Built {
        invocation: BotCommandInvocation,
        body: String,
    },
    Invalid {
        errors: BTreeMap<String, ArgumentError>,
    },
}

fn text_body(value: Option<&Value>) -> Option<String> {
    value?
        .get("m.text")?
        .as_array()?
        .iter()
        .filter_map(|entry| entry.get("body")?.as_str())
        .find(|body| !body.is_empty())
        .map(ToOwned::to_owned)
}

fn room_reference(value: &Value) -> Option<RoomReference> {
    let kind = match value.get("type")?.as_str()? {
        "room_id" => RoomReferenceKind::RoomId,
        "event_id" => RoomReferenceKind::EventId,
        _ => return None,
    };
    Some(RoomReference {
        kind,
        id: value.get("id")?.as_str()?.to_owned(),
        via: value.get("via").and_then(Value::as_array).map(|via| {
            via.iter()
                .filter_map(Value::as_str)
                .map(ToOwned::to_owned)
                .collect()
        }),
        event_id: value
            .get("event_id")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned),
    })
}

fn literal_value(value: &Value) -> Option<LiteralValue> {
    match value {
        Value::String(text) => Some(LiteralValue::Text(text.clone())),
        Value::Bool(flag) => Some(LiteralValue::Boolean(*flag)),
        Value::Number(number) => number
            .as_i64()
            .filter(|integer| (-MAX_SAFE_INTEGER..=MAX_SAFE_INTEGER).contains(integer))
            .map(LiteralValue::Integer),
        Value::Object(_) => room_reference(value).map(LiteralValue::Room),
        _ => None,
    }
}

fn scalar_schema(value: &Value) -> Option<ScalarSchema> {
    match value.get("schema_type")?.as_str()? {
        "primitive" => Some(ScalarSchema::Primitive {
            primitive: PrimitiveType::parse(value.get("type")?.as_str()?)?,
        }),
        "literal" => Some(ScalarSchema::Literal {
            value: literal_value(value.get("value")?)?,
        }),
        _ => None,
    }
}

fn item_schema(value: &Value) -> Option<ItemSchema> {
    if value.get("schema_type").and_then(Value::as_str) != Some("union") {
        return scalar_schema(value).map(|scalar| match scalar {
            ScalarSchema::Primitive { primitive } => ItemSchema::Primitive { primitive },
            ScalarSchema::Literal { value } => ItemSchema::Literal { value },
        });
    }
    let variants = value
        .get("variants")?
        .as_array()?
        .iter()
        .map(scalar_schema)
        .collect::<Option<Vec<_>>>()?;
    (!variants.is_empty()).then_some(ItemSchema::Union { variants })
}

fn parameter_schema(value: &Value) -> Option<ParameterSchema> {
    if value.get("schema_type").and_then(Value::as_str) == Some("array") {
        return Some(ParameterSchema::Array {
            items: item_schema(value.get("items")?)?,
        });
    }
    item_schema(value).map(|item| match item {
        ItemSchema::Primitive { primitive } => ParameterSchema::Primitive { primitive },
        ItemSchema::Literal { value } => ParameterSchema::Literal { value },
        ItemSchema::Union { variants } => ParameterSchema::Union { variants },
    })
}

fn argument_value(value: &Value) -> Option<ArgumentValue> {
    match value {
        Value::Array(items) => items
            .iter()
            .map(literal_value)
            .collect::<Option<Vec<_>>>()
            .map(ArgumentValue::Many),
        other => literal_value(other).map(ArgumentValue::One),
    }
}

fn parameter(value: &Value) -> Option<BotCommandParameter> {
    let key = value.get("key")?.as_str().filter(|key| !key.is_empty())?;
    Some(BotCommandParameter {
        key: key.to_owned(),
        schema: parameter_schema(value.get("schema")?)?,
        description: text_body(value.get("description")),
        optional: value.get("optional").and_then(Value::as_bool) == Some(true),
        default_value: value.get("fi.mau.default_value").and_then(argument_value),
        flag: value
            .get("moe.sable.flag")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned),
    })
}

/// `None` for a description that names no command, or whose parameters do not
/// all parse or repeat a key.
#[must_use]
pub fn parse_bot_command(
    sender: &str,
    sender_name: Option<&str>,
    sender_avatar: Option<&str>,
    content: &Value,
) -> Option<BotCommand> {
    let command = trim(content.get("command")?.as_str()?);
    if command.is_empty() {
        return None;
    }
    let parameters = content
        .get("parameters")
        .and_then(Value::as_array)
        .map_or(Some(Vec::new()), |declared| {
            declared.iter().map(parameter).collect::<Option<Vec<_>>>()
        })?;
    let mut keys: Vec<&str> = parameters.iter().map(|entry| entry.key.as_str()).collect();
    keys.sort_unstable();
    keys.dedup();
    if keys.len() != parameters.len() {
        return None;
    }
    let tail = content
        .get("fi.mau.tail_parameter")
        .and_then(Value::as_str)
        .filter(|tail| keys.contains(tail))
        .map(ToOwned::to_owned);
    Some(BotCommand {
        sender: sender.to_owned(),
        sender_name: sender_name.map(ToOwned::to_owned),
        sender_avatar: sender_avatar.map(ToOwned::to_owned),
        command: command.to_owned(),
        aliases: content
            .get("aliases")
            .and_then(Value::as_array)
            .map(|aliases| {
                aliases
                    .iter()
                    .filter_map(Value::as_str)
                    .filter(|alias| !alias.is_empty())
                    .map(ToOwned::to_owned)
                    .collect()
            })
            .unwrap_or_default(),
        description: text_body(content.get("description")),
        parameters,
        tail_parameter: tail,
    })
}

#[must_use]
pub fn parse_description(description: &BotCommandDescription) -> Option<BotCommand> {
    parse_bot_command(
        &description.sender,
        description.sender_name.as_deref(),
        description.sender_avatar.as_deref(),
        &description.content,
    )
}

/// A later description for the same sender and command replaces the earlier
/// one in its place.
#[must_use]
pub fn parse_descriptions(descriptions: &[BotCommandDescription]) -> Vec<BotCommand> {
    let mut kept: Vec<BotCommand> = Vec::new();
    for command in descriptions.iter().filter_map(parse_description) {
        match kept
            .iter_mut()
            .find(|known| known.sender == command.sender && known.command == command.command)
        {
            Some(known) => *known = command,
            None => kept.push(command),
        }
    }
    kept
}

fn names(command: &BotCommand) -> impl Iterator<Item = &str> {
    std::iter::once(command.command.as_str()).chain(command.aliases.iter().map(String::as_str))
}

fn strip_prefix_ignoring_case<'a>(line: &'a str, prefix: &str) -> Option<&'a str> {
    let mut rest = line;
    for expected in prefix.chars() {
        let mut chars = rest.chars();
        let found = chars.next()?;
        if !found.to_lowercase().eq(expected.to_lowercase()) {
            return None;
        }
        rest = chars.as_str();
    }
    Some(rest)
}

/// The longest command name the line starts with, ending at a space or the end.
#[must_use]
pub fn match_bot_command(line: &str, commands: &[BotCommand]) -> Option<BotCommandMatch> {
    let mut best: Option<(&BotCommand, usize, &str)> = None;
    for command in commands {
        for name in names(command) {
            let Some(rest) = strip_prefix_ignoring_case(line, name) else {
                continue;
            };
            if rest.chars().next().is_some_and(|next| !is_space(next)) {
                continue;
            }
            let length = name.chars().count();
            if best.is_some_and(|(_, known, _)| known >= length) {
                continue;
            }
            best = Some((command, length, rest));
        }
    }
    let (command, _, raw_args) = best?;
    Some(BotCommandMatch {
        command: command.clone(),
        args: trim(raw_args).to_owned(),
        raw_args: raw_args.to_owned(),
    })
}

fn is_identifier(text: &str, sigil: char, server_required: bool) -> bool {
    let Some(rest) = text.strip_prefix(sigil) else {
        return false;
    };
    let (local, server) = match rest.split_once(':') {
        Some((local, server)) => (local, Some(server)),
        None => (rest, None),
    };
    let local_ok = !local.is_empty() && !has_space(local);
    let server_ok = server.map_or(!server_required, |server| {
        !server.is_empty() && !has_space(server)
    });
    local_ok && server_ok
}

fn is_port(port: &str) -> bool {
    port.is_empty()
        || port.strip_prefix(':').is_some_and(|number| {
            (1..=5).contains(&number.len()) && number.chars().all(|c| c.is_ascii_digit())
        })
}

/// A hostname, an IPv4 address or a bracketed IPv6 one, and an optional port.
fn is_server_name(text: &str) -> bool {
    if let Some(rest) = text.strip_prefix('[') {
        return rest.split_once(']').is_some_and(|(address, port)| {
            !address.is_empty()
                && address
                    .chars()
                    .all(|c| c.is_ascii_hexdigit() || c == ':' || c == '.')
                && is_port(port)
        });
    }
    let (host, port) = text.split_at(text.find(':').unwrap_or(text.len()));
    !host.is_empty()
        && host
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-')
        && is_port(port)
}

fn integer(text: &str) -> Option<i64> {
    let digits = text.strip_prefix(['-', '+']).unwrap_or(text);
    if digits.is_empty() || !digits.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    text.parse::<i64>()
        .ok()
        .filter(|value| (-MAX_SAFE_INTEGER..=MAX_SAFE_INTEGER).contains(value))
}

fn boolean(text: &str) -> Option<bool> {
    match text.to_lowercase().as_str() {
        "true" | "yes" | "y" | "on" | "1" => Some(true),
        "false" | "no" | "n" | "off" | "0" => Some(false),
        _ => None,
    }
}

struct RoomInput {
    room_id: String,
    event_id: Option<String>,
    via: Vec<String>,
}

fn room_input(input: &str) -> Option<RoomInput> {
    if is_identifier(input, '!', false) {
        return Some(RoomInput {
            room_id: input.to_owned(),
            event_id: None,
            via: Vec::new(),
        });
    }
    let split = split_via(input);
    match parse_matrix_link(&split.href)? {
        MatrixLink::Room { room_id } if room_id.starts_with('!') => Some(RoomInput {
            room_id,
            event_id: None,
            via: split.via,
        }),
        MatrixLink::Event { room_id, event_id } if room_id.starts_with('!') => Some(RoomInput {
            room_id,
            event_id: Some(event_id),
            via: split.via,
        }),
        _ => None,
    }
}

fn room_reference_from(kind: RoomReferenceKind, room: RoomInput) -> LiteralValue {
    LiteralValue::Room(RoomReference {
        kind,
        id: room.room_id,
        via: (!room.via.is_empty()).then_some(room.via),
        event_id: room.event_id,
    })
}

fn primitive(kind: PrimitiveType, input: &str) -> Option<LiteralValue> {
    match kind {
        PrimitiveType::String => Some(LiteralValue::Text(input.to_owned())),
        PrimitiveType::Integer => integer(input).map(LiteralValue::Integer),
        PrimitiveType::Boolean => boolean(input).map(LiteralValue::Boolean),
        PrimitiveType::UserId => {
            if is_identifier(input, '@', true) {
                return Some(LiteralValue::Text(input.to_owned()));
            }
            match parse_matrix_link(input)? {
                MatrixLink::User { user_id } => Some(LiteralValue::Text(user_id)),
                _ => None,
            }
        }
        PrimitiveType::ServerName => {
            is_server_name(input).then(|| LiteralValue::Text(input.to_owned()))
        }
        PrimitiveType::RoomAlias => {
            if is_identifier(input, '#', true) {
                return Some(LiteralValue::Text(input.to_owned()));
            }
            match parse_matrix_link(&split_via(input).href)? {
                MatrixLink::Room { room_id } if room_id.starts_with('#') => {
                    Some(LiteralValue::Text(room_id))
                }
                _ => None,
            }
        }
        PrimitiveType::RoomId => room_input(input)
            .filter(|room| room.event_id.is_none())
            .map(|room| room_reference_from(RoomReferenceKind::RoomId, room)),
        PrimitiveType::EventId => room_input(input)
            .filter(|room| room.event_id.is_some())
            .map(|room| room_reference_from(RoomReferenceKind::EventId, room)),
    }
}

/// What the form shows for a value, and how a literal is matched by name.
#[must_use]
pub fn literal_label(value: &LiteralValue) -> String {
    match value {
        LiteralValue::Boolean(flag) => flag.to_string(),
        LiteralValue::Integer(number) => number.to_string(),
        LiteralValue::Text(text) => text.clone(),
        LiteralValue::Room(reference) => reference
            .event_id
            .clone()
            .unwrap_or_else(|| reference.id.clone()),
    }
}

fn scalar(schema: &ScalarSchema, input: &str) -> Option<LiteralValue> {
    match schema {
        ScalarSchema::Primitive { primitive: kind } => primitive(*kind, input),
        ScalarSchema::Literal { value } => {
            (literal_label(value).to_lowercase() == input.to_lowercase()).then(|| value.clone())
        }
    }
}

/// Literals are tried before primitives, so `all` picks the literal over a
/// string that would also accept it.
fn coerce_item(schema: &ItemSchema, input: &str) -> Option<LiteralValue> {
    let trimmed = trim(input);
    if trimmed.is_empty() {
        return None;
    }
    match schema {
        ItemSchema::Primitive { primitive: kind } => primitive(*kind, trimmed),
        ItemSchema::Literal { value } => scalar(
            &ScalarSchema::Literal {
                value: value.clone(),
            },
            trimmed,
        ),
        ItemSchema::Union { variants } => variants
            .iter()
            .filter(|variant| matches!(variant, ScalarSchema::Literal { .. }))
            .chain(
                variants
                    .iter()
                    .filter(|variant| !matches!(variant, ScalarSchema::Literal { .. })),
            )
            .find_map(|variant| scalar(variant, trimmed)),
    }
}

fn draft_of(parameter: &BotCommandParameter, value: Option<&ArgumentValue>) -> ArgumentDraft {
    if parameter.schema.is_boolean() {
        return ArgumentDraft::Flag(matches!(
            value,
            Some(ArgumentValue::One(LiteralValue::Boolean(true)))
        ));
    }
    if parameter.schema.is_array() {
        return ArgumentDraft::Words(match value {
            Some(ArgumentValue::Many(values)) => values.iter().map(literal_label).collect(),
            _ => Vec::new(),
        });
    }
    ArgumentDraft::Text(match value {
        Some(ArgumentValue::One(value)) => literal_label(value),
        _ => String::new(),
    })
}

#[must_use]
pub fn empty_drafts(command: &BotCommand) -> ArgumentDrafts {
    command
        .parameters
        .iter()
        .map(|parameter| {
            (
                parameter.key.clone(),
                draft_of(parameter, parameter.default_value.as_ref()),
            )
        })
        .collect()
}

fn flag_name(key: &str) -> String {
    key.replace('_', "-")
}

const fn fills_by_position(parameter: &BotCommandParameter) -> bool {
    !parameter.schema.is_boolean() || !parameter.optional
}

struct Reader<'a> {
    rest: &'a str,
}

impl<'a> Reader<'a> {
    fn shift(&mut self) -> &'a str {
        let end = self.rest.find(is_space).unwrap_or(self.rest.len());
        let word = self.rest.get(..end).unwrap_or_default();
        self.rest = trim_start(self.rest.get(end..).unwrap_or_default());
        word
    }

    /// `--name` or `--name=value`, ending at a space or the end of the line.
    fn named(&self) -> Option<(&'a str, Option<&'a str>, usize)> {
        let body = self.rest.strip_prefix("--")?;
        let end = body.find(is_space).unwrap_or(body.len());
        let token = body.get(..end)?;
        let (name, value) = match token.split_once('=') {
            Some((name, value)) => (name, Some(value)),
            None => (token, None),
        };
        let valid = !name.is_empty()
            && name
                .chars()
                .all(|c| c.is_alphanumeric() || c == '_' || c == '-');
        valid.then_some((name, value, end + 2))
    }
}

/// Fills the form from typed text: positional words in order, `--name` and
/// `--name=value` for any parameter, and the tail parameter takes the rest.
#[must_use]
pub fn drafts_from_text(command: &BotCommand, args: &str) -> ArgumentDrafts {
    let mut drafts = empty_drafts(command);
    let mut reader = Reader { rest: trim(args) };
    let mut named: Vec<&str> = Vec::new();
    let by_name = |name: &str| {
        let wanted = flag_name(name);
        command.parameters.iter().find(|parameter| {
            flag_name(&parameter.key) == wanted
                || parameter
                    .flag
                    .as_deref()
                    .and_then(|flag| flag.strip_prefix("--"))
                    .is_some_and(|flag| flag_name(flag) == wanted)
        })
    };
    let positional: Vec<&BotCommandParameter> = command
        .parameters
        .iter()
        .filter(|parameter| fills_by_position(parameter))
        .collect();
    let mut next = 0;

    while !reader.rest.is_empty() {
        if let Some((name, value, length)) = reader.named()
            && let Some(parameter) = by_name(name)
        {
            reader.rest = trim_start(reader.rest.get(length..).unwrap_or_default());
            named.push(&parameter.key);
            let draft = if parameter.schema.is_boolean() {
                ArgumentDraft::Flag(value.is_none_or(|value| boolean(value) == Some(true)))
            } else if parameter.schema.is_array() {
                let mut entries = match drafts.get(&parameter.key) {
                    Some(ArgumentDraft::Words(entries)) => entries.clone(),
                    _ => Vec::new(),
                };
                entries.push(
                    value
                        .map_or_else(|| reader.shift(), |value| value)
                        .to_owned(),
                );
                ArgumentDraft::Words(entries)
            } else {
                ArgumentDraft::Text(
                    value
                        .map_or_else(|| reader.shift(), |value| value)
                        .to_owned(),
                )
            };
            drafts.insert(parameter.key.clone(), draft);
            continue;
        }

        let Some((index, parameter)) = positional
            .iter()
            .enumerate()
            .skip(next)
            .find(|(_, parameter)| !named.contains(&parameter.key.as_str()))
        else {
            break;
        };
        next = index + 1;

        if command.tail_parameter.as_deref() == Some(parameter.key.as_str()) {
            drafts.insert(
                parameter.key.clone(),
                ArgumentDraft::Text(reader.rest.to_owned()),
            );
            break;
        }
        if parameter.schema.is_array() {
            let needed = positional
                .iter()
                .skip(next)
                .filter(|later| !later.optional && !named.contains(&later.key.as_str()))
                .count();
            let available = words(reader.rest);
            let before_flag = available
                .iter()
                .position(|word| word.starts_with("--"))
                .unwrap_or(available.len());
            let count = before_flag.saturating_sub(needed);
            let entries = (0..count).map(|_| reader.shift().to_owned()).collect();
            drafts.insert(parameter.key.clone(), ArgumentDraft::Words(entries));
            continue;
        }
        let word = reader.shift();
        let draft = if parameter.schema.is_boolean() {
            ArgumentDraft::Flag(boolean(word) == Some(true))
        } else {
            ArgumentDraft::Text(word.to_owned())
        };
        drafts.insert(parameter.key.clone(), draft);
    }
    drafts
}

fn literal_json(value: &LiteralValue) -> Value {
    match value {
        LiteralValue::Boolean(flag) => json!(flag),
        LiteralValue::Integer(number) => json!(number),
        LiteralValue::Text(text) => json!(text),
        LiteralValue::Room(reference) => {
            let mut object = Map::new();
            let kind = match reference.kind {
                RoomReferenceKind::RoomId => "room_id",
                RoomReferenceKind::EventId => "event_id",
            };
            object.insert("type".to_owned(), json!(kind));
            object.insert("id".to_owned(), json!(reference.id));
            if let Some(via) = &reference.via {
                object.insert("via".to_owned(), json!(via));
            }
            if let Some(event_id) = &reference.event_id {
                object.insert("event_id".to_owned(), json!(event_id));
            }
            Value::Object(object)
        }
    }
}

fn body_word(value: &LiteralValue) -> String {
    let label = literal_label(value);
    if has_space(&label) {
        serde_json::to_string(&label).unwrap_or(label)
    } else {
        label
    }
}

fn named_word(parameter: &BotCommandParameter, word: String) -> String {
    match &parameter.flag {
        Some(flag) => format!("{flag}={word}"),
        None => word,
    }
}

/// The structured block for a bot that reads MSC4391, and a text line that
/// means the same for one that only reads `body`.
#[must_use]
pub fn build_invocation(
    command: &BotCommand,
    drafts: &ArgumentDrafts,
    prefix: &str,
) -> InvocationResult {
    let mut arguments = Map::new();
    let mut errors = BTreeMap::new();
    let mut body = vec![format!("{prefix}{}", command.command)];

    for parameter in &command.parameters {
        let key = parameter.key.clone();
        let draft = drafts.get(&parameter.key);
        if let Some(ArgumentDraft::Flag(flag)) = draft {
            if !flag && parameter.optional {
                continue;
            }
            arguments.insert(key, json!(flag));
            body.push(match (&parameter.flag, parameter.optional) {
                (Some(name), _) => name.clone(),
                (None, true) => format!("--{}", flag_name(&parameter.key)),
                (None, false) => flag.to_string(),
            });
            continue;
        }
        let item = parameter.schema.item();
        if parameter.schema.is_array() {
            let entries: Vec<&String> = match draft {
                Some(ArgumentDraft::Words(entries)) => entries
                    .iter()
                    .filter(|entry| !trim(entry).is_empty())
                    .collect(),
                _ => Vec::new(),
            };
            let Some(values) = entries
                .iter()
                .map(|entry| coerce_item(&item, entry))
                .collect::<Option<Vec<_>>>()
            else {
                errors.insert(key, ArgumentError::Invalid);
                continue;
            };
            if values.is_empty() {
                if !parameter.optional {
                    errors.insert(key, ArgumentError::Required);
                }
                continue;
            }
            body.extend(
                values
                    .iter()
                    .map(|value| named_word(parameter, body_word(value))),
            );
            arguments.insert(key, Value::Array(values.iter().map(literal_json).collect()));
            continue;
        }
        let input = match draft {
            Some(ArgumentDraft::Text(text)) => text.as_str(),
            _ => "",
        };
        if trim(input).is_empty() {
            if !parameter.optional {
                errors.insert(key, ArgumentError::Required);
            }
            continue;
        }
        let Some(value) = coerce_item(&item, input) else {
            errors.insert(key, ArgumentError::Invalid);
            continue;
        };
        let word = if command.tail_parameter.as_deref() == Some(parameter.key.as_str()) {
            trim(input).to_owned()
        } else {
            body_word(&value)
        };
        body.push(named_word(parameter, word));
        arguments.insert(key, literal_json(&value));
    }

    if !errors.is_empty() {
        return InvocationResult::Invalid { errors };
    }
    InvocationResult::Built {
        invocation: BotCommandInvocation {
            command: command.command.clone(),
            arguments,
        },
        body: body.join(" "),
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{
        ArgumentDraft, ArgumentError, InvocationResult, build_invocation, drafts_from_text,
        is_server_name, match_bot_command, parse_bot_command,
    };

    fn ban() -> super::BotCommand {
        parse_bot_command(
            "@bot:example.org",
            Some("Bot"),
            None,
            &json!({
                "command": "ban",
                "aliases": ["b"],
                "description": { "m.text": [{ "body": "Ban someone" }] },
                "parameters": [
                    { "key": "target_room", "schema": { "schema_type": "primitive", "type": "room_id" } },
                    { "key": "timeout_seconds", "schema": { "schema_type": "primitive", "type": "integer" } },
                    { "key": "apply_to_policy", "schema": { "schema_type": "primitive", "type": "boolean" }, "optional": true },
                    { "key": "target_users", "schema": { "schema_type": "array", "items": { "schema_type": "primitive", "type": "user_id" } } },
                ],
            }),
        )
        .expect("fixture parses")
    }

    #[test]
    fn a_description_with_a_repeated_key_is_refused() {
        let content = json!({
            "command": "x",
            "parameters": [
                { "key": "a", "schema": { "schema_type": "primitive", "type": "string" } },
                { "key": "a", "schema": { "schema_type": "primitive", "type": "string" } },
            ],
        });
        assert_eq!(parse_bot_command("@b:x", None, None, &content), None);
    }

    #[test]
    fn the_longest_name_wins_and_must_end_at_a_space() {
        let commands = [ban()];
        let matched = match_bot_command("B !room:x 5", &commands).expect("matches the alias");
        assert_eq!(matched.args, "!room:x 5");
        assert_eq!(match_bot_command("banner", &commands), None);
    }

    #[test]
    fn text_fills_positional_words_and_named_switches() {
        let drafts = drafts_from_text(&ban(), "!room:example.org 60 @a:x @b:x --apply-to-policy");
        assert_eq!(
            drafts.get("target_room"),
            Some(&ArgumentDraft::Text("!room:example.org".to_owned()))
        );
        assert_eq!(
            drafts.get("target_users"),
            Some(&ArgumentDraft::Words(vec![
                "@a:x".to_owned(),
                "@b:x".to_owned()
            ]))
        );
        assert_eq!(
            drafts.get("apply_to_policy"),
            Some(&ArgumentDraft::Flag(true))
        );
    }

    #[test]
    fn an_invocation_carries_typed_arguments_and_a_body_line() {
        let command = ban();
        let drafts = drafts_from_text(&command, "!room:example.org 60 @a:x");
        let InvocationResult::Built { invocation, body } = build_invocation(&command, &drafts, "/")
        else {
            panic!("expected a built invocation");
        };
        assert_eq!(
            serde_json::to_value(invocation).expect("serializes"),
            json!({
                "command": "ban",
                "arguments": {
                    "target_room": { "type": "room_id", "id": "!room:example.org" },
                    "timeout_seconds": 60,
                    "target_users": ["@a:x"],
                },
            })
        );
        assert_eq!(body, "/ban !room:example.org 60 @a:x");
    }

    #[test]
    fn missing_and_invalid_arguments_are_reported_per_key() {
        let command = ban();
        let drafts = drafts_from_text(&command, "not-a-room six");
        let InvocationResult::Invalid { errors } = build_invocation(&command, &drafts, "/") else {
            panic!("expected errors");
        };
        assert_eq!(errors.get("target_room"), Some(&ArgumentError::Invalid));
        assert_eq!(errors.get("timeout_seconds"), Some(&ArgumentError::Invalid));
        assert_eq!(errors.get("target_users"), Some(&ArgumentError::Required));
    }

    #[test]
    fn server_names_follow_the_grammar() {
        assert!(is_server_name("example.org"));
        assert!(is_server_name("example.org:8448"));
        assert!(is_server_name("[::1]:8448"));
        assert!(!is_server_name("exa mple.org"));
        assert!(!is_server_name("example.org:123456"));
    }
}
