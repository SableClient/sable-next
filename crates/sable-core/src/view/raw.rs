use matrix_sdk_ui::timeline::EventTimelineItem;
use serde::Deserialize as _;
use serde_with::DeserializeAs;

use super::content::raw_formatted_body;
use super::media::spoiler_reason;

/// Narrow so serde skips the rest of the event; a whole-event `Value`
/// materialises every `formatted_body`.
#[derive(Default, serde::Deserialize)]
pub(super) struct RawFields {
    pub(super) sender: Option<String>,
    pub(super) content: Option<serde_json::Value>,
    pub(super) unsigned: Option<RawUnsigned>,
    #[serde(skip)]
    pub(super) original_content: Option<serde_json::Value>,
    #[serde(skip)]
    pub(super) echo_formatted_body: Option<String>,
    #[serde(skip)]
    pub(super) echo_spoiler: Option<String>,
    #[serde(skip)]
    pub(super) echo_gallery_spoilers: Vec<Option<String>>,
}

#[derive(serde::Deserialize)]
pub(super) struct RawUnsigned {
    prev_content: Option<serde_json::Value>,
    redacted_because: Option<RawRedaction>,
}

#[derive(serde::Deserialize)]
pub(super) struct RawRedaction {
    sender: Option<String>,
    content: Option<RawRedactionContent>,
}

#[derive(serde::Deserialize)]
pub(super) struct RawRedactionContent {
    reason: Option<String>,
}

impl RawFields {
    /// An edit replaces the content, carrying its own profile, so the latest
    /// event wins over the original.
    pub(super) fn read(event: &EventTimelineItem) -> Self {
        event
            .latest_json()
            .or_else(|| event.original_json())
            .and_then(|raw| raw.deserialize_as_unchecked::<Self>().ok())
            .unwrap_or_default()
    }

    /// A state event's previous content, which is the only source for an event
    /// type the SDK has no typed content for.
    pub(super) fn prev_content(&self) -> Option<&serde_json::Value> {
        self.unsigned.as_ref()?.prev_content.as_ref()
    }

    pub(super) fn content_stripped(&self) -> bool {
        self.content
            .as_ref()
            .and_then(serde_json::Value::as_object)
            .is_some_and(serde_json::Map::is_empty)
    }

    pub(super) fn message(&self) -> Option<&serde_json::Value> {
        let content = self.content.as_ref();
        let replacement = content
            .and_then(|content| content.get("m.relates_to"))
            .and_then(|relation| relation.get("rel_type"))
            .and_then(serde_json::Value::as_str)
            == Some("m.replace");
        if replacement {
            content.and_then(|content| content.get("m.new_content"))
        } else {
            content
        }
    }

    pub(super) fn formatted_body(&self) -> Option<&str> {
        raw_formatted_body(self.message()).or(self.echo_formatted_body.as_deref())
    }

    pub(super) fn external_url(&self) -> Option<String> {
        self.message()?
            .get("external_url")?
            .as_str()
            .map(str::to_owned)
    }

    pub(super) fn spoiler_reason(&self) -> Option<String> {
        spoiler_reason(self.message()).or_else(|| self.echo_spoiler.clone())
    }

    pub(super) fn gallery_spoiler_reason(&self, index: usize) -> Option<String> {
        let item = self
            .content
            .as_ref()
            .and_then(|content| content.get("itemtypes"))
            .and_then(|items| items.get(index));
        spoiler_reason(item).or_else(|| self.echo_gallery_spoilers.get(index).cloned().flatten())
    }

    pub(super) fn redacted_by(&self) -> Option<String> {
        let redactor = self
            .unsigned
            .as_ref()?
            .redacted_because
            .as_ref()?
            .sender
            .as_deref()?;
        self.sender
            .as_deref()
            .is_some_and(|author| author != redactor)
            .then(|| redactor.to_owned())
    }

    pub(super) fn redaction_reason(&self) -> Option<String> {
        self.unsigned
            .as_ref()?
            .redacted_because
            .as_ref()?
            .content
            .as_ref()?
            .reason
            .as_deref()
            .filter(|reason| !reason.trim().is_empty())
            .map(ToOwned::to_owned)
    }
}

/// A field that is an object reads as `T`; anything else reads as missing.
pub(crate) struct ObjectOnly;

impl<'de, T: serde::de::DeserializeOwned> DeserializeAs<'de, Option<T>> for ObjectOnly {
    fn deserialize_as<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Option<T>, D::Error> {
        let value = serde_json::Value::deserialize(deserializer)?;
        Ok(value
            .is_object()
            .then(|| serde_json::from_value(value).ok())
            .flatten())
    }
}

/// A present value reads as `T` when it is an object and as its default otherwise.
pub(super) struct ObjectOrDefault;

impl<'de, T: serde::de::DeserializeOwned + Default> DeserializeAs<'de, Option<T>>
    for ObjectOrDefault
{
    fn deserialize_as<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Option<T>, D::Error> {
        Ok(Some(
            ObjectOnly::deserialize_as(deserializer)?.unwrap_or_default(),
        ))
    }
}

/// A field that is present, whatever it holds.
pub(super) fn present<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<bool, D::Error> {
    serde::de::IgnoredAny::deserialize(deserializer).map(|_| true)
}
