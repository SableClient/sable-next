use std::fmt;

use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::Value;

use crate::error::AppError;
use sable_protocol::VectorDiff;

pub const MAX_INPUT_BYTES: usize = 1 << 20;

/// Nothing of the input is echoed in the error or the log.
///
/// # Errors
///
/// `TooLarge` past [`MAX_INPUT_BYTES`], `Invalid` for anything that does not decode.
pub fn decode<T: DeserializeOwned>(json: &str) -> Result<T, AppError> {
    if json.len() > MAX_INPUT_BYTES {
        return Err(AppError::TooLarge {
            limit: MAX_INPUT_BYTES,
        });
    }
    serde_json::from_str(json).map_err(|_| AppError::Invalid)
}

/// Written by the type generator. A UI that disagrees was built from another source.
pub const WIRE_SCHEMA: &str = include_str!("../schema.hash");

#[must_use]
pub fn fnv1a_hex(text: &str) -> String {
    let hash = text.bytes().fold(0xcbf2_9ce4_8422_2325_u64, |hash, byte| {
        (hash ^ u64::from(byte)).wrapping_mul(0x0100_0000_01b3)
    });
    format!("{hash:016x}")
}

/// A UI whose `schema` differs reloads, or restarts its worker.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
pub struct Handshake {
    pub schema: String,
    pub slices: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
pub struct SubId(pub u32);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
pub struct ReqId(
    #[cfg_attr(feature = "typegen", specta(type = specta_typescript::Number))] pub u64,
);

impl fmt::Display for ReqId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(f)
    }
}

/// `start..end` in list order.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
pub struct Window {
    #[cfg_attr(feature = "typegen", specta(type = specta_typescript::Number))]
    pub start: usize,
    #[cfg_attr(feature = "typegen", specta(type = specta_typescript::Number))]
    pub end: usize,
}

/// `key` is `null` for a singleton.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
pub struct Target {
    pub slice: String,
    #[serde(default)]
    #[cfg_attr(feature = "typegen", specta(type = specta_typescript::Unknown))]
    pub key: Value,
}

/// `window` is only read by list slices.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
pub struct SubscribeRequest {
    #[serde(flatten)]
    pub target: Target,
    #[serde(default)]
    pub window: Option<Window>,
}

/// Patches for the subscription carry `rev + 1`, `rev + 2`, and so on.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
pub struct Snapshot {
    #[cfg_attr(feature = "typegen", specta(type = specta_typescript::Number))]
    pub rev: u64,
    #[cfg_attr(feature = "typegen", specta(type = specta_typescript::Number))]
    pub epoch: u64,
    #[cfg_attr(feature = "typegen", specta(type = specta_typescript::Unknown))]
    pub state: Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
pub struct Subscribed {
    pub sub: SubId,
    pub snapshot: Snapshot,
}

/// Paths are JSON pointers.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum Op {
    Replace {
        path: String,
        #[cfg_attr(feature = "typegen", specta(type = specta_typescript::Unknown))]
        value: Value,
    },
    Remove {
        path: String,
    },
    /// Edits the array at `path` the way `VectorDiff` edits a vector.
    List {
        path: String,
        #[cfg_attr(
            feature = "typegen",
            specta(type = Vec<VectorDiff<specta_typescript::Unknown>>)
        )]
        diffs: Vec<VectorDiff<Value>>,
    },
}

impl Op {
    /// One for an edit, one per row for a list.
    #[must_use]
    pub fn weight(&self) -> usize {
        match self {
            Self::List { diffs, .. } => diffs
                .iter()
                .map(|diff| match diff {
                    VectorDiff::Append { values } | VectorDiff::Reset { values } => {
                        values.len().max(1)
                    }
                    _ => 1,
                })
                .sum(),
            _ => 1,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
#[serde(rename_all = "snake_case")]
pub enum LostReason {
    EpochChanged,
    Expired,
    InstanceStopped,
    InstanceFailed,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ReplyError {
    Rpc {
        #[cfg_attr(feature = "typegen", specta(type = specta_typescript::Unknown))]
        error: Value,
    },
    Encode,
    Lost {
        reason: LostReason,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum Outcome {
    Ok {
        #[cfg_attr(feature = "typegen", specta(type = specta_typescript::Unknown))]
        value: Value,
    },
    Error {
        error: ReplyError,
    },
}

/// `epoch` is the account the event belongs to. Replies of an old epoch arrive as `Lost`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AppEvent {
    Patch {
        sub: SubId,
        #[cfg_attr(feature = "typegen", specta(type = specta_typescript::Number))]
        rev: u64,
        #[cfg_attr(feature = "typegen", specta(type = specta_typescript::Number))]
        epoch: u64,
        ops: Vec<Op>,
    },
    /// Comes after every patch the request caused.
    Reply {
        req: ReqId,
        #[cfg_attr(feature = "typegen", specta(type = specta_typescript::Number))]
        epoch: u64,
        outcome: Outcome,
    },
    Notice {
        slice: String,
        stage: String,
        text: String,
        #[cfg_attr(feature = "typegen", specta(type = specta_typescript::Number))]
        epoch: u64,
    },
    /// Ask for a snapshot.
    Resync {
        sub: SubId,
        #[cfg_attr(feature = "typegen", specta(type = specta_typescript::Number))]
        epoch: u64,
    },
}

/// Apply its events together, in order, before the UI draws.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
pub struct Batch {
    #[cfg_attr(feature = "typegen", specta(type = specta_typescript::Number))]
    pub tick: u64,
    pub events: Vec<AppEvent>,
}

#[cfg(test)]
mod tests {
    use proptest::prelude::*;

    use super::*;

    #[test]
    fn oversized_input_is_refused_before_parsing() {
        let json = format!("\"{}\"", "a".repeat(MAX_INPUT_BYTES));
        assert_eq!(
            decode::<String>(&json),
            Err(AppError::TooLarge {
                limit: MAX_INPUT_BYTES
            })
        );
    }

    #[test]
    fn input_of_exactly_the_limit_is_decoded_and_one_byte_more_is_not() {
        let (head, tail) = (r#"{"slice":""#, r#""}"#);
        let json = format!(
            "{head}{}{tail}",
            "a".repeat(MAX_INPUT_BYTES - head.len() - tail.len())
        );
        assert_eq!(json.len(), MAX_INPUT_BYTES);
        assert_eq!(decode::<Target>(&json).unwrap().key, Value::Null);
        assert_eq!(
            decode::<Target>(&format!("{json} ")),
            Err(AppError::TooLarge {
                limit: MAX_INPUT_BYTES
            })
        );
    }

    #[test]
    fn a_key_nested_near_the_parser_limit_decodes_and_past_it_does_not() {
        let nested = |depth: usize| {
            format!(
                r#"{{"slice":"s","key":{}0{}}}"#,
                "[".repeat(depth),
                "]".repeat(depth)
            )
        };
        assert_eq!(decode::<Target>(&nested(100)).unwrap().slice, "s");
        assert_eq!(decode::<Target>(&nested(200)), Err(AppError::Invalid));
    }

    #[test]
    fn deep_nesting_is_an_error_not_a_stack_overflow() {
        let json = format!("{}{}", "[".repeat(100_000), "]".repeat(100_000));
        assert_eq!(decode::<Value>(&json), Err(AppError::Invalid));
    }

    #[test]
    fn fnv1a_hex_is_stable_and_sensitive() {
        assert_eq!(fnv1a_hex(""), "cbf29ce484222325");
        assert_eq!(fnv1a_hex("a"), "af63dc4c8601ec8c");
        assert_ne!(fnv1a_hex("type A = 1;"), fnv1a_hex("type A = 2;"));
    }

    #[test]
    fn a_batch_round_trips() {
        let batch = Batch {
            tick: 3,
            events: vec![
                AppEvent::Patch {
                    sub: SubId(1),
                    rev: 2,
                    epoch: 1,
                    ops: vec![Op::Remove {
                        path: "/a".to_owned(),
                    }],
                },
                AppEvent::Reply {
                    req: ReqId(7),
                    epoch: 1,
                    outcome: Outcome::Error {
                        error: ReplyError::Lost {
                            reason: LostReason::Expired,
                        },
                    },
                },
            ],
        };
        let json = serde_json::to_string(&batch).unwrap();
        assert_eq!(decode::<Batch>(&json).unwrap(), batch);
    }

    proptest! {
        #[test]
        fn arbitrary_text_never_panics(input in ".*") {
            let _ = decode::<SubscribeRequest>(&input);
            let _ = decode::<Value>(&input);
        }

        #[test]
        fn arbitrary_json_shapes_never_panic(depth in 0usize..400, leaf in any::<i64>()) {
            let json = format!("{}{leaf}{}", "[".repeat(depth), "]".repeat(depth));
            let _ = decode::<Target>(&json);
        }
    }
}
