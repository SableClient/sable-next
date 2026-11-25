use matrix_sdk::ruma::{OwnedRoomId, OwnedUserId};
use serde::Serialize;

use crate::ResultExt;
use crate::SignedIn;
use crate::protocol::{GestureView, RpcError};

#[derive(Serialize)]
pub(crate) struct MentionsOut {
    user_ids: Vec<OwnedUserId>,
}

fn mentions(target: Option<&OwnedUserId>) -> MentionsOut {
    MentionsOut {
        user_ids: target.into_iter().cloned().collect(),
    }
}

#[derive(Serialize)]
#[serde(rename_all = "snake_case")]
enum CuteType {
    Hug,
    Cuddle,
    Wave,
    Poke,
}

#[derive(Serialize)]
#[serde(tag = "msgtype")]
enum GestureKind {
    #[serde(rename = "im.fluffychat.cute_event")]
    CuteEvent { cute_type: CuteType },
    #[serde(rename = "m.emote")]
    Headpat {
        #[serde(rename = "fyi.cisnt.headpat")]
        headpat: bool,
    },
}

#[derive(Serialize)]
pub(crate) struct GestureOut {
    #[serde(rename = "m.mentions")]
    mentions: MentionsOut,
    body: String,
    #[serde(flatten)]
    kind: GestureKind,
}

/// The cute events `FluffyChat` sends, and the `fyi.cisnt.headpat` emote clients without
/// support still show as text.
pub(crate) fn gesture_content(gesture: GestureView, target: Option<&OwnedUserId>) -> GestureOut {
    let cute = |cute_type, body: &str| GestureOut {
        mentions: mentions(target),
        body: body.to_owned(),
        kind: GestureKind::CuteEvent { cute_type },
    };
    match gesture {
        GestureView::Hug => cute(CuteType::Hug, "🤗"),
        GestureView::Cuddle => cute(CuteType::Cuddle, "😊"),
        GestureView::Wave => cute(CuteType::Wave, "👋"),
        GestureView::Poke => cute(CuteType::Poke, "🫵"),
        GestureView::Headpat => GestureOut {
            mentions: mentions(target),
            body: format!("pats {}", target.map_or("you", |user| user.as_str())),
            kind: GestureKind::Headpat { headpat: true },
        },
    }
}

impl SignedIn {
    pub(crate) async fn send_gesture(
        &self,
        room_id: &OwnedRoomId,
        gesture: GestureView,
        target: Option<&OwnedUserId>,
        persona: Option<&crate::protocol::PerMessageProfileView>,
    ) -> Result<(), RpcError> {
        let mut content = serde_json::to_value(gesture_content(gesture, target))
            .or_failed(self.core(), "send_gesture")?;
        if let Some(profile) = persona {
            crate::personas::stamp_profile(
                &mut content,
                &crate::personas::without_fallback(profile),
            );
        }
        self.room(room_id)?
            .send_raw("m.room.message", content)
            .await
            .or_failed(self.core(), "send_gesture")?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use matrix_sdk::ruma::owned_user_id;
    use serde_json::json;

    use super::gesture_content;
    use crate::protocol::GestureView;

    #[test]
    fn a_cute_event_mentions_its_target() {
        let target = owned_user_id!("@someone:example.org");

        assert_eq!(
            serde_json::to_value(gesture_content(GestureView::Hug, Some(&target))).unwrap(),
            json!({
                "msgtype": "im.fluffychat.cute_event",
                "m.mentions": { "user_ids": ["@someone:example.org"] },
                "cute_type": "hug",
                "body": "🤗",
            })
        );
    }

    #[test]
    fn a_headpat_without_a_target_pats_you() {
        assert_eq!(
            serde_json::to_value(gesture_content(GestureView::Headpat, None)).unwrap(),
            json!({
                "msgtype": "m.emote",
                "m.mentions": { "user_ids": [] },
                "body": "pats you",
                "fyi.cisnt.headpat": true,
            })
        );
    }
}
