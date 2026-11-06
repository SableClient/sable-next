use super::*;

fn description(kind: DescriptionType) -> Description {
    Description {
        kind,
        sdp: "v=0".into(),
    }
}

#[test]
fn only_the_sender_offers_and_only_the_receiver_answers() {
    assert!(description(DescriptionType::Offer).valid_from(true));
    assert!(!description(DescriptionType::Answer).valid_from(true));
    assert!(description(DescriptionType::Answer).valid_from(false));
    assert!(!description(DescriptionType::Offer).valid_from(false));
    let mut oversized = description(DescriptionType::Offer);
    oversized.sdp = "x".repeat(MAX_SDP + 1);
    assert!(!oversized.valid_from(true));
}

#[test]
fn events_use_the_frostbite_fields() {
    let negotiate = serde_json::to_value(NegotiateEventContent {
        session: "s".into(),
        timestamp: 7,
        description: description(DescriptionType::Offer),
    })
    .unwrap();
    assert_eq!(
        negotiate,
        serde_json::json!({
            "session": "s",
            "timestamp": 7,
            "description": { "type": "offer", "sdp": "v=0" },
        })
    );
    let candidate = serde_json::to_value(CandidateEventContent {
        session: "s".into(),
        candidate: IceCandidate {
            candidate: "candidate:1 1 udp 1 192.0.2.1 9 typ host".into(),
            sdp_mid: Some("0".into()),
            sdp_m_line_index: Some(0),
        },
    })
    .unwrap();
    assert_eq!(
        candidate,
        serde_json::json!({
            "session": "s",
            "candidate": {
                "candidate": "candidate:1 1 udp 1 192.0.2.1 9 typ host",
                "sdpMid": "0",
                "sdpMLineIndex": 0,
            },
        })
    );
    assert_eq!(
        NegotiateEventContent::TYPE,
        "computer.gingershaped.frostbite.negotiate"
    );
    assert_eq!(
        CandidateEventContent::TYPE,
        "computer.gingershaped.frostbite.candidate"
    );
}
