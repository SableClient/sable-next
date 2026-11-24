use serde::Deserialize;

use super::*;

#[derive(Deserialize)]
struct Case {
    markdown: String,
    pills: Vec<ComposerPill>,
    body: String,
    formatted_body: Option<String>,
    mentions: ComposerMentions,
}

#[test]
fn a_topic_keeps_its_lines_and_escapes_markup() {
    assert_eq!(topic_to_html("one\ntwo"), "one<br>two");
    assert_eq!(topic_to_html(""), "");
    assert_eq!(
        topic_to_html("<img src=x onerror=alert(1)>"),
        "&lt;img src=x onerror=alert(1)&gt;"
    );
}

#[test]
fn a_topic_links_only_web_schemes() {
    for topic in [
        "javascript://x/%0Aalert(1)",
        "JavaScript://x/%0Aalert(1)",
        "data://x/y",
    ] {
        assert!(!topic_to_html(topic).contains("<a"), "{topic}");
    }
    for topic in ["FTP://files.example.org/a", "discord://-/channels/1/2"] {
        assert!(
            topic_to_html(topic).contains(&format!("href=\"{topic}\"")),
            "{topic}"
        );
    }
}

#[test]
fn a_topic_links_bare_domains_with_a_known_top_level_domain() {
    assert_eq!(
        topic_to_html("see example.com and matrix.org/foo"),
        "see <a href=\"http://example.com\">example.com</a> and \
             <a href=\"http://matrix.org/foo\">matrix.org/foo</a>"
    );
    assert_eq!(
        topic_to_html("mail me@example.com"),
        "mail <a href=\"mailto:me@example.com\">me@example.com</a>"
    );
    for text in ["file.txt", "v1.2.3", "10.0.0.1", "notes.md.bak"] {
        assert!(!topic_to_html(text).contains("<a "), "{text}");
    }
}

#[test]
fn a_topic_links_addresses_and_keeps_markdown_as_text() {
    assert_eq!(
        topic_to_html("Rules at https://example.org/coc"),
        "Rules at <a href=\"https://example.org/coc\">https://example.org/coc</a>"
    );
    let html = topic_to_html("**bold** _em_ `code`");
    assert!(!html.contains("<strong>") && !html.contains("<em>") && !html.contains("<code>"));
    assert!(!topic_to_html("[x](javascript:alert(1))").contains("href"));
}

fn mention(user_id: &str) -> ComposerPill {
    ComposerPill::Mention {
        user_id: user_id.to_owned(),
        name: user_id.to_owned(),
        via: Vec::new(),
    }
}

#[test]
fn typed_markdown_renders_as_the_composer_did() {
    let cases: &[(&str, Option<&str>)] = &[
        ("just words", None),
        ("say **hi** now", Some("say <strong>hi</strong> now")),
        ("a ~~b~~ c", Some("a <del>b</del> c")),
        ("\\*like so*", Some("<span>*</span>like so<span>*</span>")),
        ("\\`code\\`", Some("<span>`</span>code<span>`</span>")),
        ("\\_text\\_", Some("<span>_</span>text<span>_</span>")),
        ("\\# heading", Some("# heading")),
        ("one \\\\ two", Some("one \\ two")),
        (
            "\\[label](https://example.org)",
            Some("[label](https://example.org)"),
        ),
        ("\\<tag>", Some("&lt;tag&gt;")),
        ("&amp;", Some("&amp;")),
        ("\\&amp;", Some("&amp;amp;")),
        ("&#42;literal*", Some("<span>*</span>literal<span>*</span>")),
        ("top ¯\\_(ツ)_/¯ bottom", None),
        ("C:\\path", None),
        ("\\a", None),
        ("\\→", None),
        ("trailing \\", None),
        ("\\$[unixtime 0]", Some("<span>$</span>[unixtime 0]")),
        ("$\\[unixtime 0]", Some("<span>$</span>[unixtime 0]")),
        (
            "\\$[fg.color=f00 red]",
            Some("<span>$</span>[fg.color=f00 red]"),
        ),
        (
            "**hi** \\$[unixtime 0]",
            Some("<strong>hi</strong> <span>$</span>[unixtime 0]"),
        ),
        ("a || b || c", None),
        ("a |||| b", None),
        ("a || b", None),
        ("x|y", None),
        ("`const x = 1`", Some("<code>const x = 1</code>")),
        (
            "```\nconst x = 1;\n```",
            Some("<pre><code>const x = 1;</code></pre>"),
        ),
        ("[javascript](javascript:alert(1))", None),
        ("<script>alert(1)</script>", None),
        ("-# small", Some("<sub data-md=\"-#\">small</sub>")),
        (
            "$[fg.color=f00 red]",
            Some("<span data-mx-color=\"#ff0000\">red</span>"),
        ),
        ("> quote", Some("<blockquote><p>quote</p></blockquote>")),
    ];
    for &(markdown, formatted) in cases {
        let content = markdown_to_content(markdown, &[], None);
        assert_eq!(content.body, markdown);
        assert_eq!(content.formatted_body.as_deref(), formatted, "{markdown}");
    }
}

#[test]
fn formatting_inside_a_spoiler_keeps_one_span_and_preview_placeholder() {
    for (markdown, formatted) in [
        ("*huge*", "<em>huge</em>"),
        ("**huge**", "<strong>huge</strong>"),
        ("~~huge~~", "<del>huge</del>"),
        ("`huge`", "<code>huge</code>"),
        (
            "[huge](https://example.org)",
            "<a href=\"https://example.org\">huge</a>",
        ),
        (
            "$[fg.color=f00 huge]",
            "<span data-mx-color=\"#ff0000\">huge</span>",
        ),
    ] {
        let source = format!("||this is a {markdown} spoiler||");
        let content = markdown_to_content(&source, &[], None);
        assert_eq!(
            content.formatted_body,
            Some(format!(
                "<span data-mx-spoiler=\"\">this is a {formatted} spoiler</span>"
            )),
            "{source}"
        );
        assert_eq!(content.body, "[Spoiler]", "{source}");
    }
}

#[test]
fn a_spoiler_is_hidden_from_the_plain_body_and_other_text_kept() {
    let content = markdown_to_content("the ||butler **did**|| it", &[], None);
    assert_eq!(content.body, "the [Spoiler] it");
    assert_eq!(
        content.formatted_body.as_deref(),
        Some("the <span data-mx-spoiler=\"\">butler <strong>did</strong></span> it")
    );
    let plain = markdown_to_content("no **secret** here", &[], None);
    assert_eq!(plain.body, "no **secret** here");
}

#[test]
fn a_spoiler_runs_across_paragraphs() {
    let p = |inner: &str| format!("<p>{inner}</p>");
    let s = |inner: &str| format!("<span data-mx-spoiler=\"\">{inner}</span>");
    for (markdown, formatted) in [
        ("||one\n\ntwo||", p(&s("one")) + &p(&s("two"))),
        ("||one\ntwo||", s("one<br>two")),
        (
            "a ||one\n\n**two**\n\nthree|| b",
            p(&format!("a {}", s("one")))
                + &p(&s("<strong>two</strong>"))
                + &p(&format!("{} b", s("three"))),
        ),
        (
            "||one\n\ntwo|| ||three\n\nfour||",
            p(&s("one")) + &p(&format!("{} {}", s("two"), s("three"))) + &p(&s("four")),
        ),
        (
            "> ||one\n>\n> two||",
            format!("<blockquote>{}{}</blockquote>", p(&s("one")), p(&s("two"))),
        ),
    ] {
        let content = markdown_to_content(markdown, &[], None);
        assert_eq!(content.formatted_body, Some(formatted), "{markdown}");
        assert!(
            !content.body.contains("one"),
            "{markdown}: {}",
            content.body
        );
    }
    for markdown in [
        "||one\n\ntwo",
        "|| one\n\ntwo||",
        "||one\n\ntwo ||",
        "||one\n\n# two||",
    ] {
        let html = markdown_to_content(markdown, &[], None)
            .formatted_body
            .unwrap_or_default();
        assert!(!html.contains("data-mx-spoiler"), "{markdown}: {html}");
    }
}

#[test]
fn a_table_can_end_a_paragraph() {
    for markdown in ["a | b\n|-|-|", "a | b\\\n|-|-|", "text\n| a |\n|---|"] {
        let html = markdown_to_content(markdown, &[], None)
            .formatted_body
            .unwrap_or_default();
        assert!(html.contains("<table>"), "{markdown}: {html}");
    }
}

#[test]
fn a_table_inside_a_quote_or_list_stays_a_table() {
    for markdown in [
        "> | a |\n> | - |\n> | b |",
        "* * x\n\n    | a |\n    | - |\n    | b |",
    ] {
        let html = markdown_to_content(markdown, &[], None).formatted_body;
        assert!(html.unwrap_or_default().contains("<table>"), "{markdown}");
    }
}

#[test]
fn an_escaped_ampersand_in_a_title_keeps_its_entity() {
    assert_eq!(
        markdown_to_content("![a](mxc://a.b/c \"\\&amp; \\\\\")", &[], None)
            .formatted_body
            .as_deref(),
        Some("<img src=\"mxc://a.b/c\" alt=\"a\" title=\"&amp;amp; \\\">")
    );
    assert_eq!(
        markdown_to_content("[a](javascript:\\&amp;)", &[], None).body,
        "[a](javascript:\\&amp;)"
    );
}

#[test]
fn a_backslash_before_a_pipe_stays_in_its_cell() {
    assert_eq!(
        markdown_to_content("| `\\\\|!` |\n| - |", &[], None)
            .formatted_body
            .as_deref(),
        Some("<table><tbody><tr><th><code>\\|!</code></th></tr></tbody></table>")
    );
    assert_eq!(
        markdown_to_content("`a\\\\|b` c", &[], None)
            .formatted_body
            .as_deref(),
        Some("<code>a\\\\|b</code> c")
    );
}

#[test]
fn a_title_that_is_a_backslash_ends_at_its_quote() {
    let html = markdown_to_content(
        "![a](mxc://a.b/c \"\\\\\") ![b](mxc://a.b/d \"e\")",
        &[],
        None,
    )
    .formatted_body
    .unwrap_or_default();
    assert_eq!(
        html,
        "<img src=\"mxc://a.b/c\" alt=\"a\" title=\"\\\"> <img src=\"mxc://a.b/d\" alt=\"b\" title=\"e\">"
    );
}

#[test]
fn a_list_marker_alone_is_an_empty_item() {
    assert_eq!(
        markdown_to_content("1.", &[], None)
            .formatted_body
            .as_deref(),
        Some("<ol><li></li></ol>")
    );
    assert_eq!(
        markdown_to_content("-", &[], None)
            .formatted_body
            .as_deref(),
        Some("<ul><li></li></ul>")
    );
}

#[test]
fn an_entity_inside_a_spoiler_keeps_the_spoiler() {
    assert_eq!(
        markdown_to_content("||a &amp; b||", &[], None)
            .formatted_body
            .as_deref(),
        Some("<span data-mx-spoiler=\"\">a &amp; b</span>")
    );
    let written = markdown_to_content("&#124;&#124;a&#124;&#124;", &[], None).formatted_body;
    assert!(!written.unwrap_or_default().contains("data-mx-spoiler"));
}

#[test]
fn a_tilde_run_opens_a_fence_whatever_follows() {
    for markdown in [
        "~~~) &amp;~~ ![](mxc://a.b/0)",
        "* ~~~\n\n  x",
        "> > * ]\n> >   ~~~) a~~",
    ] {
        let html = markdown_to_content(markdown, &[], None)
            .formatted_body
            .unwrap_or_default();
        assert!(html.contains("<pre>"), "{markdown}: {html}");
    }
}

#[test]
fn an_emote_pill_is_an_image() {
    let pills = [ComposerPill::Emote {
        shortcode: "wave".to_owned(),
        url: "mxc://example.org/wave".to_owned(),
        body: None,
    }];
    let content = markdown_to_content("**hey** \u{fffc}", &pills, None);
    assert_eq!(content.body, "**hey** :wave:");
    assert_eq!(
        content.formatted_body.as_deref(),
        Some(
            "<strong>hey</strong> <img data-mx-emoticon=\"\" src=\"mxc://example.org/wave\" alt=\"wave\" title=\"wave\" height=\"32\">"
        )
    );
}

#[test]
fn an_emote_keeps_italics_in_html_and_the_editor_doc() {
    let pills = [ComposerPill::Emote {
        shortcode: "wave".to_owned(),
        url: "mxc://example.org/wave".to_owned(),
        body: None,
    }];
    for source in ["*\u{fffc}*", "_\u{fffc}_", "***\u{fffc}***"] {
        let content = markdown_to_content(source, &pills, None);
        assert_eq!(
            content.formatted_body.as_deref(),
            Some(
                "<em><img data-mx-emoticon=\"\" src=\"mxc://example.org/wave\" alt=\"wave\" title=\"wave\" height=\"32\"></em>"
            ),
            "{source}"
        );
        let doc = markdown_to_doc(source, &pills);
        assert_eq!(
            doc["content"][0]["content"][0]["marks"],
            serde_json::json!([{ "type": "em" }]),
            "{source}"
        );
    }
}

#[test]
fn a_mention_in_code_is_text_and_does_not_notify() {
    let pills = [mention("@a:b")];
    let content = markdown_to_content("`\u{fffc}` x", &pills, None);
    assert_eq!(
        content.formatted_body.as_deref(),
        Some("<code>@a:b</code> x")
    );
    assert_eq!(content.mentions.user_ids, Vec::<String>::new());
    let content = markdown_to_content("```\n\u{fffc}\n```", &pills, None);
    assert_eq!(content.mentions.user_ids, Vec::<String>::new());
}

#[test]
fn an_image_pill_is_an_image_in_the_text() {
    let pills = [ComposerPill::Image {
        src: "mxc://a/b".to_owned(),
        alt: "cat".to_owned(),
        title: String::new(),
    }];
    let content = markdown_to_content("see \u{fffc}", &pills, None);
    assert_eq!(content.body, "see cat");
    assert_eq!(
        content.formatted_body.as_deref(),
        Some("see <img src=\"mxc://a/b\" alt=\"cat\">")
    );
}

#[test]
fn a_placeholder_without_a_pill_stays_text_in_both_bodies() {
    let plain = markdown_to_content("a\u{fffc}b", &[], None);
    assert_eq!(
        (plain.body.as_str(), plain.formatted_body),
        ("a\u{fffc}b", None)
    );
    let marked = markdown_to_content("**a**\u{fffc}`\u{fffc}`\n```\n\u{fffc}\n```", &[], None);
    assert_eq!(
        marked.formatted_body.as_deref(),
        Some(
            "<p><strong>a</strong>\u{fffc}<code>\u{fffc}</code></p><pre><code>\u{fffc}</code></pre>"
        )
    );
}

#[test]
fn math_is_data_mx_maths() {
    assert_eq!(
        markdown_to_content("so $x^2$ holds", &[], None)
            .formatted_body
            .as_deref(),
        Some("so <span data-mx-maths=\"x^2\"><code>x^2</code></span> holds")
    );
    assert_eq!(
        markdown_to_content("$$\\int f\n$$", &[], None)
            .formatted_body
            .as_deref(),
        Some("<div data-mx-maths=\"\\int f\"><code>\\int f</code></div>")
    );
    assert_eq!(
        markdown_to_content("costs $5 and $6", &[], None).formatted_body,
        None
    );
}

#[test]
fn prices_code_and_escapes_are_not_math() {
    for text in ["costs $5 and $6", "`$x$`", "\\$x$", "$ x$", "$x $", "$$x"] {
        assert!(
            !markdown_to_content(text, &[], None)
                .formatted_body
                .is_some_and(|html| html.contains("data-mx-maths")),
            "{text}"
        );
    }
}

#[test]
fn a_link_wraps_its_coloured_letters_once() {
    assert_eq!(
        markdown_to_content(
            "[$[fg.color=f00 a]$[fg.color=0f0 b]c](https://example.org)",
            &[],
            None
        )
        .formatted_body
        .as_deref(),
        Some(
            "<a href=\"https://example.org\"><span data-mx-color=\"#ff0000\">a</span><span data-mx-color=\"#00ff00\">b</span>c</a>"
        )
    );
}

#[test]
fn a_function_and_math_share_a_message() {
    let content = markdown_to_content("$[fg.color=f00 a]$[bg.color=000 b] $x$", &[], None);
    assert_eq!(
        content.formatted_body.as_deref(),
        Some(
            "<span data-mx-color=\"#ff0000\">a</span><span data-mx-bg-color=\"#000000\">b</span> \
                 <span data-mx-maths=\"x\"><code>x</code></span>"
        )
    );
}

#[test]
fn math_in_backticks_is_read() {
    for (markdown, latex) in [("$`a\\`$", "a\\"), ("$`x`$5", "x"), ("$`a~b`$", "a~b")] {
        let html = markdown_to_content(markdown, &[], None)
            .formatted_body
            .unwrap_or_default();
        assert!(
            html.contains(&format!("data-mx-maths=\"{latex}\"")),
            "{markdown}: {html}"
        );
    }
    let cell = markdown_to_content("| $a\\|b$ |\n| - |", &[], None).formatted_body;
    assert!(cell.unwrap_or_default().contains("data-mx-maths=\"a|b\""));
}

#[test]
fn math_holds_any_character() {
    assert_eq!(
        markdown_to_content("so $😀 + \u{1d7d8}$ holds", &[], None)
            .formatted_body
            .as_deref(),
        Some("so <span data-mx-maths=\"😀 + \u{1d7d8}\"><code>😀 + \u{1d7d8}</code></span> holds")
    );
}

#[test]
fn typed_private_use_characters_are_never_markers() {
    let typed = "a\u{E000}b\u{E001}c\u{E002}d $x$ e\u{E000}1;\u{E002}";
    let content = markdown_to_content(typed, &[], None);
    assert_eq!(content.body, typed);
    assert_eq!(
        content.formatted_body.as_deref(),
        Some(
            "a\u{E000}b\u{E001}c\u{E002}d <span data-mx-maths=\"x\"><code>x</code></span> e\u{E000}1;\u{E002}"
        )
    );
    assert_eq!(
        markdown_to_content("\u{E000}", &[], None).formatted_body,
        None
    );
}

#[test]
fn unclosed_math_and_code_runs_are_read_in_linear_time() {
    let runs: String = (1..280).map(|run| "`".repeat(run) + " ").collect();
    let lines = format!("$$\n{}", "x\n".repeat(200_000));
    let started = std::time::Instant::now();
    assert_eq!(markdown_to_content(&runs, &[], None).body, runs.trim());
    assert_eq!(markdown_to_content(&lines, &[], None).body, lines.trim());
    assert!(started.elapsed() < std::time::Duration::from_secs(5));
}

#[test]
fn the_document_holds_blocks_marks_and_pills() {
    let doc = markdown_to_doc("# t\n\n**b** \u{fffc}", &[mention("@a:b")]);
    assert_eq!(
        doc,
        serde_json::json!({ "type": "doc", "content": [
                { "type": "heading", "attrs": { "level": 1 },
                  "content": [{ "type": "text", "text": "t" }] },
                { "type": "paragraph", "content": [
                    { "type": "text", "text": "b", "marks": [{ "type": "strong" }] },
                    { "type": "text", "text": " " },
                    { "type": "mention", "attrs": { "userId": "@a:b", "name": "@a:b", "via": [] } },
                ] },
            ] })
    );
}

#[test]
fn a_bare_address_keeps_its_underscores_and_asterisks() {
    for typed in [
        "https://en.wikipedia.org/wiki/Dr._Who_(Dalek_films)",
        "see https://example.org/a_b_c and http://example.org/*x*",
        "HTTPS://example.org/a_b_c",
        "été https://example.org/a_b_c",
    ] {
        let content = markdown_to_content(typed, &[], None);
        assert_eq!(content.body, typed);
        let html = content.formatted_body.unwrap_or_default();
        assert!(!html.contains("<em>"), "{html}");
        assert!(!html.contains('\\'), "{html}");
    }
    assert_eq!(
        markdown_to_content("`https://example.org/a_b_c`", &[], None).formatted_body,
        Some("<code>https://example.org/a_b_c</code>".to_owned())
    );
}

#[test]
fn a_labelled_link_on_the_picked_link_host_is_marked_as_a_link() {
    let html = |link_host| {
        markdown_to_content(
            "[Alice](https://links.example.org/#/@alice:example.org)",
            &[],
            link_host,
        )
        .formatted_body
        .unwrap_or_default()
    };
    assert!(html(Some("links.example.org")).contains("data-org.matrix.msc4550.link"));
    assert!(!html(None).contains("data-org.matrix.msc4550.link"));
}

#[test]
fn receivers_format_emphasis_only() {
    assert!(receiver_formats("*a*"));
    assert!(!receiver_formats("a * b"));
}

#[test]
fn matches_the_composer_on_the_shared_corpus() {
    let cases: Vec<Case> =
        serde_json::from_str(include_str!("../fixtures/markdown.json")).expect("the corpus");
    let mut failures = Vec::new();
    for case in &cases {
        let content = markdown_to_content(&case.markdown, &case.pills, None);
        let expected = ComposerContent {
            body: case.body.clone(),
            formatted_body: case.formatted_body.clone(),
            mentions: case.mentions.clone(),
        };
        if content != expected {
            failures.push(format!(
                "{:?}\n  got      {:?}\n  expected {:?}",
                case.markdown, content, expected
            ));
        }
    }
    assert!(
        failures.is_empty(),
        "{} of {} differ:\n{}",
        failures.len(),
        cases.len(),
        failures.join("\n")
    );
}
