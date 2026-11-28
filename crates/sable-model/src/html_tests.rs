use super::{PreviewEmote, emotes_within, preview_body, preview_emotes};

fn img(alt: &str) -> String {
    format!("<img data-mx-emoticon src=\"mxc://x/{alt}\" alt=\"{alt}\">")
}

/// Each emote's `alt` read back from the preview text at its UTF-16 offset.
fn placed(formatted: &str) -> (String, Vec<(u32, String)>) {
    let text = preview_body("", Some(formatted));
    let units: Vec<u16> = text.encode_utf16().collect();
    let emotes = preview_emotes(Some(formatted))
        .into_iter()
        .map(|PreviewEmote { alt, offset, .. }| {
            let start = offset as usize;
            let end = start + alt.encode_utf16().count();
            assert_eq!(String::from_utf16(&units[start..end]).unwrap(), alt);
            (offset, alt)
        })
        .collect();
    (text, emotes)
}

#[test]
fn an_emote_is_placed_where_it_was_sent_not_inside_an_earlier_word() {
    let tf = img("tf");
    assert_eq!(
        placed(&format!("i have a dirty maid outfit {tf}")),
        (
            "i have a dirty maid outfit tf".to_owned(),
            vec![(27, "tf".to_owned())]
        )
    );
    assert_eq!(
        placed(&format!("tf is this {tf}")),
        ("tf is this tf".to_owned(), vec![(11, "tf".to_owned())])
    );
    assert_eq!(
        placed(&format!("bbbbbacbbbbb {}", img("ac"))),
        ("bbbbbacbbbbb ac".to_owned(), vec![(13, "ac".to_owned())])
    );
}

#[test]
fn the_same_emote_twice_has_two_offsets() {
    assert_eq!(
        placed(&format!("{0} and {0}", img("tf"))),
        (
            "tf and tf".to_owned(),
            vec![(0, "tf".to_owned()), (7, "tf".to_owned())]
        )
    );
}

#[test]
fn offsets_count_utf16_code_units() {
    // "é" is one unit and two bytes; "🎉" is two units and four bytes.
    assert_eq!(
        placed(&format!("café 🎉 {}", img("tf"))),
        ("café 🎉 tf".to_owned(), vec![(8, "tf".to_owned())])
    );
}

#[test]
fn offsets_follow_line_breaks_spoilers_and_the_quoted_reply() {
    let formatted = format!(
        "<mx-reply>{}</mx-reply><p>a</p><span data-mx-spoiler>{}</span><br>{}",
        img("q"),
        img("s"),
        img("b")
    );
    assert_eq!(
        placed(&formatted),
        ("a\n[Spoiler]\nb".to_owned(), vec![(12, "b".to_owned())])
    );
}

#[test]
fn an_emote_trimmed_from_the_end_is_dropped() {
    let formatted = "hi <img data-mx-emoticon src=\"mxc://x/n\" alt=\"&#10;\">";
    assert_eq!(placed(formatted), ("hi ".to_owned(), vec![]));
}

#[test]
fn stored_emotes_without_an_offset_are_left_out() {
    #[derive(serde::Deserialize)]
    struct Stored {
        #[serde(deserialize_with = "super::placed_emotes")]
        emotes: Vec<PreviewEmote>,
    }
    let stored: Stored = serde_json::from_str(
        r#"{"emotes":[{"alt":"a","source":"mxc://x/a"},{"alt":"b","source":"mxc://x/b","offset":2}]}"#,
    )
    .unwrap();
    assert_eq!(
        stored.emotes,
        [PreviewEmote {
            alt: "b".to_owned(),
            source: "mxc://x/b".to_owned(),
            offset: 2,
        }]
    );
}

#[test]
fn emotes_within_keeps_only_those_that_end_in_the_text() {
    let tf = |offset| PreviewEmote {
        alt: "tf".to_owned(),
        source: "mxc://x/tf".to_owned(),
        offset,
    };
    assert_eq!(
        emotes_within(vec![tf(0), tf(3), tf(4)], "tf tf"),
        [tf(0), tf(3)]
    );
    assert_eq!(emotes_within(vec![tf(3), tf(4)], "é🎉tf"), [tf(3)]);
}

#[test]
fn offsets_follow_definition_lists() {
    let formatted = format!("<dl><dt>term</dt><dd>{}</dd></dl>", img("tf"));
    assert_eq!(
        placed(&formatted),
        ("term\ntf".to_owned(), vec![(5, "tf".to_owned())])
    );
}
