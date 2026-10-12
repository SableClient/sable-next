use serde::{Deserialize, Serialize};

/// One field of a state event a command rewrites. `Set` with an empty value
/// removes the field, as `Clear` does.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum FieldEdit {
    #[default]
    Keep,
    Clear,
    Set {
        value: String,
    },
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
#[serde(default)]
pub struct MemberLookEdit {
    pub display_name: FieldEdit,
    pub avatar_url: FieldEdit,
    pub color_on_light: FieldEdit,
    pub color_on_dark: FieldEdit,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
pub struct PronounView {
    pub summary: String,
    /// Absent when the writer did not tag the set with a language.
    pub language: Option<String>,
}
