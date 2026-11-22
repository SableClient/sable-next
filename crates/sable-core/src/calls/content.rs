use std::time::Duration;

use matrix_sdk::ruma::events::call::member::{
    ActiveFocus, ActiveLivekitFocus, Application, CallApplicationContent, CallMemberEventContent,
    CallScope, Focus, FocusSelection, LivekitFocus as RumaLivekitFocus,
};
use matrix_sdk::ruma::events::rtc::notification::CallIntent as RumaCallIntent;
use matrix_sdk::ruma::{
    MilliSecondsSinceUnixEpoch, OwnedDeviceId, OwnedRoomId, OwnedServerName, OwnedUserId, UInt,
};
use serde::Serialize;

use super::membership::{self, CallMember};
use crate::protocol::{CallIntent, CallMode};

pub(super) fn content(
    room_id: &OwnedRoomId,
    own: &CallMember,
    intent: Option<CallIntent>,
) -> MembershipContent {
    content_at(room_id, own, intent, crate::now_ms())
}

#[expect(
    deprecated,
    reason = "calls still get their token from the JWT service of the earlier MSC4195"
)]
fn legacy_focus(alias: String, focus: String, server_name: Option<OwnedServerName>) -> Focus {
    let focus = if membership::is_sfu_url(&focus) {
        let mut livekit = RumaLivekitFocus::new(focus);
        livekit.server_name = server_name;
        livekit
    } else {
        let mut livekit = RumaLivekitFocus::with_service_url(focus);
        livekit.alias = Some(alias);
        livekit
    };
    Focus::LegacyLivekit(focus)
}

fn matrix2_focus(own: &CallMember, focus: &str) -> LivekitFocus {
    if membership::is_sfu_url(focus) {
        LivekitFocus::Sfu {
            url: focus.to_owned(),
            server_name: own.focus_servers.get(focus).cloned(),
        }
    } else {
        LivekitFocus::Service {
            livekit_service_url: focus.to_owned(),
        }
    }
}

pub(super) fn content_at(
    room_id: &OwnedRoomId,
    own: &CallMember,
    intent: Option<CallIntent>,
    now_ms: u64,
) -> MembershipContent {
    let screen_sharing = own.screen_sharing.then_some(ScreenSharing { active: true });
    if own.mode == CallMode::Matrix2 {
        if own.wire == membership::RtcWire::Stable {
            return MembershipContent::StableMatrix2(StableMatrix2Out {
                application: StableApplication {
                    kind: "m.call",
                    intent: intent.map(|intent| match intent {
                        CallIntent::Audio => "m.audio",
                        CallIntent::Video => "m.video",
                    }),
                    capabilities: ["m.render_audio", "m.render_video"],
                },
                slot_id: own.wire.slot(),
                member: StableMember {
                    id: own.member_id.clone(),
                    membership: "join",
                },
                transports: StableTransports {
                    published: own
                        .foci
                        .iter()
                        .map(|url| StableFocus {
                            kind: "m.livekit",
                            url: url.clone(),
                            server_name: own.focus_servers.get(url).cloned(),
                        })
                        .collect(),
                    can_subscribe: ["m.livekit"],
                },
                sticky_key: own.member_id.clone(),
                screen_sharing,
            });
        }
        MembershipContent::Matrix2(Matrix2Out {
            application: Matrix2Application::Call { intent },
            slot_id: SlotId::CallRoom,
            member: Matrix2Member {
                user_id: own.user_id.clone(),
                device_id: own.own_device_id().to_owned(),
                id: own.member_id.clone(),
                membership: "join",
            },
            transports: Matrix2Transports {
                published: own
                    .foci
                    .iter()
                    .map(|focus| matrix2_focus(own, focus))
                    .collect(),
                can_subscribe: [TransportKind::Livekit],
            },
            versions: own.uses_sticky_identity().then_some([]),
            msc4354_sticky_key: own.member_id.clone(),
            screen_sharing,
        })
    } else {
        let mut application = CallApplicationContent::new(String::new(), CallScope::Room);
        application.call_intent = intent.map(|intent| match intent {
            CallIntent::Audio => RumaCallIntent::Audio,
            CallIntent::Video => RumaCallIntent::Video,
        });
        let mut focus_active = ActiveLivekitFocus::new();
        if own.mode == CallMode::Compatibility {
            focus_active.focus_selection = FocusSelection::from("multi_sfu");
        }
        MembershipContent::Legacy(LegacyOut {
            session: CallMemberEventContent::new(
                Application::Call(application),
                own.own_device_id().to_owned(),
                ActiveFocus::Livekit(focus_active),
                own.foci
                    .iter()
                    .map(|focus| {
                        legacy_focus(
                            room_id.to_string(),
                            focus.clone(),
                            own.focus_servers.get(focus).cloned(),
                        )
                    })
                    .collect(),
                Some(MilliSecondsSinceUnixEpoch(
                    UInt::try_from(own.created_ts).unwrap_or(UInt::MAX),
                )),
                Some(Duration::from_millis(
                    now_ms
                        .saturating_sub(own.created_ts)
                        .saturating_add(14_400_000),
                )),
            ),
            membership_id: own
                .member_id
                .clone()
                .unwrap_or_else(|| own.identity.clone()),
            screen_sharing,
        })
    }
}

#[derive(Serialize)]
#[serde(untagged)]
pub(super) enum MembershipContent {
    StableMatrix2(StableMatrix2Out),
    Matrix2(Matrix2Out),
    Legacy(LegacyOut),
}

#[derive(Serialize)]
struct StableMember {
    id: Option<String>,
    membership: &'static str,
}

#[derive(Serialize)]
struct StableFocus {
    #[serde(rename = "type")]
    kind: &'static str,
    url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    server_name: Option<OwnedServerName>,
}

#[derive(Serialize)]
struct StableTransports {
    published: Vec<StableFocus>,
    can_subscribe: [&'static str; 1],
}

#[derive(Serialize)]
pub(super) struct StableMatrix2Out {
    application: StableApplication,
    slot_id: &'static str,
    member: StableMember,
    transports: StableTransports,
    sticky_key: Option<String>,
    #[serde(flatten)]
    screen_sharing: Option<ScreenSharing>,
}

#[derive(Serialize)]
struct StableApplication {
    #[serde(rename = "type")]
    kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    intent: Option<&'static str>,
    capabilities: [&'static str; 2],
}

#[derive(Clone, Copy, Serialize)]
struct ScreenSharing {
    #[serde(rename = "org.sable.screen_sharing")]
    active: bool,
}

#[derive(Serialize)]
#[serde(tag = "type")]
enum LivekitFocus {
    #[serde(rename = "livekit")]
    Service { livekit_service_url: String },
    #[serde(rename = "livekit")]
    Sfu {
        url: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        server_name: Option<OwnedServerName>,
    },
}

#[derive(Serialize)]
#[serde(tag = "type")]
enum Matrix2Application {
    #[serde(rename = "m.call")]
    Call {
        #[serde(rename = "m.call.intent", skip_serializing_if = "Option::is_none")]
        intent: Option<CallIntent>,
    },
}

#[derive(Serialize)]
struct Matrix2Member {
    user_id: OwnedUserId,
    device_id: OwnedDeviceId,
    id: Option<String>,
    membership: &'static str,
}

#[derive(Serialize)]
enum TransportKind {
    #[serde(rename = "livekit")]
    Livekit,
}

#[derive(Serialize)]
enum SlotId {
    #[serde(rename = "m.call#ROOM")]
    CallRoom,
}

#[derive(Serialize)]
struct Matrix2Transports {
    published: Vec<LivekitFocus>,
    can_subscribe: [TransportKind; 1],
}

#[derive(Serialize)]
pub(super) struct Matrix2Out {
    application: Matrix2Application,
    slot_id: SlotId,
    member: Matrix2Member,
    transports: Matrix2Transports,
    #[serde(skip_serializing_if = "Option::is_none")]
    versions: Option<[(); 0]>,
    msc4354_sticky_key: Option<String>,
    #[serde(flatten)]
    screen_sharing: Option<ScreenSharing>,
}

#[derive(Serialize)]
pub(super) struct LegacyOut {
    #[serde(flatten)]
    session: CallMemberEventContent,
    #[serde(rename = "membershipID")]
    membership_id: String,
    #[serde(flatten)]
    screen_sharing: Option<ScreenSharing>,
}

#[cfg(test)]
#[path = "content_tests.rs"]
mod tests;
