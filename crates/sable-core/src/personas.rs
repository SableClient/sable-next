use crate::api::personas::ReorderParams;
use crate::api::personas::SaveParams;
use crate::api::personas::SetSelectionParams;
use crate::api::personas::{AccountRoomParams, DisableRoomParams};
use std::collections::{BTreeMap, BTreeSet};

use matrix_sdk::Room;
use matrix_sdk::ruma::TransactionId;
use matrix_sdk::ruma::events::room::message::RoomMessageEventContentWithoutRelation;
use matrix_sdk::ruma::events::{
    AnyMessageLikeEventContent, GlobalAccountDataEventType, MessageLikeEventContent,
};
use matrix_sdk::ruma::serde::Raw;
use matrix_sdk::send_queue::LocalEchoContent;
use sable_model::non_blank::{NonBlank, NonBlankVerbatim};
use serde::{Deserialize, Serialize, Serializer};
use serde_json::{Map, Value, json};
use serde_with::{DefaultOnError, MapSkipError, VecSkipError, serde_as};

use crate::Core;
use crate::ResultExt;
use crate::profiles::pronoun_sets;
use crate::protocol::PersonaAlternateAvatarView;
use crate::protocol::{
    PerMessageProfileView, PersonaCatalogView, PersonaSelectionView, PersonaSortFlagsView,
    PersonaTriggerView, PersonaView, PluralkitImportView, PronounView, RpcError,
};

const CATALOG_V3: &str = "fi.mau.msc4461.per_message_profiles.v3";
const CATALOG_V2: &str = "fi.mau.msc4461.per_message_profiles.v2";
const SELECTION_PREFIX: &str = "fyi.cisnt.permessageprofile";

pub(crate) const PER_MESSAGE_PROFILE: &str = "com.beeper.per_message_profile";

pub(crate) fn is_persona_event(event_type: &str) -> bool {
    event_type == CATALOG_V3
        || event_type == CATALOG_V2
        || event_type
            .strip_prefix(SELECTION_PREFIX)
            .is_some_and(|scope| scope.starts_with('.'))
}

fn selection_event(scope: &str) -> GlobalAccountDataEventType {
    GlobalAccountDataEventType::from(format!("{SELECTION_PREFIX}.{scope}"))
}

#[serde_as]
#[derive(Deserialize)]
struct TriggerIn {
    #[serde_as(as = "NonBlankVerbatim")]
    #[serde(default)]
    prefix: Option<String>,
    #[serde_as(as = "NonBlankVerbatim")]
    #[serde(default)]
    suffix: Option<String>,
    #[serde_as(deserialize_as = "DefaultOnError")]
    #[serde(default)]
    keep_trigger: Option<bool>,
    #[serde_as(as = "NonBlankVerbatim")]
    #[serde(default, rename = "net.f0rest.alternate_avatar_id")]
    alternate_avatar_id: Option<String>,
}

impl TriggerIn {
    fn into_view(self) -> Option<PersonaTriggerView> {
        if self.prefix.is_none() && self.suffix.is_none() {
            return None;
        }

        Some(PersonaTriggerView {
            prefix: self.prefix,
            suffix: self.suffix,
            keep_trigger: self.keep_trigger.unwrap_or(false),
            alternate_avatar_id: self.alternate_avatar_id,
        })
    }
}

#[serde_as]
#[derive(Deserialize)]
struct TriggerV2In {
    #[serde_as(deserialize_as = "DefaultOnError<Vec<NonBlankVerbatim>>")]
    #[serde(default)]
    prefix: Vec<Option<String>>,
    #[serde_as(deserialize_as = "DefaultOnError<Vec<NonBlankVerbatim>>")]
    #[serde(default, rename = "net.f0rest.suffix")]
    suffix: Vec<Option<String>>,
    #[serde_as(deserialize_as = "DefaultOnError<VecSkipError<_>>")]
    #[serde(default, rename = "net.f0rest.circumfix")]
    circumfix: Vec<TriggerIn>,
}

impl TriggerV2In {
    fn into_views(self) -> Vec<PersonaTriggerView> {
        let circumfixes = self
            .circumfix
            .into_iter()
            .filter(|trigger| trigger.prefix.is_some() && trigger.suffix.is_some())
            .map(|trigger| PersonaTriggerView {
                prefix: trigger.prefix,
                suffix: trigger.suffix,
                keep_trigger: false,
                alternate_avatar_id: None,
            });
        let prefixes = self
            .prefix
            .into_iter()
            .flatten()
            .map(|prefix| PersonaTriggerView {
                prefix: Some(prefix),
                suffix: None,
                keep_trigger: false,
                alternate_avatar_id: None,
            });
        let suffixes = self
            .suffix
            .into_iter()
            .flatten()
            .map(|suffix| PersonaTriggerView {
                prefix: None,
                suffix: Some(suffix),
                keep_trigger: false,
                alternate_avatar_id: None,
            });

        circumfixes.chain(prefixes).chain(suffixes).collect()
    }
}

#[serde_as]
#[derive(Default, Deserialize)]
struct ColorsIn {
    #[serde_as(as = "NonBlank")]
    #[serde(default)]
    on_light: Option<String>,
    #[serde_as(as = "NonBlank")]
    #[serde(default)]
    on_dark: Option<String>,
}

#[serde_as]
#[derive(Deserialize)]
struct PluralkitIn {
    #[serde_as(as = "NonBlank")]
    #[serde(default)]
    id: Option<String>,
    #[serde_as(as = "NonBlank")]
    #[serde(default)]
    uuid: Option<String>,
    #[serde_as(as = "NonBlank")]
    #[serde(default)]
    avatar_url: Option<String>,
    #[serde_as(as = "NonBlank")]
    #[serde(default)]
    description: Option<String>,
}

impl PluralkitIn {
    fn into_view(self) -> Option<PluralkitImportView> {
        Some(PluralkitImportView {
            id: self.id?,
            uuid: self.uuid,
            avatar_url: self.avatar_url,
            description: self.description,
        })
    }
}

#[serde_as]
#[derive(Deserialize)]
struct AlternateAvatarIn {
    #[serde_as(as = "NonBlank")]
    #[serde(default)]
    id: Option<String>,
    #[serde_as(as = "NonBlank")]
    #[serde(default)]
    avatar_url: Option<String>,
}

impl AlternateAvatarIn {
    fn into_view(self) -> Option<PersonaAlternateAvatarView> {
        Some(PersonaAlternateAvatarView {
            id: self.id?,
            avatar_url: self.avatar_url?,
        })
    }
}

#[serde_as]
#[derive(Deserialize)]
struct SortFlagsIn {
    #[serde_as(deserialize_as = "DefaultOnError")]
    #[serde(default)]
    hidden: Option<bool>,
}

impl SortFlagsIn {
    fn into_view(self) -> Option<PersonaSortFlagsView> {
        Some(PersonaSortFlagsView {
            hidden: self.hidden?,
        })
    }
}

#[serde_as]
#[derive(Deserialize)]
struct PersonaIn {
    #[serde_as(as = "NonBlank")]
    #[serde(default)]
    id: Option<String>,
    #[serde_as(deserialize_as = "DefaultOnError")]
    #[serde(default)]
    displayname: Option<String>,
    #[serde_as(as = "NonBlank")]
    #[serde(default)]
    avatar_url: Option<String>,
    #[serde(default, rename = "io.fsky.nyx.pronouns")]
    pronouns: Option<Value>,
    #[serde_as(deserialize_as = "DefaultOnError")]
    #[serde(default, rename = "eu.she-a.color")]
    colors: Option<ColorsIn>,
    #[serde_as(deserialize_as = "DefaultOnError<Option<VecSkipError<_>>>")]
    #[serde(default)]
    triggers: Option<Vec<TriggerIn>>,
    #[serde_as(deserialize_as = "DefaultOnError")]
    #[serde(default)]
    trigger: Option<TriggerV2In>,
    #[serde_as(deserialize_as = "DefaultOnError")]
    #[serde(default, rename = "net.f0rest.pkimport")]
    pluralkit: Option<PluralkitIn>,
    #[serde_as(deserialize_as = "DefaultOnError")]
    #[serde(default, rename = "net.f0rest.last_used")]
    last_used: Option<u64>,
    #[serde(default, rename = "net.f0rest.alternate_avatars")]
    alternate_avatars: Option<Vec<AlternateAvatarIn>>,
    #[serde_as(deserialize_as = "DefaultOnError")]
    #[serde(default, rename = "net.f0rest.biography")]
    biography: Option<String>,
    #[serde_as(deserialize_as = "DefaultOnError")]
    #[serde(default, rename = "net.f0rest.banner_url")]
    banner_url: Option<String>,
    #[serde_as(deserialize_as = "DefaultOnError")]
    #[serde(default, rename = "net.f0rest.is_animal")]
    pub is_animal: Option<String>,
    #[serde_as(deserialize_as = "DefaultOnError")]
    #[serde(default, rename = "net.f0rest.has_animal")]
    pub has_animal: Option<String>,
    #[serde_as(deserialize_as = "DefaultOnError")]
    #[serde(default, rename = "net.f0rest.animal_need")]
    pub animal_need: Option<String>,
    #[serde_as(deserialize_as = "DefaultOnError")]
    #[serde(default, rename = "net.f0rest.sort_flags")]
    pub sort_flags: Option<SortFlagsIn>,
}

impl PersonaIn {
    fn into_view(self) -> Option<PersonaView> {
        let colors = self.colors.unwrap_or_default();
        let triggers = match self.triggers {
            Some(entries) => entries
                .into_iter()
                .filter_map(TriggerIn::into_view)
                .collect(),
            None => self.trigger.map_or_else(Vec::new, TriggerV2In::into_views),
        };

        let alternate_avatars = self.alternate_avatars.map(|entries| {
            entries
                .into_iter()
                .filter_map(AlternateAvatarIn::into_view)
                .collect()
        });

        Some(PersonaView {
            id: self.id?,
            display_name: self.displayname?,
            avatar_url: self.avatar_url,
            pronouns: pronoun_sets(self.pronouns.as_ref()),
            color_on_light: colors.on_light,
            color_on_dark: colors.on_dark,
            triggers,
            pluralkit: self.pluralkit.and_then(PluralkitIn::into_view),
            last_used: self.last_used,
            alternate_avatars,
            biography: self.biography,
            banner_url: self.banner_url,
            is_animal: self.is_animal,
            has_animal: self.has_animal,
            animal_need: self.animal_need,
            sort_flags: self.sort_flags.and_then(SortFlagsIn::into_view),
        })
    }
}

#[serde_as]
#[derive(Deserialize)]
struct ProfilesIn {
    #[serde_as(deserialize_as = "DefaultOnError<Option<VecSkipError<_>>>")]
    #[serde(default)]
    profiles: Option<Vec<PersonaIn>>,
}

fn personas_from_catalog(content: &Value) -> Vec<PersonaView> {
    #[serde_as]
    #[derive(Deserialize)]
    struct Wrapped {
        #[serde_as(deserialize_as = "DefaultOnError")]
        #[serde(default)]
        content: Option<ProfilesIn>,
    }

    let profiles = ProfilesIn::deserialize(content)
        .ok()
        .and_then(|catalog| catalog.profiles)
        .or_else(|| Wrapped::deserialize(content).ok()?.content?.profiles);

    let personas: Vec<_> = profiles
        .into_iter()
        .flatten()
        .filter_map(PersonaIn::into_view)
        .collect();
    let mut taken: BTreeSet<_> = personas.iter().map(|persona| persona.id.clone()).collect();
    let mut seen = BTreeSet::new();
    personas
        .into_iter()
        .map(|mut persona| {
            if !seen.insert(persona.id.clone()) {
                let mut n = 2;
                while taken.contains(&format!("{}-{n}", persona.id)) {
                    n += 1;
                }
                persona.id = format!("{}-{n}", persona.id);
                taken.insert(persona.id.clone());
            }
            persona
        })
        .collect()
}

#[derive(Serialize)]
struct PronounOut {
    summary: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    language: Option<String>,
}

impl From<&PronounView> for PronounOut {
    fn from(pronoun: &PronounView) -> Self {
        Self {
            summary: pronoun.summary.clone(),
            language: pronoun.language.clone(),
        }
    }
}

#[derive(Serialize)]
struct ColorsOut {
    #[serde(skip_serializing_if = "Option::is_none")]
    on_light: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    on_dark: Option<String>,
}

impl ColorsOut {
    fn new(on_light: Option<String>, on_dark: Option<String>) -> Option<Self> {
        (on_light.is_some() || on_dark.is_some()).then_some(Self { on_light, on_dark })
    }
}

#[derive(Serialize)]
struct LookOut {
    #[serde(rename = "io.fsky.nyx.pronouns", skip_serializing_if = "Vec::is_empty")]
    pronouns: Vec<PronounOut>,
    #[serde(rename = "eu.she-a.color", skip_serializing_if = "Option::is_none")]
    colors: Option<ColorsOut>,
    #[serde(
        rename = "net.f0rest.biography",
        skip_serializing_if = "Option::is_none"
    )]
    pub biography: Option<String>,
    #[serde(
        rename = "net.f0rest.banner_url",
        skip_serializing_if = "Option::is_none"
    )]
    pub banner_url: Option<String>,
    #[serde(
        rename = "net.f0rest.is_animal",
        skip_serializing_if = "Option::is_none"
    )]
    pub is_animal: Option<String>,
    #[serde(
        rename = "net.f0rest.has_animal",
        skip_serializing_if = "Option::is_none"
    )]
    pub has_animal: Option<String>,
    #[serde(
        rename = "net.f0rest.animal_need",
        skip_serializing_if = "Option::is_none"
    )]
    pub animal_need: Option<String>,
}

impl From<&PersonaView> for LookOut {
    fn from(persona: &PersonaView) -> Self {
        Self {
            pronouns: persona.pronouns.iter().map(Into::into).collect(),
            colors: ColorsOut::new(
                persona.color_on_light.clone(),
                persona.color_on_dark.clone(),
            ),
            biography: persona.biography.clone(),
            banner_url: persona.banner_url.clone(),
            is_animal: persona.is_animal.clone(),
            has_animal: persona.has_animal.clone(),
            animal_need: persona.animal_need.clone(),
        }
    }
}

impl From<&PerMessageProfileView> for LookOut {
    fn from(profile: &PerMessageProfileView) -> Self {
        Self {
            pronouns: profile.pronouns.iter().map(Into::into).collect(),
            colors: ColorsOut::new(
                profile.color_on_light.clone(),
                profile.color_on_dark.clone(),
            ),
            biography: profile.biography.clone(),
            banner_url: profile.banner_url.clone(),
            is_animal: profile.is_animal.clone(),
            has_animal: profile.has_animal.clone(),
            animal_need: profile.animal_need.clone(),
        }
    }
}

#[derive(Serialize)]
struct PluralkitOut {
    id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    uuid: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    avatar_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    description: Option<String>,
}

impl From<&PluralkitImportView> for PluralkitOut {
    fn from(pluralkit: &PluralkitImportView) -> Self {
        Self {
            id: pluralkit.id.clone(),
            uuid: pluralkit.uuid.clone(),
            avatar_url: pluralkit.avatar_url.clone(),
            description: pluralkit.description.clone(),
        }
    }
}

#[derive(Serialize)]
struct TriggerOut {
    #[serde(skip_serializing_if = "Option::is_none")]
    prefix: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    suffix: Option<String>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    keep_trigger: bool,
    #[serde(
        rename = "net.f0rest.alternate_avatar_id",
        skip_serializing_if = "Option::is_none"
    )]
    alternate_avatar_id: Option<String>,
}

impl From<&PersonaTriggerView> for TriggerOut {
    fn from(trigger: &PersonaTriggerView) -> Self {
        Self {
            prefix: trigger.prefix.clone(),
            suffix: trigger.suffix.clone(),
            keep_trigger: trigger.keep_trigger,
            alternate_avatar_id: trigger.alternate_avatar_id.clone(),
        }
    }
}

#[derive(Serialize)]
struct AlternateAvatarOut {
    id: String,
    avatar_url: String,
}

impl From<&PersonaAlternateAvatarView> for AlternateAvatarOut {
    fn from(avatar: &PersonaAlternateAvatarView) -> Self {
        Self {
            id: avatar.id.clone(),
            avatar_url: avatar.avatar_url.clone(),
        }
    }
}

#[derive(Serialize)]
struct SortFlagsOut {
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    hidden: bool,
}

impl From<&PersonaSortFlagsView> for SortFlagsOut {
    fn from(sort_flags: &PersonaSortFlagsView) -> Self {
        Self {
            hidden: sort_flags.hidden,
        }
    }
}

#[derive(Serialize)]
struct PersonaOut {
    id: String,
    displayname: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    avatar_url: Option<String>,
    #[serde(flatten)]
    look: LookOut,
    #[serde(
        rename = "net.f0rest.pkimport",
        skip_serializing_if = "Option::is_none"
    )]
    pluralkit: Option<PluralkitOut>,
    triggers: Vec<TriggerOut>,
    #[serde(
        rename = "net.f0rest.last_used",
        skip_serializing_if = "Option::is_none"
    )]
    last_used: Option<u64>,
    #[serde(
        rename = "net.f0rest.alternate_avatars",
        skip_serializing_if = "Option::is_none"
    )]
    alternate_avatars: Option<Vec<AlternateAvatarOut>>,
    #[serde(
        rename = "net.f0rest.sort_flags",
        skip_serializing_if = "Option::is_none"
    )]
    sort_flags: Option<SortFlagsOut>,
}

impl From<&PersonaView> for PersonaOut {
    fn from(persona: &PersonaView) -> Self {
        Self {
            id: persona.id.clone(),
            displayname: persona.display_name.clone(),
            avatar_url: persona.avatar_url.clone(),
            look: persona.into(),
            pluralkit: persona.pluralkit.as_ref().map(Into::into),
            triggers: persona.triggers.iter().map(Into::into).collect(),
            last_used: persona.last_used,
            alternate_avatars: persona
                .alternate_avatars
                .as_ref()
                .map(|vec| vec.iter().map(Into::into).collect()),
            sort_flags: persona.sort_flags.as_ref().map(Into::into),
        }
    }
}

#[derive(Serialize)]
struct CatalogOut {
    profiles: Vec<PersonaOut>,
}

#[serde_as]
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SelectionIn {
    #[serde_as(as = "NonBlank")]
    #[serde(default)]
    profile_id: Option<String>,
    #[serde_as(deserialize_as = "DefaultOnError")]
    #[serde(default)]
    valid_until: Option<u64>,
    #[serde_as(as = "NonBlank")]
    #[serde(default)]
    alternate_avatar_id: Option<String>,
}

impl SelectionIn {
    fn into_view(self) -> Option<PersonaSelectionView> {
        Some(PersonaSelectionView {
            persona_id: self.profile_id?,
            valid_until: self.valid_until,
            alternate_avatar_id: self.alternate_avatar_id,
        })
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SelectionOut {
    profile_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    valid_until: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    alternate_avatar_id: Option<String>,
}

impl From<&PersonaSelectionView> for SelectionOut {
    fn from(selection: &PersonaSelectionView) -> Self {
        Self {
            profile_id: selection.persona_id.clone(),
            valid_until: selection.valid_until,
            alternate_avatar_id: selection.alternate_avatar_id.clone(),
        }
    }
}

#[serde_as]
#[derive(Deserialize)]
struct AccountSelectionIn {
    #[serde_as(deserialize_as = "DefaultOnError")]
    #[serde(default)]
    association: Option<SelectionIn>,
}

#[derive(Serialize)]
struct AccountSelectionOut {
    #[serde(skip_serializing_if = "Option::is_none")]
    association: Option<SelectionOut>,
}

#[derive(Debug, Clone)]
enum RoomAssociation {
    Persona(PersonaSelectionView),
    /// Sends as the account, while typed triggers still pick a persona.
    Account,
    Disabled,
}

impl Serialize for RoomAssociation {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Self::Persona(selection) => SelectionOut::from(selection).serialize(serializer),
            Self::Account => serializer.serialize_bool(true),
            Self::Disabled => serializer.serialize_bool(false),
        }
    }
}

#[derive(Deserialize)]
#[serde(untagged)]
enum AssociationIn {
    Off(bool),
    Persona(SelectionIn),
}

impl AssociationIn {
    fn into_association(self) -> Option<RoomAssociation> {
        match self {
            Self::Off(false) => Some(RoomAssociation::Disabled),
            Self::Off(true) => Some(RoomAssociation::Account),
            Self::Persona(selection) => selection.into_view().map(RoomAssociation::Persona),
        }
    }
}

fn room_associations(content: &Value) -> BTreeMap<String, RoomAssociation> {
    #[serde_as]
    #[derive(Deserialize)]
    struct RoomAssociationsIn {
        #[serde_as(deserialize_as = "DefaultOnError<MapSkipError<_, _>>")]
        #[serde(default)]
        associations: BTreeMap<String, AssociationIn>,
    }

    RoomAssociationsIn::deserialize(content)
        .map(|content| content.associations)
        .unwrap_or_default()
        .into_iter()
        .filter_map(|(room_id, association)| Some((room_id, association.into_association()?)))
        .collect()
}

#[derive(Serialize)]
struct RoomAssociationsOut {
    associations: BTreeMap<String, RoomAssociation>,
}

const MAX_FIELD_BYTES: usize = 255;

fn clamp_field(value: &str) -> String {
    value
        .chars()
        .filter(|character| *character != '\0')
        .scan(0usize, |used, character| {
            let next = *used + character.len_utf8();
            if next > MAX_FIELD_BYTES {
                return None;
            }
            *used = next;
            Some(character)
        })
        .collect()
}

#[derive(Serialize)]
struct ProfileOut {
    #[serde(skip_serializing_if = "Option::is_none")]
    id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    displayname: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    avatar_url: Option<String>,
    #[serde(flatten)]
    look: LookOut,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    has_fallback: bool,
}

pub(crate) fn profile_value(profile: &PerMessageProfileView) -> Value {
    let out = ProfileOut {
        id: profile
            .id
            .as_deref()
            .map(clamp_field)
            .filter(|id| !id.is_empty()),
        displayname: profile
            .display_name
            .as_deref()
            .map(str::trim)
            .filter(|name| !name.is_empty())
            .map(clamp_field),
        avatar_url: profile.avatar_url.clone(),
        look: profile.into(),
        has_fallback: profile.has_fallback,
    };
    // Strings, bools and lists of them always serialize.
    serde_json::to_value(out).unwrap_or_default()
}

pub(crate) fn profile_extra_content(profile: &PerMessageProfileView) -> Map<String, Value> {
    [(PER_MESSAGE_PROFILE.to_owned(), profile_value(profile))]
        .into_iter()
        .collect()
}

pub(crate) fn without_fallback(profile: &PerMessageProfileView) -> PerMessageProfileView {
    PerMessageProfileView {
        has_fallback: false,
        ..profile.clone()
    }
}

pub(crate) fn fallback_body(
    body: &str,
    formatted: Option<&str>,
    profile: &PerMessageProfileView,
    edit: bool,
) -> Option<(String, String)> {
    if !profile.has_fallback {
        return None;
    }
    let name = profile
        .display_name
        .as_deref()
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(clamp_field)
        .filter(|name| !name.is_empty())?;

    let plain_prefix = format!("{name}: ");
    let html_prefix = format!(
        "<strong data-mx-profile-fallback>{}: </strong>",
        html_escape::encode_text(&name)
    );

    let (marker, body) = split_edit_marker(body, edit);
    let formatted = formatted.map(|html| split_edit_marker(html, edit).1.to_owned());
    let stripped = body.strip_prefix(&plain_prefix).unwrap_or(body);

    let formatted = match formatted {
        Some(html) if html.starts_with(&html_prefix) => html,
        Some(html) => format!("{html_prefix}{html}"),
        None => format!(
            "{html_prefix}{}",
            html_escape::encode_text(stripped).replace('\n', "<br/>")
        ),
    };

    Some((
        format!("{marker}{plain_prefix}{stripped}"),
        format!("{marker}{formatted}"),
    ))
}

pub(crate) fn outgoing_with_fallback(
    body: String,
    formatted: Option<String>,
    profile: &PerMessageProfileView,
) -> (String, Option<String>, PerMessageProfileView) {
    match fallback_body(&body, formatted.as_deref(), profile, false) {
        Some((body, formatted)) => (body, Some(formatted), profile.clone()),
        None => (body, formatted, without_fallback(profile)),
    }
}

pub(crate) fn stamp_profile(content: &mut Value, profile: &PerMessageProfileView) {
    let Some(object) = content.as_object_mut() else {
        return;
    };

    let raw_body = object
        .get("body")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let raw_formatted = object
        .get("formatted_body")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned);

    let edit = object.contains_key("m.new_content");
    let Some((body, formatted)) = fallback_body(&raw_body, raw_formatted.as_deref(), profile, edit)
    else {
        object.insert(
            PER_MESSAGE_PROFILE.to_owned(),
            profile_value(&without_fallback(profile)),
        );
        return;
    };

    object.insert(PER_MESSAGE_PROFILE.to_owned(), profile_value(profile));
    object.insert("format".to_owned(), "org.matrix.custom.html".into());
    object.insert("formatted_body".to_owned(), formatted.into());
    object.insert("body".to_owned(), body.into());
}

const EDIT_MARKER: &str = "* ";

fn split_edit_marker(value: &str, edit: bool) -> (&str, &str) {
    value
        .strip_prefix(EDIT_MARKER)
        .filter(|_| edit)
        .map_or(("", value), |rest| (EDIT_MARKER, rest))
}

fn catalog_from_backup(backup: &str) -> Option<Value> {
    let parsed: Value = serde_json::from_str(backup).ok()?;
    let catalog = parsed.get(CATALOG_V3)?;
    catalog
        .get("profiles")
        .is_some_and(Value::is_array)
        .then(|| catalog.clone())
}

#[cfg(not(target_family = "wasm"))]
async fn space_associations(
    client: &matrix_sdk::Client,
    room_id: &matrix_sdk::ruma::RoomId,
    associations: &BTreeMap<String, RoomAssociation>,
) -> Vec<RoomAssociation> {
    let mut rooms = vec![room_id.to_owned()];
    let mut seen = BTreeSet::new();
    let mut selections = Vec::new();
    for _ in 0..=4 {
        let mut parents = Vec::new();
        for room in rooms {
            if !seen.insert(room.clone()) {
                continue;
            }
            if let Some(association) = associations.get(room.as_str()) {
                selections.push(association.clone());
            }
            parents.extend(crate::view::listing_spaces(None, client, &room).await);
        }
        rooms = parents;
        if rooms.is_empty() {
            break;
        }
    }
    selections
}

#[cfg(not(target_family = "wasm"))]
pub(crate) async fn notification_profile(
    client: &matrix_sdk::Client,
    room_id: &matrix_sdk::ruma::RoomId,
) -> matrix_sdk::Result<Option<PerMessageProfileView>> {
    async fn data(
        client: &matrix_sdk::Client,
        event_type: GlobalAccountDataEventType,
    ) -> matrix_sdk::Result<Option<Value>> {
        client
            .account()
            .fetch_account_data(event_type)
            .await?
            .map(|raw| raw.deserialize_as::<Value>().map_err(Into::into))
            .transpose()
    }
    let associations = data(client, selection_event("roomassociation"))
        .await?
        .as_ref()
        .map(room_associations)
        .unwrap_or_default();
    if matches!(
        associations.get(room_id.as_str()),
        Some(RoomAssociation::Account | RoomAssociation::Disabled)
    ) {
        return Ok(None);
    }
    let account = data(client, selection_event("globalassociation"))
        .await?
        .as_ref()
        .and_then(|content| {
            AccountSelectionIn::deserialize(content)
                .ok()?
                .association?
                .into_view()
        });
    let catalog = match data(client, CATALOG_V3.into()).await? {
        Some(catalog) => Some(catalog),
        None => data(client, CATALOG_V2.into()).await?,
    };
    let personas = catalog
        .as_ref()
        .map(personas_from_catalog)
        .unwrap_or_default();
    let mut selections = space_associations(client, room_id, &associations).await;
    selections.extend(account.map(RoomAssociation::Persona));
    let now = crate::now_ms();
    for association in selections {
        let selection = match association {
            RoomAssociation::Account | RoomAssociation::Disabled => return Ok(None),
            RoomAssociation::Persona(selection) => selection,
        };
        if selection.valid_until.is_some_and(|until| until <= now) {
            continue;
        }
        if let Some(persona) = personas
            .iter()
            .find(|profile| profile.id == selection.persona_id)
        {
            let avatar_url = selection
                .alternate_avatar_id
                .as_ref()
                .and_then(|id| {
                    persona
                        .alternate_avatars
                        .as_ref()?
                        .iter()
                        .find(|avatar| &avatar.id == id)
                })
                .map_or_else(
                    || persona.avatar_url.clone(),
                    |avatar| Some(avatar.avatar_url.clone()),
                );
            return Ok(Some(PerMessageProfileView {
                id: Some(persona.id.clone()),
                display_name: sable_model::text::visible_name(persona.display_name.clone()),
                avatar_url,
                pronouns: persona.pronouns.clone(),
                color_on_light: persona.color_on_light.clone(),
                color_on_dark: persona.color_on_dark.clone(),
                has_fallback: false,
                biography: None,
                banner_url: None,
                is_animal: None,
                has_animal: None,
                animal_need: None,
            }));
        }
    }
    Ok(None)
}

impl Core {
    pub(crate) async fn edit_local_message(
        &self,
        room: &Room,
        transaction_id: &TransactionId,
        message: RoomMessageEventContentWithoutRelation,
        profile: Option<&PerMessageProfileView>,
    ) -> Result<bool, RpcError> {
        let (echoes, _updates) = room
            .send_queue()
            .subscribe()
            .await
            .or_failed(self, "edit_local_message")?;

        let Some((serialized, handle)) = echoes.into_iter().find_map(|echo| {
            if echo.transaction_id != *transaction_id {
                return None;
            }
            match echo.content {
                LocalEchoContent::Event {
                    serialized_event,
                    send_handle,
                    ..
                } => Some((serialized_event, send_handle)),
                _ => None,
            }
        }) else {
            return Ok(false);
        };

        let previous = serialized
            .raw()
            .0
            .deserialize_as_unchecked::<Value>()
            .or_failed(self, "edit_local_message")?;
        let mut value = serde_json::to_value(&message).or_failed(self, "edit_local_message")?;
        if let Some(object) = value.as_object_mut() {
            for key in [
                "m.relates_to",
                crate::link_previews::BUNDLED_LINK_PREVIEWS,
                crate::link_previews::LEGACY_BUNDLED_LINK_PREVIEWS,
            ] {
                if let Some(retained) = previous.get(key) {
                    object.insert(key.to_owned(), retained.clone());
                }
            }
        }
        if let Some(profile) = profile {
            stamp_profile(&mut value, profile);
        }
        ensure_empty_mentions(&mut value);

        let raw = Raw::<AnyMessageLikeEventContent>::from_json_string(value.to_string())
            .or_failed(self, "edit_local_message")?;

        handle
            .edit_raw(raw, "m.room.message".to_owned())
            .await
            .or_failed(self, "edit_local_message")
    }

    pub(crate) async fn edit_with_persona(
        &self,
        room: &Room,
        content: &AnyMessageLikeEventContent,
        profile: Option<&PerMessageProfileView>,
        forum_title: Option<String>,
        retained: serde_json::Map<String, Value>,
    ) -> Result<(), RpcError> {
        let event_type = content.event_type().to_string();
        let title = crate::outgoing::forum_title_value(forum_title);
        let mut value = serde_json::to_value(content).or_failed(self, "edit_with_persona")?;

        let update = |content: &mut Value| {
            if let Some(profile) = profile {
                stamp_profile(content, profile);
            } else if let Some(object) = content.as_object_mut() {
                object.remove(PER_MESSAGE_PROFILE);
                object.remove("m.per_message_profile");
            }
            ensure_empty_mentions(content);
            if let (Some(title), Some(object)) = (&title, content.as_object_mut()) {
                object.insert(crate::view::FORUM_TITLE.to_owned(), title.clone());
            }
        };
        update(&mut value);
        if let Some(content) = value.get_mut("m.new_content") {
            update(content);
            if let Some(object) = content.as_object_mut() {
                object.extend(retained);
            }
        }

        let raw = Raw::<AnyMessageLikeEventContent>::from_json_string(value.to_string())
            .or_failed(self, "edit_with_persona")?;

        room.send_queue()
            .send_raw(raw, event_type)
            .await
            .or_failed(self, "edit_with_persona")?;

        Ok(())
    }

    async fn persona_account_data(
        &self,
        event_type: GlobalAccountDataEventType,
        fetch: bool,
    ) -> Result<Option<Value>, RpcError> {
        let raw = if fetch {
            self.global_account_data(event_type, "personas: fetch_account_data")
                .await?
        } else {
            let client = self.client().await?;
            self.with_open_stores(async || client.account().account_data_raw(event_type).await)
                .await
                .or_failed(self, "personas: stored_account_data")?
        };
        let Some(raw) = raw else {
            return Ok(None);
        };

        raw.deserialize_as::<Value>()
            .map(Some)
            .or_failed(self, "personas_deserialize")
    }

    async fn load_personas(&self, fetch: bool) -> Result<Vec<PersonaView>, RpcError> {
        if let Some(content) = self
            .persona_account_data(GlobalAccountDataEventType::from(CATALOG_V3), fetch)
            .await?
            && content.get("profiles").is_some()
        {
            return Ok(personas_from_catalog(&content));
        }

        let Some(content) = self
            .persona_account_data(GlobalAccountDataEventType::from(CATALOG_V2), fetch)
            .await?
        else {
            return Ok(Vec::new());
        };

        let personas = personas_from_catalog(&content);
        if personas.is_empty() || !fetch {
            return Ok(personas);
        }

        self.save_personas(&personas).await?;
        Ok(personas)
    }

    /// A backup file is the v3 catalog event wrapped under its own type.
    pub(crate) async fn persona_backup(&self) -> Result<String, RpcError> {
        let content = self
            .persona_account_data(GlobalAccountDataEventType::from(CATALOG_V3), true)
            .await?;
        serde_json::to_string_pretty(&json!({ CATALOG_V3: content }))
            .or_failed(self, "persona_backup")
    }

    pub(crate) fn check_persona_backup(backup: &str) -> Result<(), RpcError> {
        catalog_from_backup(backup)
            .map(drop)
            .ok_or(RpcError::InvalidBackup)
    }

    pub(crate) async fn restore_persona_backup(&self, backup: &str) -> Result<(), RpcError> {
        let _guard = self.account_data_lock.lock().await;
        let catalog = catalog_from_backup(backup).ok_or(RpcError::InvalidBackup)?;
        self.put_global_account_data(
            GlobalAccountDataEventType::from(CATALOG_V3),
            &catalog,
            "restore_persona_backup",
        )
        .await
    }

    async fn save_personas(&self, personas: &[PersonaView]) -> Result<(), RpcError> {
        self.put_global_account_data(
            GlobalAccountDataEventType::from(CATALOG_V3),
            &CatalogOut {
                profiles: personas.iter().map(Into::into).collect(),
            },
            "personas",
        )
        .await
    }

    async fn account_selection(
        &self,
        fetch: bool,
    ) -> Result<Option<PersonaSelectionView>, RpcError> {
        Ok(self
            .persona_account_data(selection_event("globalassociation"), fetch)
            .await?
            .as_ref()
            .and_then(|content| {
                AccountSelectionIn::deserialize(content)
                    .ok()?
                    .association?
                    .into_view()
            }))
    }

    async fn room_selections(
        &self,
        fetch: bool,
    ) -> Result<BTreeMap<String, RoomAssociation>, RpcError> {
        Ok(self
            .persona_account_data(selection_event("roomassociation"), fetch)
            .await?
            .as_ref()
            .map(room_associations)
            .unwrap_or_default())
    }

    async fn catalog_view(&self, fetch: bool) -> Result<PersonaCatalogView, RpcError> {
        let mut rooms = BTreeMap::new();
        let mut account_rooms = Vec::new();
        let mut disabled_rooms = Vec::new();
        for (room_id, association) in self.room_selections(fetch).await? {
            match association {
                RoomAssociation::Persona(selection) => {
                    rooms.insert(room_id, selection);
                }
                RoomAssociation::Account => account_rooms.push(room_id),
                RoomAssociation::Disabled => disabled_rooms.push(room_id),
            }
        }

        Ok(PersonaCatalogView {
            personas: self.load_personas(fetch).await?,
            account: self.account_selection(fetch).await?,
            rooms,
            account_rooms,
            disabled_rooms,
        })
    }

    pub(crate) async fn personas(&self) -> Result<PersonaCatalogView, RpcError> {
        let _guard = self.account_data_lock.lock().await;
        match self.catalog_view(true).await {
            Ok(catalog) => Ok(catalog),
            Err(error) => {
                tracing::warn!(
                    ?error,
                    "using the stored persona catalog after a fetch failed"
                );
                self.catalog_view(false).await
            }
        }
    }

    pub(crate) async fn save_persona(
        &self,
        SaveParams {
            persona,
            base_persona,
            previous_id,
        }: SaveParams,
    ) -> Result<Vec<PersonaView>, RpcError> {
        let _guard = self.account_data_lock.lock().await;
        let replaced = previous_id.unwrap_or_else(|| persona.id.clone());
        let mut personas = self.load_personas(true).await?;

        personas.retain(|existing| existing.id != persona.id || existing.id == replaced);
        match personas.iter_mut().find(|existing| existing.id == replaced) {
            Some(existing) => {
                merge_persona(existing, &base_persona, &persona);
                existing.id.clone_from(&persona.id);
            }
            None => personas.push(persona.clone()),
        }

        self.save_personas(&personas).await?;
        if replaced != persona.id {
            self.repoint_selections(&replaced, Some(&persona.id))
                .await?;
        }

        Ok(personas)
    }

    pub(crate) async fn remove_persona(&self, id: &str) -> Result<Vec<PersonaView>, RpcError> {
        let _guard = self.account_data_lock.lock().await;
        let mut personas = self.load_personas(true).await?;
        personas.retain(|persona| persona.id != id);

        self.save_personas(&personas).await?;
        self.repoint_selections(id, None).await?;

        Ok(personas)
    }

    pub(crate) async fn reorder_personas(
        &self,
        ReorderParams { ids }: ReorderParams,
    ) -> Result<Vec<PersonaView>, RpcError> {
        let _guard = self.account_data_lock.lock().await;
        let personas = self.load_personas(true).await?;
        let mut reordered = Vec::with_capacity(personas.len());
        for id in ids {
            if let Some(persona) = personas.iter().find(|persona| persona.id == id)
                && !reordered
                    .iter()
                    .any(|existing: &PersonaView| existing.id == id)
            {
                reordered.push(persona.clone());
            }
        }
        let remaining = personas
            .into_iter()
            .filter(|persona| !reordered.iter().any(|existing| existing.id == persona.id))
            .collect::<Vec<_>>();
        reordered.extend(remaining);
        self.save_personas(&reordered).await?;
        Ok(reordered)
    }

    async fn repoint_selections(&self, from: &str, to: Option<&str>) -> Result<(), RpcError> {
        if let Some(account) = self.account_selection(true).await?
            && account.persona_id == from
        {
            let selection = to.map(|id| PersonaSelectionView {
                persona_id: id.to_owned(),
                alternate_avatar_id: account.alternate_avatar_id,
                valid_until: account.valid_until,
            });
            self.put_global_account_data(
                selection_event("globalassociation"),
                &AccountSelectionOut {
                    association: selection.as_ref().map(Into::into),
                },
                "personas",
            )
            .await?;
        }

        let mut rooms = self.room_selections(true).await?;
        let affected: Vec<String> = rooms
            .iter()
            .filter(|(_, association)| {
                matches!(association, RoomAssociation::Persona(selection) if selection.persona_id == from)
            })
            .map(|(room_id, _)| room_id.clone())
            .collect();
        if affected.is_empty() {
            return Ok(());
        }

        for room_id in affected {
            match to {
                Some(id) => {
                    if let Some(RoomAssociation::Persona(selection)) = rooms.get_mut(&room_id) {
                        id.clone_into(&mut selection.persona_id);
                    }
                }
                None => {
                    rooms.remove(&room_id);
                }
            }
        }

        self.write_room_selections(rooms).await
    }

    async fn write_room_selections(
        &self,
        rooms: BTreeMap<String, RoomAssociation>,
    ) -> Result<(), RpcError> {
        self.put_global_account_data(
            selection_event("roomassociation"),
            &RoomAssociationsOut {
                associations: rooms,
            },
            "personas",
        )
        .await
    }

    pub(crate) async fn set_persona_selection(
        &self,
        SetSelectionParams {
            room_id,
            persona_id,
            valid_until,
            alternate_avatar_id,
        }: SetSelectionParams,
    ) -> Result<(), RpcError> {
        let _guard = self.account_data_lock.lock().await;
        let selection = persona_id.map(|persona_id| PersonaSelectionView {
            persona_id,
            alternate_avatar_id,
            valid_until,
        });

        let Some(room_id) = room_id else {
            return self
                .put_global_account_data(
                    selection_event("globalassociation"),
                    &AccountSelectionOut {
                        association: selection.as_ref().map(Into::into),
                    },
                    "personas",
                )
                .await;
        };

        let mut rooms = self.room_selections(true).await?;
        match selection {
            Some(selection) => {
                rooms.insert(room_id.to_string(), RoomAssociation::Persona(selection));
            }
            None => {
                rooms.remove(room_id.as_str());
            }
        }

        self.write_room_selections(rooms).await
    }

    pub(crate) async fn disable_room_personas(
        &self,
        DisableRoomParams { room_id }: DisableRoomParams,
    ) -> Result<(), RpcError> {
        let _guard = self.account_data_lock.lock().await;
        let mut rooms = self.room_selections(true).await?;
        rooms.insert(room_id.to_string(), RoomAssociation::Disabled);
        self.write_room_selections(rooms).await
    }

    pub(crate) async fn account_room_personas(
        &self,
        AccountRoomParams { room_id }: AccountRoomParams,
    ) -> Result<(), RpcError> {
        let _guard = self.account_data_lock.lock().await;
        let mut rooms = self.room_selections(true).await?;
        rooms.insert(room_id.to_string(), RoomAssociation::Account);
        self.write_room_selections(rooms).await
    }
}

fn merge_persona(current: &mut PersonaView, base: &PersonaView, incoming: &PersonaView) {
    let (Ok(Value::Object(base)), Ok(Value::Object(incoming)), Ok(Value::Object(mut merged))) = (
        serde_json::to_value(base),
        serde_json::to_value(incoming),
        serde_json::to_value(&*current),
    ) else {
        return;
    };
    for (field, value) in incoming {
        if base.get(&field) != Some(&value) {
            merged.insert(field, value);
        }
    }
    if let Ok(persona) = serde_json::from_value(Value::Object(merged)) {
        *current = persona;
    }
}

fn ensure_empty_mentions(content: &mut Value) {
    if let Some(object) = content.as_object_mut() {
        object
            .entry("m.mentions")
            .or_insert_with(|| serde_json::json!({}));
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn a_backup_must_carry_a_catalog_with_profiles() {
        let catalog = serde_json::json!({ "profiles": [{ "id": "alt" }] });
        let backup = serde_json::json!({ super::CATALOG_V3: catalog }).to_string();
        assert_eq!(super::catalog_from_backup(&backup), Some(catalog));

        for invalid in [
            "not json".to_owned(),
            serde_json::json!({ super::CATALOG_V3: {} }).to_string(),
            serde_json::json!({ super::CATALOG_V3: null }).to_string(),
            serde_json::json!({ super::CATALOG_V3: [] }).to_string(),
            serde_json::json!({ "other": { "profiles": [] } }).to_string(),
        ] {
            assert_eq!(super::catalog_from_backup(&invalid), None, "{invalid}");
        }
    }

    use super::{
        RoomAssociation, RoomAssociationsOut, ensure_empty_mentions, fallback_body,
        outgoing_with_fallback, personas_from_catalog, profile_value, room_associations,
        stamp_profile,
    };
    use crate::protocol::{PerMessageProfileView, PronounView};
    use serde_json::json;

    fn persona(value: &serde_json::Value) -> crate::protocol::PersonaView {
        personas_from_catalog(&json!({ "profiles": [value] }))
            .pop()
            .expect("a persona")
    }

    #[test]
    fn persona_catalog_and_selection_events_are_persona_events() {
        assert!(super::is_persona_event(
            "fi.mau.msc4461.per_message_profiles.v3"
        ));
        assert!(super::is_persona_event(
            "fyi.cisnt.permessageprofile.roomassociation"
        ));
        assert!(!super::is_persona_event("fyi.cisnt.permessageprofileother"));
        assert!(!super::is_persona_event("m.direct"));
    }

    fn profile(display_name: &str, has_fallback: bool) -> PerMessageProfileView {
        PerMessageProfileView {
            id: Some("kris".to_owned()),
            display_name: Some(display_name.to_owned()),
            avatar_url: None,
            pronouns: Vec::new(),
            color_on_light: None,
            color_on_dark: None,
            has_fallback,
            biography: None,
            banner_url: None,
            is_animal: None,
            has_animal: None,
            animal_need: None,
        }
    }

    #[test]
    fn persona_edits_add_an_empty_m_mentions_without_overwriting_mentions() {
        let mut without_mentions = json!({ "msgtype": "m.text", "body": "hello" });
        ensure_empty_mentions(&mut without_mentions);
        assert_eq!(without_mentions["m.mentions"], json!({}));

        let mut with_mentions = json!({ "m.mentions": { "room": true } });
        ensure_empty_mentions(&mut with_mentions);
        assert_eq!(with_mentions["m.mentions"], json!({ "room": true }));
    }

    #[test]
    fn a_room_with_personas_off_round_trips_as_false() {
        let content = json!({
            "associations": {
                "!off:example.org": false,
                "!kris:example.org": { "profileId": "kris", "validUntil": 20 },
            }
        });

        let rooms = room_associations(&content);

        assert!(matches!(
            rooms.get("!off:example.org"),
            Some(RoomAssociation::Disabled)
        ));
        assert!(matches!(
            rooms.get("!kris:example.org"),
            Some(RoomAssociation::Persona(selection))
                if selection.persona_id == "kris" && selection.valid_until == Some(20)
        ));
        assert_eq!(
            serde_json::to_value(RoomAssociationsOut {
                associations: rooms
            })
            .expect("serializable"),
            json!({
                "associations": {
                    "!off:example.org": false,
                    "!kris:example.org": { "profileId": "kris", "validUntil": 20 },
                }
            })
        );
    }

    #[test]
    fn a_room_sending_as_the_account_round_trips_as_true() {
        let content = json!({ "associations": { "!plain:example.org": true } });

        let rooms = room_associations(&content);

        assert!(matches!(
            rooms.get("!plain:example.org"),
            Some(RoomAssociation::Account)
        ));
        assert_eq!(
            serde_json::to_value(RoomAssociationsOut {
                associations: rooms
            })
            .expect("serializable"),
            content
        );
    }

    #[test]
    fn reads_a_v3_persona_with_its_triggers() {
        let persona = persona(&json!({
            "id": "kris",
            "displayname": "Kris",
            "avatar_url": "mxc://example.org/kris",
            "io.fsky.nyx.pronouns": [{ "summary": "they/them", "language": "EN" }],
            "eu.she-a.color": { "on_light": "#333", "on_dark": "#eee" },
            "triggers": [
                { "prefix": "k:" },
                { "suffix": "-k", "keep_trigger": true },
                { "prefix": "", "suffix": "" }
            ],
        }));

        assert_eq!(persona.display_name, "Kris");
        assert_eq!(
            persona.pronouns,
            vec![PronounView {
                summary: "they/them".to_owned(),
                language: Some("en".to_owned()),
            }]
        );
        assert_eq!(persona.color_on_dark.as_deref(), Some("#eee"));
        assert_eq!(persona.triggers.len(), 2);
        assert!(persona.triggers[1].keep_trigger);
    }

    #[test]
    fn a_persona_writes_only_what_it_has_and_reads_back_unchanged() {
        let written = json!({
            "id": "kris",
            "displayname": "Kris",
            "io.fsky.nyx.pronouns": [{ "summary": "they/them", "language": "en" }],
            "eu.she-a.color": { "on_dark": "#eee" },
            "net.f0rest.pkimport": { "id": "abcde" },
            "triggers": [{ "prefix": "k:" }, { "suffix": "-k", "keep_trigger": true }],
            "net.f0rest.last_used": 7,
        });
        let persona = persona(&written);

        let out = serde_json::to_value(super::PersonaOut::from(&persona)).expect("serializable");

        assert_eq!(out, written);
    }

    #[test]
    fn triggers_keep_the_spaces_they_were_saved_with() {
        let tags =
            |persona: &crate::protocol::PersonaView| -> Vec<(Option<String>, Option<String>)> {
                persona
                    .triggers
                    .iter()
                    .map(|trigger| (trigger.prefix.clone(), trigger.suffix.clone()))
                    .collect()
            };
        let owned = |text: &str| Some(text.to_owned());

        let v3 = persona(&json!({
            "id": "emi", "displayname": "Emi",
            "triggers": [
                { "prefix": "emi: " },
                { "suffix": " -emi" },
                { "prefix": "  ", "suffix": " " }
            ],
        }));
        assert_eq!(
            tags(&v3),
            vec![(owned("emi: "), None), (None, owned(" -emi"))]
        );

        let v2 = persona(&json!({
            "id": "emi", "displayname": "Emi",
            "trigger": { "prefix": ["e: "], "net.f0rest.suffix": [" -e"] },
        }));
        assert_eq!(tags(&v2), vec![(owned("e: "), None), (None, owned(" -e"))]);
    }

    #[test]
    fn lists_skip_bad_entries_and_a_non_list_reads_as_missing() {
        let skipped = persona(&json!({
            "id": "a", "displayname": "A",
            "triggers": [5, { "prefix": "a:" }, "x"],
            "trigger": { "prefix": ["v2:"] },
        }));
        assert_eq!(skipped.triggers.len(), 1);
        assert_eq!(skipped.triggers[0].prefix.as_deref(), Some("a:"));

        let legacy = persona(&json!({
            "id": "a", "displayname": "A",
            "triggers": "nope",
            "trigger": { "prefix": ["v2:", 5, "  "], "net.f0rest.suffix": "nope" },
        }));
        assert_eq!(legacy.triggers.len(), 1);
        assert_eq!(legacy.triggers[0].prefix.as_deref(), Some("v2:"));
    }

    #[test]
    fn room_associations_skip_bad_entries_and_a_non_object_is_empty() {
        let rooms = room_associations(&json!({ "associations": { "!a:x": 7, "!b:x": false } }));
        assert_eq!(rooms.len(), 1);
        assert!(room_associations(&json!({ "associations": [1] })).is_empty());
    }

    #[test]
    fn converts_a_v2_trigger_object_circumfixes_first() {
        let persona = persona(&json!({
            "id": "kris",
            "displayname": "Kris",
            "trigger": {
                "prefix": ["k:"],
                "net.f0rest.suffix": ["-k"],
                "net.f0rest.circumfix": [{ "prefix": "[", "suffix": "]" }],
            },
        }));

        let shapes: Vec<_> = persona
            .triggers
            .iter()
            .map(|trigger| (trigger.prefix.as_deref(), trigger.suffix.as_deref()))
            .collect();
        assert_eq!(
            shapes,
            vec![
                (Some("["), Some("]")),
                (Some("k:"), None),
                (None, Some("-k")),
            ]
        );
    }

    #[test]
    fn reads_the_catalog_through_v1s_nested_wrapper() {
        let nested = json!({
            "type": "m.per_message_profiles",
            "content": { "profiles": [{ "id": "kris", "displayname": "Kris" }] },
        });
        assert_eq!(personas_from_catalog(&nested).len(), 1);
    }

    #[test]
    fn a_repeated_id_is_kept_under_a_free_id() {
        let catalog = json!({
            "profiles": [
                { "id": "kris", "displayname": "Kris" },
                { "id": "kris-2", "displayname": "Sam" },
                { "id": "kris", "displayname": "Other Kris" },
            ],
        });
        let ids: Vec<_> = personas_from_catalog(&catalog)
            .into_iter()
            .map(|persona| (persona.id, persona.display_name))
            .collect();
        assert_eq!(
            ids,
            vec![
                ("kris".to_owned(), "Kris".to_owned()),
                ("kris-2".to_owned(), "Sam".to_owned()),
                ("kris-3".to_owned(), "Other Kris".to_owned()),
            ]
        );
    }

    #[test]
    fn a_message_opening_with_a_bullet_is_not_an_edit() {
        let (body, formatted, _) = outgoing_with_fallback(
            "* one\n* two".to_owned(),
            Some("<ul><li>one</li><li>two</li></ul>".to_owned()),
            &profile("Kris", true),
        );

        assert_eq!(body, "Kris: * one\n* two");
        assert_eq!(
            formatted.as_deref(),
            Some(
                "<strong data-mx-profile-fallback>Kris: </strong><ul><li>one</li><li>two</li></ul>"
            )
        );
    }

    #[test]
    fn an_edit_keeps_its_marker_ahead_of_the_prefix() {
        let mut content = json!({
            "msgtype": "m.text",
            "body": "* * one",
            "format": "org.matrix.custom.html",
            "formatted_body": "* <ul><li>one</li></ul>",
            "m.new_content": {
                "msgtype": "m.text",
                "body": "* one",
                "format": "org.matrix.custom.html",
                "formatted_body": "<ul><li>one</li></ul>",
            },
        });
        let persona = profile("Kris", true);
        stamp_profile(&mut content, &persona);
        stamp_profile(&mut content["m.new_content"], &persona);

        assert_eq!(content["body"], "* Kris: * one");
        assert_eq!(
            content["formatted_body"],
            "* <strong data-mx-profile-fallback>Kris: </strong><ul><li>one</li></ul>"
        );
        assert_eq!(content["m.new_content"]["body"], "Kris: * one");
        assert_eq!(
            content["m.new_content"]["formatted_body"],
            "<strong data-mx-profile-fallback>Kris: </strong><ul><li>one</li></ul>"
        );
    }

    #[test]
    fn the_fallback_prefixes_both_bodies_once() {
        let mut content = json!({ "msgtype": "m.text", "body": "hello" });
        stamp_profile(&mut content, &profile("Kris", true));

        assert_eq!(content["body"], "Kris: hello");
        assert_eq!(content["format"], "org.matrix.custom.html");
        assert_eq!(
            content["formatted_body"],
            "<strong data-mx-profile-fallback>Kris: </strong>hello"
        );

        stamp_profile(&mut content, &profile("Kris", true));
        assert_eq!(content["body"], "Kris: hello");
        assert_eq!(
            content["formatted_body"],
            "<strong data-mx-profile-fallback>Kris: </strong>hello"
        );
    }

    #[test]
    fn a_name_with_markup_is_escaped_in_the_fallback() {
        let mut content = json!({ "msgtype": "m.text", "body": "hi" });
        stamp_profile(&mut content, &profile("<b>Kris</b>", true));

        assert_eq!(
            content["formatted_body"],
            "<strong data-mx-profile-fallback>&lt;b&gt;Kris&lt;/b&gt;: </strong>hi"
        );
    }

    #[test]
    fn without_a_fallback_only_the_profile_is_attached() {
        let mut content = json!({ "msgtype": "m.text", "body": "hello" });
        stamp_profile(&mut content, &profile("Kris", false));

        assert_eq!(content["body"], "hello");
        assert!(content.get("formatted_body").is_none());
        assert_eq!(
            content["com.beeper.per_message_profile"]["displayname"],
            "Kris"
        );
        assert!(
            content["com.beeper.per_message_profile"]
                .get("has_fallback")
                .is_none()
        );
    }

    #[test]
    fn a_nameless_profile_does_not_claim_a_fallback_it_cannot_write() {
        let mut nameless = profile("Kris", true);
        nameless.display_name = None;

        let mut content = json!({ "msgtype": "m.text", "body": "hello" });
        stamp_profile(&mut content, &nameless);

        assert_eq!(content["body"], "hello");
        assert!(
            content["com.beeper.per_message_profile"]
                .get("has_fallback")
                .is_none()
        );
        assert!(fallback_body("hello", None, &nameless, false).is_none());
    }

    #[test]
    fn an_outgoing_message_carries_the_fallback_it_advertises() {
        let (body, formatted, profile) =
            outgoing_with_fallback("hello".to_owned(), None, &profile("Kris", true));

        assert_eq!(body, "Kris: hello");
        assert_eq!(
            formatted.as_deref(),
            Some("<strong data-mx-profile-fallback>Kris: </strong>hello")
        );
        assert!(profile.has_fallback);

        let (body, formatted, profile) =
            outgoing_with_fallback("hello".to_owned(), None, &profile_without_name());
        assert_eq!(body, "hello");
        assert!(formatted.is_none());
        assert!(!profile.has_fallback);
    }

    #[test]
    fn oversized_fields_are_clamped_on_a_char_boundary() {
        let mut long = profile(&"é".repeat(200), true);
        long.id = Some("k".repeat(300));

        let stamped = profile_value(&long);
        let name = stamped["displayname"].as_str().expect("a display name");

        assert!(name.len() <= 255);
        assert_eq!(name.chars().count(), 127);
        assert_eq!(stamped["id"].as_str().expect("an id").len(), 255);
    }

    #[test]
    fn a_null_byte_never_reaches_the_wire() {
        let profile = profile("Kr\0is", true);
        let stamped = profile_value(&profile);

        assert_eq!(stamped["displayname"], "Kris");
    }

    fn profile_without_name() -> PerMessageProfileView {
        PerMessageProfileView {
            display_name: None,
            ..profile("Kris", true)
        }
    }

    #[tokio::test]
    async fn an_unreachable_server_serves_the_stored_catalog() {
        use crate::{Core, session::Session, store::MemorySessionStore};
        use matrix_sdk::test_utils::mocks::MatrixMockServer;
        use matrix_sdk_ui::sync_service::SyncService;
        use std::sync::Arc;
        use wiremock::{
            Mock, ResponseTemplate,
            matchers::{method, path_regex},
        };

        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;
        server
            .mock_sync()
            .ok_and_run(&client, |builder| {
                builder.add_custom_global_account_data(json!({
                    "type": super::CATALOG_V3,
                    "content": { "profiles": [{ "id": "kris", "displayname": "Kris" }] }
                }));
            })
            .await;
        let (core, _events) =
            Core::new("offline-personas", Box::new(MemorySessionStore::default()));
        *core.session.write().await = Some(Session {
            account_id: "test".into(),
            client: client.clone(),
            sync_service: Arc::new(SyncService::builder(client.clone()).build().await.unwrap()),
            homeserver: server.server().uri(),
            oauth: false,
        });
        let _unreachable = Mock::given(method("GET"))
            .and(path_regex("/account_data/"))
            .respond_with(ResponseTemplate::new(500))
            .mount_as_scoped(server.server())
            .await;

        let catalog = core.personas().await.unwrap();

        assert_eq!(catalog.personas.len(), 1);
        assert_eq!(catalog.personas[0].id, "kris");
    }
}
