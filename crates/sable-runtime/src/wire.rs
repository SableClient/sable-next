use std::{collections::BTreeMap, fmt};

use eyeball_im::VectorDiff;
use serde::{Deserialize, Deserializer, Serialize, de::DeserializeOwned};
use serde_json::Value;

use crate::error::AppError;

pub const MAX_INPUT_BYTES: usize = 1 << 20;

pub fn decode<T: DeserializeOwned>(json: &str) -> Result<T, AppError> {
    if json.len() > MAX_INPUT_BYTES {
        return Err(AppError::TooLarge {
            limit: MAX_INPUT_BYTES,
        });
    }
    serde_json::from_str(json).map_err(|_| AppError::Invalid)
}

pub const WIRE_SCHEMA: &str = include_str!("../schema.hash");

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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
pub struct Window {
    #[cfg_attr(feature = "typegen", specta(type = specta_typescript::Number))]
    pub start: usize,
    #[cfg_attr(feature = "typegen", specta(type = specta_typescript::Number))]
    pub end: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
pub struct Target {
    pub slice: String,
    #[serde(default)]
    #[cfg_attr(feature = "typegen", specta(type = specta_typescript::Unknown))]
    pub key: Value,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
pub struct SubscribeRequest {
    #[serde(flatten)]
    pub target: Target,
    #[serde(default)]
    pub window: Option<Window>,
}

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

#[derive(Debug, Clone, PartialEq, Serialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum Op {
    Fields {
        #[cfg_attr(feature = "typegen", specta(type = BTreeMap<String, specta_typescript::Unknown>))]
        fields: BTreeMap<String, Value>,
    },
    List {
        field: String,
        #[cfg_attr(
            feature = "typegen",
            specta(type = Vec<sable_protocol::VectorDiffWire<specta_typescript::Unknown>>)
        )]
        diffs: Vec<VectorDiff<Value>>,
    },
}

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
enum OpWire {
    Fields {
        fields: BTreeMap<String, Value>,
    },
    List {
        field: String,
        diffs: Vec<VectorDiffWire>,
    },
}

#[derive(Deserialize)]
enum VectorDiffWire {
    Append { values: Vec<Value> },
    Clear,
    PushFront { value: Value },
    PushBack { value: Value },
    PopFront,
    PopBack,
    Insert { index: usize, value: Value },
    Set { index: usize, value: Value },
    Remove { index: usize },
    Truncate { length: usize },
    Reset { values: Vec<Value> },
}

impl VectorDiffWire {
    fn into_diff(self) -> VectorDiff<Value> {
        match self {
            Self::Append { values } => VectorDiff::Append {
                values: values.into_iter().collect(),
            },
            Self::Clear => VectorDiff::Clear,
            Self::PushFront { value } => VectorDiff::PushFront { value },
            Self::PushBack { value } => VectorDiff::PushBack { value },
            Self::PopFront => VectorDiff::PopFront,
            Self::PopBack => VectorDiff::PopBack,
            Self::Insert { index, value } => VectorDiff::Insert { index, value },
            Self::Set { index, value } => VectorDiff::Set { index, value },
            Self::Remove { index } => VectorDiff::Remove { index },
            Self::Truncate { length } => VectorDiff::Truncate { length },
            Self::Reset { values } => VectorDiff::Reset {
                values: values.into_iter().collect(),
            },
        }
    }
}

impl<'de> Deserialize<'de> for Op {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        match OpWire::deserialize(deserializer)? {
            OpWire::Fields { fields } => Ok(Self::Fields { fields }),
            OpWire::List { field, diffs } => Ok(Self::List {
                field,
                diffs: diffs.into_iter().map(VectorDiffWire::into_diff).collect(),
            }),
        }
    }
}

impl Op {
    #[must_use]
    pub fn weight(&self) -> usize {
        match self {
            Self::Fields { fields } => fields.len().max(1),
            Self::List { diffs, .. } => diffs
                .iter()
                .map(|diff| match diff {
                    VectorDiff::Append { values } | VectorDiff::Reset { values } => {
                        values.len().max(1)
                    }
                    _ => 1,
                })
                .sum(),
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
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ReplyError {
    Rpc {
        #[cfg_attr(feature = "typegen", specta(type = sable_protocol::RpcError))]
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
    Reply {
        req: ReqId,
        #[cfg_attr(feature = "typegen", specta(type = specta_typescript::Number))]
        epoch: u64,
        outcome: Outcome,
    },
    Notice {
        slice: String,
        #[cfg_attr(feature = "typegen", specta(type = specta_typescript::Unknown))]
        notice: Value,
        #[cfg_attr(feature = "typegen", specta(type = specta_typescript::Number))]
        epoch: u64,
    },
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

    proptest! {
        #[test]
        fn arbitrary_text_never_panics(input in ".*") {
            let _ = decode::<SubscribeRequest>(&input);
            let _ = decode::<Value>(&input);
        }
    }
}
