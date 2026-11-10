use std::sync::Arc;

use matrix_sdk::ruma::OwnedRoomId;
use matrix_sdk::ruma::api::client::state::get_state_events;
use matrix_sdk::ruma::events::room::avatar::RoomAvatarEventContent;
use matrix_sdk::ruma::events::room::topic::RoomTopicEventContent;
use matrix_sdk::ruma::serde::Raw;
use serde::{Deserialize, Serialize};
use sable_model::bot_commands::BotCommand;

use super::{Handler, Json};
use crate::protocol::{AbbreviationView, RpcError, HistoryVisibilityView, PresenceHintView, JoinRuleView, RoomStateEventView};
use crate::{Core, ResultExt, account_data, presence};
use crate::media::mxc_uri;
use crate::room_settings::AclEdit;

domain! {
    set_name,
    set_topic,
    set_avatar,
    set_join_rule,
    history_visibility,
    set_history_visibility,
    enable_encryption,
    banner,
    set_banner,
    member_list_threshold,
    set_member_list_threshold,
    presence_hint,
    set_presence_hint,
    update_server_acl,
    abbreviations,
    set_abbreviations,
    event,
    events,
    events_raw,
    full_state,
    send_event,
    account_data,
    account_data_types,
    set_account_data,
    account_data_raw,
    add_widget,
    remove_widget,
    bot_commands,
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct SetNameParams {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub room_id: OwnedRoomId,
    #[serde(default)]
    pub name: Option<String>,
}

impl Handler for SetNameParams {
    type Ok = ();

    async fn run(self, core: &Arc<Core>) -> Result<(), RpcError> {
        // The spec clears a name with an empty one.
        core.room(&self.room_id)
            .await?
            .set_name(self.name.unwrap_or_default())
            .await
            .or_failed(core, "set_room_name")?;
        Ok(())
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct SetTopicParams {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub room_id: OwnedRoomId,
    pub topic: String,
}

pub(crate) fn topic_content(topic: &str) -> RoomTopicEventContent {
    match sable_model::markdown::markdown_to_content(topic, &[]).formatted_body {
        Some(html) => RoomTopicEventContent::html(topic, html),
        None => RoomTopicEventContent::new(topic.to_owned()),
    }
}

impl Handler for SetTopicParams {
    type Ok = ();

    async fn run(self, core: &Arc<Core>) -> Result<(), RpcError> {
        core.room(&self.room_id)
            .await?
            .send_state_event(topic_content(&self.topic))
            .await
            .or_failed(core, "set_room_topic")?;
        Ok(())
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct SetAvatarParams {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub room_id: OwnedRoomId,
    #[serde(default)]
    pub url: Option<String>,
}

impl Handler for SetAvatarParams {
    type Ok = ();

    async fn run(self, core: &Arc<Core>) -> Result<(), RpcError> {
        let room = core.room(&self.room_id).await?;

        match self.url {
            Some(url) => {
                room.set_avatar_url(&mxc_uri(&url)?, None)
                    .await
                    .or_failed(core, "set_room_avatar")?;
            }
            // State cannot be deleted, so empty content is the removal.
            None => {
                room.send_state_event(RoomAvatarEventContent::new())
                    .await
                    .or_failed(core, "clear_room_avatar")?;
            }
        }

        Ok(())
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct SetJoinRuleParams {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub room_id: OwnedRoomId,
    pub rule: JoinRuleView,
}

impl Handler for SetJoinRuleParams {
    type Ok = ();

    async fn run(self, core: &Arc<Core>) -> Result<(), RpcError> {
        core.set_room_join_rule(&self.room_id, self.rule).await
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct HistoryVisibilityParams {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub room_id: OwnedRoomId,
}

impl Handler for HistoryVisibilityParams {
    type Ok = HistoryVisibilityView;

    async fn run(self, core: &Arc<Core>) -> Result<HistoryVisibilityView, RpcError> {
        core.history_visibility(&self.room_id).await
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct SetHistoryVisibilityParams {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub room_id: OwnedRoomId,
    pub visibility: HistoryVisibilityView,
}

impl Handler for SetHistoryVisibilityParams {
    type Ok = ();

    async fn run(self, core: &Arc<Core>) -> Result<(), RpcError> {
        core.set_history_visibility(self)
            .await
    }
}

/// Cannot be undone.
#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct EnableEncryptionParams {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub room_id: OwnedRoomId,
}

impl Handler for EnableEncryptionParams {
    type Ok = ();

    async fn run(self, core: &Arc<Core>) -> Result<(), RpcError> {
        core.enable_encryption(self).await
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct BannerParams {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub room_id: OwnedRoomId,
}

impl Handler for BannerParams {
    type Ok = Option<String>;

    async fn run(self, core: &Arc<Core>) -> Result<Option<String>, RpcError> {
        core.room_banner(&self.room_id).await
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct SetBannerParams {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub room_id: OwnedRoomId,
    #[serde(default)]
    pub url: Option<String>,
}

impl Handler for SetBannerParams {
    type Ok = ();

    async fn run(self, core: &Arc<Core>) -> Result<(), RpcError> {
        core.set_room_banner(self.room_id, self.url.as_deref())
            .await
    }
}

/// The power level from which members are listed whatever their presence.
#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct MemberListThresholdParams {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub room_id: OwnedRoomId,
}

#[derive(Debug, Serialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
#[serde(transparent)]
pub struct MemberListThresholdOk(
    #[cfg_attr(feature = "typegen", specta(type = Option<specta_typescript::Number>))]
    pub  Option<i64>,
);

impl Handler for MemberListThresholdParams {
    type Ok = MemberListThresholdOk;

    async fn run(self, core: &Arc<Core>) -> Result<MemberListThresholdOk, RpcError> {
        core.member_list_threshold(&self.room_id)
            .await
            .map(MemberListThresholdOk)
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct SetMemberListThresholdParams {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub room_id: OwnedRoomId,
    #[cfg_attr(feature = "typegen", specta(type = Option<specta_typescript::Number>))]
    #[serde(default)]
    pub always_listed_from: Option<i64>,
}

impl Handler for SetMemberListThresholdParams {
    type Ok = ();

    async fn run(self, core: &Arc<Core>) -> Result<(), RpcError> {
        core.set_member_list_threshold(self)
            .await
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct PresenceHintParams {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub room_id: OwnedRoomId,
}

impl Handler for PresenceHintParams {
    type Ok = PresenceHintView;

    async fn run(self, core: &Arc<Core>) -> Result<PresenceHintView, RpcError> {
        core.presence_hint(&self.room_id).await
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct SetPresenceHintParams {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub room_id: OwnedRoomId,
    pub hint: PresenceHintView,
}

impl Handler for SetPresenceHintParams {
    type Ok = ();

    async fn run(self, core: &Arc<Core>) -> Result<(), RpcError> {
        core.set_presence_hint(self.room_id, self.hint).await
    }
}

/// Server globs to add to and remove from each list.
#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct UpdateServerAclParams {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub room_id: OwnedRoomId,
    pub allow: Vec<String>,
    pub deny: Vec<String>,
    pub remove_allow: Vec<String>,
    pub remove_deny: Vec<String>,
}

impl Handler for UpdateServerAclParams {
    type Ok = ();

    async fn run(self, core: &Arc<Core>) -> Result<(), RpcError> {
        let edit = AclEdit {
            allow: self.allow,
            deny: self.deny,
            remove_allow: self.remove_allow,
            remove_deny: self.remove_deny,
        };
        core.update_server_acl(self.room_id, &edit).await
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct AbbreviationsParams {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub room_id: OwnedRoomId,
}

impl Handler for AbbreviationsParams {
    type Ok = Vec<AbbreviationView>;

    async fn run(self, core: &Arc<Core>) -> Result<Vec<AbbreviationView>, RpcError> {
        core.room_abbreviations(&self.room_id).await
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct SetAbbreviationsParams {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub room_id: OwnedRoomId,
    pub entries: Vec<AbbreviationView>,
}

impl Handler for SetAbbreviationsParams {
    type Ok = ();

    async fn run(self, core: &Arc<Core>) -> Result<(), RpcError> {
        core.set_room_abbreviations(self.room_id, &self.entries)
            .await
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct EventParams {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub room_id: OwnedRoomId,
    pub event_type: String,
    pub state_key: String,
}

impl Handler for EventParams {
    type Ok = Option<Json>;

    async fn run(self, core: &Arc<Core>) -> Result<Option<Json>, RpcError> {
        core.room_state_event_content(self.room_id, self.event_type, self.state_key)
            .await
            .map(|content| content.map(Json))
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct EventsParams {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub room_id: OwnedRoomId,
    pub event_type: String,
}

impl Handler for EventsParams {
    type Ok = Vec<RoomStateEventView>;

    async fn run(self, core: &Arc<Core>) -> Result<Vec<RoomStateEventView>, RpcError> {
        core.room_state_events(&self.room_id, &self.event_type)
            .await
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct EventsRawParams {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub room_id: OwnedRoomId,
    pub event_type: String,
    #[serde(default)]
    pub state_key: Option<String>,
}

impl Handler for EventsRawParams {
    type Ok = Vec<Json>;

    async fn run(self, core: &Arc<Core>) -> Result<Vec<Json>, RpcError> {
        core.room_state_events_raw(&self.room_id, &self.event_type, self.state_key.as_deref())
            .await
            .map(|events| events.into_iter().map(Json).collect())
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct FullStateParams {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub room_id: OwnedRoomId,
}

impl Handler for FullStateParams {
    type Ok = Vec<Json>;

    async fn run(self, core: &Arc<Core>) -> Result<Vec<Json>, RpcError> {
        let client = core.client().await?;
        let response = client
            .send(get_state_events::v3::Request::new(self.room_id))
            .await
            .or_failed(core, "room_full_state")?;
        Ok(response
            .room_state
            .iter()
            .filter_map(|raw| raw.deserialize_as::<serde_json::Value>().ok())
            .map(Json)
            .collect())
    }
}

/// Escape hatch for unmodelled state. `content` is validated only by the
/// server, so prefer a typed command.
#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct SendEventParams {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub room_id: OwnedRoomId,
    pub event_type: String,
    pub state_key: String,
    #[cfg_attr(feature = "typegen", specta(type = specta_typescript::Unknown))]
    pub content: serde_json::Value,
}

impl Handler for SendEventParams {
    type Ok = String;

    async fn run(self, core: &Arc<Core>) -> Result<String, RpcError> {
        core.send_state(self.room_id, &self.event_type, &self.state_key, &self.content)
            .await
            .map(|event_id| event_id.to_string())
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct AccountDataParams {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub room_id: OwnedRoomId,
    pub event_type: String,
}

impl Handler for AccountDataParams {
    type Ok = Option<Json>;

    async fn run(self, core: &Arc<Core>) -> Result<Option<Json>, RpcError> {
        let room = core.room(&self.room_id).await?;
        let event = core
            .with_open_stores(async || room.account_data(self.event_type.into()).await)
            .await
            .or_failed(core, "room_account_data")?;

        Ok(event
            .and_then(|raw| raw.get_field::<serde_json::Value>("content").ok().flatten())
            .map(Json))
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct AccountDataTypesParams {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub room_id: OwnedRoomId,
}

impl Handler for AccountDataTypesParams {
    type Ok = Vec<String>;

    async fn run(self, core: &Arc<Core>) -> Result<Vec<String>, RpcError> {
        let client = core.client().await?;
        let types = account_data::room_server_types(
            &client,
            &self.room_id,
            presence::state(core.desired_presence()),
        )
        .await
        .or_failed(core, "room_account_data_types")?;
        Ok(types.into_iter().collect())
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct SetAccountDataParams {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub room_id: OwnedRoomId,
    pub event_type: String,
    #[cfg_attr(feature = "typegen", specta(type = specta_typescript::Unknown))]
    pub content: serde_json::Value,
}

impl Handler for SetAccountDataParams {
    type Ok = ();

    async fn run(self, core: &Arc<Core>) -> Result<(), RpcError> {
        let raw = Raw::new(&self.content)
            .or_failed(core, "set_room_account_data")?
            .cast_unchecked();
        core.room(&self.room_id)
            .await?
            .set_account_data_raw(self.event_type.into(), raw)
            .await
            .or_failed(core, "set_room_account_data")?;
        Ok(())
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct AccountDataRawParams {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub room_id: OwnedRoomId,
    pub event_type: String,
}

impl Handler for AccountDataRawParams {
    type Ok = Option<Json>;

    async fn run(self, core: &Arc<Core>) -> Result<Option<Json>, RpcError> {
        core.room_account_data_raw(&self.room_id, &self.event_type)
            .await
            .map(|content| content.map(Json))
    }
}

/// A custom widget whose URL is given the template variables hosts fill in.
#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct AddWidgetParams {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub room_id: OwnedRoomId,
    pub name: String,
    pub url: String,
}

impl Handler for AddWidgetParams {
    type Ok = String;

    async fn run(self, core: &Arc<Core>) -> Result<String, RpcError> {
        core.add_room_widget(self.room_id, &self.name, &self.url)
            .await
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct RemoveWidgetParams {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub room_id: OwnedRoomId,
    pub widget_id: String,
}

impl Handler for RemoveWidgetParams {
    type Ok = ();

    async fn run(self, core: &Arc<Core>) -> Result<(), RpcError> {
        core.remove_room_widget(self.room_id, &self.widget_id)
            .await
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct BotCommandsParams {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub room_id: OwnedRoomId,
}

impl Handler for BotCommandsParams {
    type Ok = Vec<BotCommand>;

    async fn run(self, core: &Arc<Core>) -> Result<Vec<BotCommand>, RpcError> {
        let client = core.client().await?;
        let room = core.room(&self.room_id).await?;
        let mut commands = core
            .bot_commands_for(&client, &room)
            .await
            .or_failed(core, "bot_commands")?;
        let nicknames = core.nicknames();
        for command in &mut commands {
            nicknames.apply_bot(command);
        }
        Ok(commands)
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::topic_content;

    #[test]
    fn a_formatted_topic_carries_html_beside_its_plain_text() {
        assert_eq!(
            serde_json::to_value(topic_content("**Rules** at https://example.org")).unwrap(),
            json!({
                "topic": "**Rules** at https://example.org",
                "m.topic": { "m.text": [
                    { "mimetype": "text/html", "body": "<strong>Rules</strong> at https://example.org" },
                    { "body": "**Rules** at https://example.org" },
                ] },
            })
        );
    }

    #[test]
    fn a_plain_topic_carries_only_plain_text() {
        assert_eq!(
            serde_json::to_value(topic_content("Chat")).unwrap(),
            json!({ "topic": "Chat", "m.topic": { "m.text": [{ "body": "Chat" }] } })
        );
    }
}
