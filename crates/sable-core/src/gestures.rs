use matrix_sdk::ruma::{OwnedRoomId, OwnedUserId};
use serde_json::{Value, json};

use crate::protocol::{CommandErr, GestureView};
use crate::{Core, ResultExt};

fn mentions(target: Option<&OwnedUserId>) -> Value {
    json!({ "user_ids": target.into_iter().collect::<Vec<_>>() })
}

/// The cute events `FluffyChat` sends, and the `fyi.cisnt.headpat` emote clients without
/// support still show as text.
pub(crate) fn gesture_content(gesture: GestureView, target: Option<&OwnedUserId>) -> Value {
    let cute = |kind: &str, body: &str| {
        json!({
            "msgtype": "im.fluffychat.cute_event",
            "m.mentions": mentions(target),
            "cute_type": kind,
            "body": body,
        })
    };
    match gesture {
        GestureView::Hug => cute("hug", "🤗"),
        GestureView::Cuddle => cute("cuddle", "😊"),
        GestureView::Wave => cute("wave", "👋"),
        GestureView::Poke => cute("poke", "🫵"),
        GestureView::Headpat => json!({
            "msgtype": "m.emote",
            "m.mentions": mentions(target),
            "body": format!("pats {}", target.map_or("you", |user| user.as_str())),
            "fyi.cisnt.headpat": true,
        }),
    }
}

impl Core {
    pub(crate) async fn send_gesture(
        &self,
        room_id: &OwnedRoomId,
        gesture: GestureView,
        target: Option<&OwnedUserId>,
    ) -> Result<(), CommandErr> {
        self.room(room_id)
            .await?
            .send_raw("m.room.message", gesture_content(gesture, target))
            .await
            .or_failed(self, "send_gesture")?;
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
            gesture_content(GestureView::Hug, Some(&target)),
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
            gesture_content(GestureView::Headpat, None),
            json!({
                "msgtype": "m.emote",
                "m.mentions": { "user_ids": [] },
                "body": "pats you",
                "fyi.cisnt.headpat": true,
            })
        );
    }
}
