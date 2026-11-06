use sable_model::text::visible_name;

use matrix_sdk::room::RoomMember;
use matrix_sdk::ruma::Int;
use matrix_sdk::ruma::UserId;
use matrix_sdk::ruma::events::room::member::{MembershipState, OriginalSyncRoomMemberEvent};
use matrix_sdk::ruma::events::room::power_levels::{RoomPowerLevels, UserPowerLevel};
use matrix_sdk::ruma::events::{MessageLikeEventType, StateEventType};

use crate::protocol::{MemberView, MembershipView, RoomPermissionsView, RoomPowerLevelsView};

#[must_use]
pub fn member_view(member: &RoomMember, nicknames: &crate::nicknames::Nicknames) -> MemberView {
    let real_name = member
        .display_name()
        .and_then(visible_name)
        .map(str::to_owned);
    let real_avatar_url = member.avatar_url().map(ToString::to_string);
    let mut view = MemberView {
        user_id: member.user_id().to_owned(),
        display_name: None,
        avatar_url: None,
        real_name,
        real_avatar_url,
        power_level: clamp_power_level(member.power_level()),
        membership: membership_view(member.membership()),
        member_ts: member.event().timestamp().map(u64::from),
        kicked: matches!(member.membership(), MembershipState::Leave)
            && member.event().sender() != member.user_id(),
        service: member.is_service_member(),
    };
    nicknames.apply_member(&mut view);
    view
}

/// Builds the view from the event itself, since sliding sync leaves a timeline member event out of
/// the stored member list.
#[must_use]
pub fn member_event_view(
    event: &OriginalSyncRoomMemberEvent,
    power_levels: Option<&RoomPowerLevels>,
    service: bool,
    nicknames: &crate::nicknames::Nicknames,
) -> Option<MemberView> {
    let user_id = UserId::parse(&event.state_key).ok()?;
    let membership = &event.content.membership;
    let mut view = MemberView {
        power_level: power_levels.map_or(0, |levels| clamp_power_level(levels.for_user(&user_id))),
        real_name: event
            .content
            .displayname
            .as_deref()
            .and_then(visible_name)
            .map(str::to_owned),
        real_avatar_url: event.content.avatar_url.as_ref().map(ToString::to_string),
        display_name: None,
        avatar_url: None,
        membership: membership_view(membership),
        member_ts: Some(u64::from(event.origin_server_ts.get())),
        kicked: matches!(membership, MembershipState::Leave) && event.sender != user_id,
        service,
        user_id,
    };
    nicknames.apply_member(&mut view);
    Some(view)
}

const fn membership_view(state: &MembershipState) -> MembershipView {
    match state {
        MembershipState::Join => MembershipView::Join,
        MembershipState::Invite => MembershipView::Invite,
        MembershipState::Knock => MembershipView::Knock,
        MembershipState::Ban => MembershipView::Ban,
        _ => MembershipView::Leave,
    }
}

#[must_use]
pub fn room_permissions(
    power_levels: &RoomPowerLevels,
    user_id: &UserId,
    encrypted: bool,
) -> RoomPermissionsView {
    let message_type = if encrypted {
        MessageLikeEventType::RoomEncrypted
    } else {
        MessageLikeEventType::RoomMessage
    };
    RoomPermissionsView {
        own_power_level: clamp_power_level(power_levels.for_user(user_id)),
        can_post: power_levels.user_can_send_message(user_id, message_type),
        can_react: power_levels.user_can_send_message(user_id, MessageLikeEventType::Reaction),
        can_redact_own: power_levels.user_can_redact_own_event(user_id),
        can_redact_others: power_levels.user_can_redact_event_of_other(user_id),
        can_invite: power_levels.user_can_invite(user_id),
        can_kick: power_levels.user_can_kick(user_id),
        can_ban: power_levels.user_can_ban(user_id),
        can_change_settings: power_levels.user_can_send_state(user_id, StateEventType::RoomName),
        can_pin: power_levels.user_can_send_state(user_id, StateEventType::RoomPinnedEvents),
        can_change_join_rule: power_levels
            .user_can_send_state(user_id, StateEventType::RoomJoinRules),
        can_change_power_levels: power_levels
            .user_can_send_state(user_id, StateEventType::RoomPowerLevels),
        can_manage_children: power_levels.user_can_send_state(user_id, StateEventType::SpaceChild),
    }
}

pub(crate) fn clamp_power_level(level: UserPowerLevel) -> i64 {
    match level {
        UserPowerLevel::Int(level) => i64::from(level),
        _ => i64::from(Int::MAX) + 1,
    }
}

#[must_use]
pub fn room_power_levels(power_levels: &RoomPowerLevels) -> RoomPowerLevelsView {
    RoomPowerLevelsView {
        ban: i64::from(power_levels.ban),
        kick: i64::from(power_levels.kick),
        redact: i64::from(power_levels.redact),
        invite: i64::from(power_levels.invite),
        events_default: i64::from(power_levels.events_default),
        state_default: i64::from(power_levels.state_default),
        users_default: i64::from(power_levels.users_default),
        events: power_levels
            .events
            .iter()
            .map(|(event_type, level)| (event_type.to_string(), i64::from(*level)))
            .collect(),
        users: power_levels
            .users
            .iter()
            .map(|(user_id, level)| (user_id.to_string(), i64::from(*level)))
            .collect(),
        notifications_room: i64::from(power_levels.notifications.room),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use serde_json::json;

    use matrix_sdk::ruma::events::room::power_levels::UserPowerLevel;

    #[test]
    fn posting_in_an_encrypted_room_needs_the_encrypted_level() {
        use matrix_sdk::ruma::events::room::power_levels::{
            RoomPowerLevels, RoomPowerLevelsEventContent,
        };

        let content: RoomPowerLevelsEventContent = serde_json::from_value(json!({
            "events": {"m.room.message": 0, "m.room.encrypted": 50},
        }))
        .unwrap();
        let levels = RoomPowerLevels::new(
            content.into(),
            &matrix_sdk::ruma::room_version_rules::AuthorizationRules::V1,
            [],
        );
        let user = matrix_sdk::ruma::user_id!("@user:example.org");
        assert!(room_permissions(&levels, user, false).can_post);
        assert!(!room_permissions(&levels, user, true).can_post);
    }

    #[test]
    fn power_levels_keep_every_matrix_integer() {
        use matrix_sdk::ruma::events::room::power_levels::{
            RoomPowerLevels, RoomPowerLevelsEventContent,
        };

        let content = json!({
            "ban": 9_007_199_254_740_991_i64,
            "kick": -9_007_199_254_740_991_i64,
            "redact": 3_000_000_000_i64,
            "invite": -3_000_000_000_i64,
            "events_default": 4_000_000_000_i64,
            "state_default": -4_000_000_000_i64,
            "users_default": 5_000_000_000_i64,
            "events": {"m.room.name": 6_000_000_000_i64},
            "users": {"@admin:example.org": -6_000_000_000_i64},
            "notifications": {"room": 7_000_000_000_i64}
        });
        let levels: RoomPowerLevelsEventContent = serde_json::from_value(content.clone()).unwrap();
        let view = room_power_levels(&RoomPowerLevels::new(
            levels.into(),
            &matrix_sdk::ruma::room_version_rules::AuthorizationRules::V1,
            [],
        ));
        let mut actual = serde_json::to_value(view).unwrap();
        let room = actual
            .as_object_mut()
            .unwrap()
            .remove("notifications_room")
            .unwrap();
        actual["notifications"] = json!({"room": room});
        assert_eq!(actual, content);
    }

    #[test]
    fn keeps_every_power_level_and_ranks_infinite_above_them() {
        use matrix_sdk::ruma::Int;

        assert_eq!(clamp_power_level(UserPowerLevel::Int(Int::from(50))), 50);
        assert_eq!(
            clamp_power_level(UserPowerLevel::Int(Int::from(i32::MAX))),
            i64::from(i32::MAX)
        );
        assert_eq!(
            clamp_power_level(UserPowerLevel::Int(Int::MAX)),
            i64::from(Int::MAX)
        );
        assert_eq!(
            clamp_power_level(UserPowerLevel::Int(Int::MIN)),
            i64::from(Int::MIN)
        );
        assert!(clamp_power_level(UserPowerLevel::Infinite) > i64::from(Int::MAX));
    }
}
