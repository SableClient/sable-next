use matrix_sdk::ruma::{OwnedRoomId, TransactionId};
use serde_json::json;
use url::Url;

use crate::Core;
use crate::protocol::CommandErr;

const WIDGET_STATE_TYPE: &str = "im.vector.modular.widgets";

/// The variables a widget host substitutes, so a bare URL learns who is
/// looking at it the way an integration manager's widgets do.
const TEMPLATE_PARAMS: &str = "matrix_user_id=$matrix_user_id\
    &matrix_display_name=$matrix_display_name\
    &matrix_avatar_url=$matrix_avatar_url\
    &matrix_room_id=$matrix_room_id\
    &matrix_widget_id=$matrix_widget_id\
    &theme=$org.matrix.msc2873.client_theme\
    &matrix_client_id=$org.matrix.msc2873.client_id\
    &matrix_client_language=$org.matrix.msc2873.client_language\
    &matrix_device_id=$org.matrix.msc3819.matrix_device_id\
    &matrix_base_url=$org.matrix.msc4039.matrix_base_url";

/// A URL that already names a template variable is left as its author wrote it.
pub(crate) fn enrich_widget_url(url: &Url) -> String {
    let raw = url.as_str();
    if raw.contains("$matrix_") || raw.contains("$org.matrix.") {
        return raw.to_owned();
    }
    let continues_a_query = url
        .fragment()
        .map_or_else(|| url.query().is_some(), |fragment| fragment.contains('?'));
    let separator = if continues_a_query { '&' } else { '?' };
    format!("{raw}{separator}{TEMPLATE_PARAMS}")
}

pub(crate) fn widget_url(raw: &str) -> Option<Url> {
    Url::parse(raw)
        .ok()
        .filter(|url| matches!(url.scheme(), "http" | "https"))
}

impl Core {
    pub(crate) async fn add_room_widget(
        &self,
        room_id: OwnedRoomId,
        name: &str,
        url: &str,
    ) -> Result<String, CommandErr> {
        let url = widget_url(url).ok_or(CommandErr::InvalidUrl)?;
        let user_id = self
            .client()
            .await?
            .user_id()
            .ok_or(CommandErr::NotLoggedIn)?
            .to_owned();
        let id = TransactionId::new().to_string();
        let content = json!({
            "type": "m.custom",
            "url": enrich_widget_url(&url),
            "name": name,
            "id": id,
            "creatorUserId": user_id,
        });
        self.send_state(room_id, WIDGET_STATE_TYPE, &id, &content)
            .await?;
        Ok(id)
    }

    pub(crate) async fn remove_room_widget(
        &self,
        room_id: OwnedRoomId,
        widget_id: &str,
    ) -> Result<(), CommandErr> {
        self.send_state(room_id, WIDGET_STATE_TYPE, widget_id, &json!({}))
            .await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::{TEMPLATE_PARAMS, enrich_widget_url, widget_url};

    fn enriched(raw: &str) -> String {
        enrich_widget_url(&widget_url(raw).expect("valid url"))
    }

    #[test]
    fn the_parameters_follow_the_query_or_the_fragment() {
        assert_eq!(
            enriched("https://w.example/app"),
            format!("https://w.example/app?{TEMPLATE_PARAMS}")
        );
        assert_eq!(
            enriched("https://w.example/app?x=1"),
            format!("https://w.example/app?x=1&{TEMPLATE_PARAMS}")
        );
        assert_eq!(
            enriched("https://w.example/#/room"),
            format!("https://w.example/#/room?{TEMPLATE_PARAMS}")
        );
        assert_eq!(
            enriched("https://w.example/#/room?x=1"),
            format!("https://w.example/#/room?x=1&{TEMPLATE_PARAMS}")
        );
    }

    #[test]
    fn a_templated_url_is_left_alone() {
        let raw = "https://w.example/app?room=$matrix_room_id";
        assert_eq!(enriched(raw), raw);
    }

    #[test]
    fn only_web_urls_can_be_widgets() {
        assert!(widget_url("https://w.example").is_some());
        assert!(widget_url("javascript:alert(1)").is_none());
        assert!(widget_url("not a url").is_none());
    }
}
