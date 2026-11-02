//! The names and avatars the user gave other people, laid over every view.

use std::collections::HashMap;
use std::sync::Arc;

use matrix_sdk::executor::{JoinHandleExt, spawn};
use matrix_sdk::ruma::{OwnedUserId, UserId};

use crate::Core;
use sable_model::bot_commands::BotCommand;

use crate::protocol::{
    CoreEvent, InboxItemView, MemberView, NotificationView, OverrideTextView, ProfileOverrideView,
    ProfileView, RoomListItemView, TimelineItemContentView, TimelineItemView,
    UserDirectoryEntryView,
};

#[derive(Debug, Clone, PartialEq, Eq)]
enum Field {
    Set(String),
    Cleared,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct Nickname {
    name: Option<Field>,
    avatar: Option<Field>,
}

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Nicknames {
    entries: HashMap<OwnedUserId, Nickname>,
}

fn field(view: OverrideTextView) -> Option<Field> {
    match view {
        OverrideTextView::Set { value } => Some(Field::Set(value)),
        OverrideTextView::Cleared => Some(Field::Cleared),
        OverrideTextView::Unset => None,
    }
}

impl Nicknames {
    /// The user's own entry is dropped so their profile editor keeps their real name.
    pub(crate) fn from_overrides(
        overrides: Vec<ProfileOverrideView>,
        own_user_id: Option<&UserId>,
    ) -> Self {
        Self {
            entries: overrides
                .into_iter()
                .filter(|entry| Some(entry.user_id.as_ref()) != own_user_id)
                .filter_map(|entry| {
                    let nickname = Nickname {
                        name: field(entry.display_name),
                        avatar: field(entry.avatar),
                    };
                    (nickname != Nickname::default()).then_some((entry.user_id, nickname))
                })
                .collect(),
        }
    }

    /// `real` unless the user renamed `user_id`; a cleared name shows the id.
    pub(crate) fn name(&self, user_id: &UserId, real: Option<&str>) -> Option<String> {
        match self
            .entries
            .get(user_id)
            .and_then(|entry| entry.name.as_ref())
        {
            Some(Field::Set(name)) => Some(name.clone()),
            Some(Field::Cleared) => Some(user_id.to_string()),
            None => real.map(str::to_owned),
        }
    }

    pub(crate) fn avatar(&self, user_id: &UserId, real: Option<&str>) -> Option<String> {
        match self
            .entries
            .get(user_id)
            .and_then(|entry| entry.avatar.as_ref())
        {
            Some(Field::Set(avatar)) => Some(avatar.clone()),
            Some(Field::Cleared) => None,
            None => real.map(str::to_owned),
        }
    }

    pub(crate) fn changed(&self, other: &Self) -> Vec<OwnedUserId> {
        let mut changed: Vec<OwnedUserId> = self
            .entries
            .keys()
            .chain(other.entries.keys())
            .filter(|user_id| self.entries.get(*user_id) != other.entries.get(*user_id))
            .cloned()
            .collect();
        changed.sort();
        changed.dedup();
        changed
    }

    /// `item` must carry the server's names, as `RealNames::of` reads them.
    pub(crate) fn apply_item(&self, item: &mut TimelineItemView) {
        if let Some(sender) = item.sender.as_ref() {
            item.sender_name = self.name(sender, item.sender_name.as_deref());
            item.sender_avatar = self.avatar(sender, item.sender_avatar.as_deref());
        }
        if let Some(reply) = item.in_reply_to.as_mut()
            && let Some(sender) = reply.sender.as_ref()
        {
            reply.sender_name = self.name(sender, reply.sender_name.as_deref());
        }
        match &mut item.content {
            TimelineItemContentView::Membership {
                user_id,
                display_name,
                ..
            } => *display_name = self.name(user_id, display_name.as_deref()),
            TimelineItemContentView::ProfileChange {
                user_id,
                display_name: Some(change),
                ..
            } => change.old = self.name(user_id, change.old.as_deref()),
            _ => {}
        }
    }

    pub(crate) fn apply_member(&self, member: &mut MemberView) {
        member.display_name = self.name(&member.user_id, member.real_name.as_deref());
        member.avatar_url = self.avatar(&member.user_id, member.real_avatar_url.as_deref());
    }

    pub(crate) fn apply_profile(&self, profile: &mut ProfileView) {
        profile.display_name = self.name(&profile.user_id, profile.real_name.as_deref());
        profile.avatar_url = self.avatar(&profile.user_id, profile.real_avatar_url.as_deref());
    }

    pub(crate) fn apply_notification(&self, notification: &mut NotificationView) {
        let sender = &notification.sender;
        notification.sender_name = self.name(sender, notification.sender_name.as_deref());
        notification.sender_avatar_url =
            self.avatar(sender, notification.sender_avatar_url.as_deref());
        if notification.is_direct {
            notification.room_name = self
                .name(sender, Some(&notification.room_name))
                .unwrap_or_default();
        }
    }

    pub(crate) fn apply_inbox(&self, item: &mut InboxItemView) {
        if let Ok(sender) = UserId::parse(&item.sender) {
            item.sender_name = self.name(&sender, item.sender_name.as_deref());
        }
    }

    pub(crate) fn apply_directory_entry(&self, entry: &mut UserDirectoryEntryView) {
        if let Ok(user_id) = UserId::parse(&entry.user_id) {
            entry.display_name = self.name(&user_id, entry.real_name.as_deref());
            entry.avatar_url = self.avatar(&user_id, entry.real_avatar_url.as_deref());
        }
    }

    pub(crate) fn apply_bot(&self, command: &mut BotCommand) {
        if let Ok(sender) = UserId::parse(&command.sender) {
            command.sender_name = self.name(&sender, command.sender_name.as_deref());
            command.sender_avatar = self.avatar(&sender, command.sender_avatar.as_deref());
        }
    }

    pub fn apply_room(&self, room: &mut RoomListItemView) {
        let real_name = room
            .name
            .clone()
            .or_else(|| room.canonical_alias.clone())
            .unwrap_or_else(|| room.room_id.to_string());
        let peer = match room.direct_targets.as_slice() {
            [peer] if room.is_direct => Some(peer),
            _ => None,
        };
        (room.display_name, room.display_avatar_url) = match peer {
            Some(peer) => (
                self.name(peer, Some(&real_name)).unwrap_or(real_name),
                self.avatar(peer, room.avatar_url.as_deref()),
            ),
            None => (real_name, room.avatar_url.clone()),
        };
    }
}

/// The server's names for an item, so a nickname change can be laid over them again.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct RealNames {
    sender_name: Option<String>,
    sender_avatar: Option<String>,
    reply_sender_name: Option<String>,
    subject_name: Option<String>,
}

const fn subject_slot(item: &mut TimelineItemView) -> Option<&mut Option<String>> {
    match &mut item.content {
        TimelineItemContentView::Membership { display_name, .. } => Some(display_name),
        TimelineItemContentView::ProfileChange {
            display_name: Some(change),
            ..
        } => Some(&mut change.old),
        _ => None,
    }
}

impl RealNames {
    pub(crate) fn of(item: &TimelineItemView) -> Self {
        let subject_name = match &item.content {
            TimelineItemContentView::Membership { display_name, .. } => display_name.clone(),
            TimelineItemContentView::ProfileChange {
                display_name: Some(change),
                ..
            } => change.old.clone(),
            _ => None,
        };
        Self {
            sender_name: item.sender_name.clone(),
            sender_avatar: item.sender_avatar.clone(),
            reply_sender_name: item
                .in_reply_to
                .as_ref()
                .and_then(|reply| reply.sender_name.clone()),
            subject_name,
        }
    }

    pub(crate) fn restore(&self, item: &mut TimelineItemView) {
        item.sender_name.clone_from(&self.sender_name);
        item.sender_avatar.clone_from(&self.sender_avatar);
        if let Some(reply) = item.in_reply_to.as_mut() {
            reply.sender_name.clone_from(&self.reply_sender_name);
        }
        if let Some(slot) = subject_slot(item) {
            slot.clone_from(&self.subject_name);
        }
    }

    pub(crate) fn mentions(item: &TimelineItemView, users: &[OwnedUserId]) -> bool {
        let named = |user: Option<&OwnedUserId>| user.is_some_and(|user| users.contains(user));
        named(item.sender.as_ref())
            || named(
                item.in_reply_to
                    .as_ref()
                    .and_then(|reply| reply.sender.as_ref()),
            )
            || match &item.content {
                TimelineItemContentView::Membership { user_id, .. }
                | TimelineItemContentView::ProfileChange { user_id, .. } => named(Some(user_id)),
                _ => false,
            }
    }
}

pub(crate) fn reads_from(event_type: &str) -> bool {
    crate::profile_overrides::is_override_event(event_type)
        || event_type == crate::sealed_account_data::ADK_SECRET
}

impl Core {
    pub(crate) fn watch_nicknames(self: &Arc<Self>) {
        let core = self.clone();
        self.track_session_task(
            spawn(async move {
                loop {
                    core.reload_nicknames().await;
                    core.nicknames_stale.notified().await;
                }
            })
            .abort_on_drop(),
        );
    }

    pub(crate) fn nicknames(&self) -> Nicknames {
        self.nicknames.borrow().clone()
    }

    pub(crate) fn nickname_changes(&self) -> tokio::sync::watch::Receiver<Nicknames> {
        self.nicknames.subscribe()
    }

    pub(crate) async fn reload_nicknames(self: &Arc<Self>) {
        let Ok(view) = self.profile_overrides_view().await else {
            return;
        };
        let own_user_id = self
            .client()
            .await
            .ok()
            .and_then(|client| client.user_id().map(ToOwned::to_owned));
        let next = Nicknames::from_overrides(view.overrides, own_user_id.as_deref());
        let changed = self.nicknames.borrow().changed(&next);
        if changed.is_empty() {
            return;
        }
        self.nicknames.send_replace(next.clone());
        self.overlay_timeline_nicknames(&next, &changed).await;
        self.emit(CoreEvent::NicknamesChanged { user_ids: changed });
    }
}

#[cfg(test)]
mod tests {
    use matrix_sdk::ruma::user_id;

    use super::*;
    use crate::protocol::OverrideColorView;

    fn nicknames(entries: &[(&str, OverrideTextView, OverrideTextView)]) -> Nicknames {
        Nicknames::from_overrides(
            entries
                .iter()
                .map(|(user_id, name, avatar)| ProfileOverrideView {
                    user_id: OwnedUserId::try_from(*user_id).unwrap(),
                    display_name: name.clone(),
                    avatar: avatar.clone(),
                    color: OverrideColorView::Unset,
                })
                .collect(),
            Some(user_id!("@me:x")),
        )
    }

    fn set(value: &str) -> OverrideTextView {
        OverrideTextView::Set {
            value: value.to_owned(),
        }
    }

    #[test]
    fn a_nickname_replaces_the_name_and_a_cleared_one_shows_the_id() {
        let names = nicknames(&[
            ("@bob:x", set("Bobby"), OverrideTextView::Unset),
            (
                "@ann:x",
                OverrideTextView::Cleared,
                OverrideTextView::Cleared,
            ),
        ]);

        assert_eq!(
            names.name(user_id!("@bob:x"), Some("Bob")).as_deref(),
            Some("Bobby")
        );
        assert_eq!(
            names
                .avatar(user_id!("@bob:x"), Some("mxc://x/b"))
                .as_deref(),
            Some("mxc://x/b")
        );
        assert_eq!(
            names.name(user_id!("@ann:x"), Some("Ann")).as_deref(),
            Some("@ann:x")
        );
        assert_eq!(names.avatar(user_id!("@ann:x"), Some("mxc://x/a")), None);
        assert_eq!(
            names.name(user_id!("@eve:x"), Some("Eve")).as_deref(),
            Some("Eve")
        );
    }

    #[test]
    fn the_user_cannot_nickname_themself() {
        let names = nicknames(&[("@me:x", set("Boss"), OverrideTextView::Unset)]);

        assert_eq!(
            names.name(user_id!("@me:x"), Some("Me")).as_deref(),
            Some("Me")
        );
    }

    #[test]
    fn only_people_whose_nickname_moved_are_reported() {
        let before = nicknames(&[
            ("@bob:x", set("Bobby"), OverrideTextView::Unset),
            ("@ann:x", set("Annie"), OverrideTextView::Unset),
        ]);
        let after = nicknames(&[
            ("@bob:x", set("Bobby"), OverrideTextView::Unset),
            ("@cy:x", set("Cyrus"), OverrideTextView::Unset),
        ]);

        assert_eq!(
            before.changed(&after),
            [user_id!("@ann:x").to_owned(), user_id!("@cy:x").to_owned()]
        );
    }
}
