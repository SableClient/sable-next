//! A typed message to Matrix content, as the web composer's plain mode sends it, checked
//! against `fixtures/markdown.json`.

mod blocks;
mod doc;
mod html;
mod inline;
mod links;
mod source;

use linkify::{LinkFinder, LinkKind};
use serde::{Deserialize, Serialize};

use self::blocks::Block;
use self::inline::{Inline, Mark, Token, add_mark, fold, formats, merged, sable_syntax};
use crate::text::{head, is_space, span, tail, trim};

/// The placeholder a client writes where a pill sits in the typed text.
pub const PILL: char = '\u{FFFC}';

/// A mention or emote picked from a suggestion rather than typed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ComposerPill {
    Mention {
        user_id: String,
        name: String,
        via: Vec<String>,
    },
    Emote {
        shortcode: String,
        url: String,
        body: Option<String>,
    },
    Image {
        src: String,
        alt: String,
        title: String,
    },
}

impl ComposerPill {
    fn text(&self) -> String {
        match self {
            Self::Mention { name, .. } => name.clone(),
            Self::Emote { shortcode, .. } => format!(":{shortcode}:"),
            Self::Image { src, alt, .. } => if alt.is_empty() { src } else { alt }.clone(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
pub struct ComposerMentions {
    pub user_ids: Vec<String>,
    pub room: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
pub struct ComposerContent {
    pub body: String,
    pub formatted_body: Option<String>,
    pub mentions: ComposerMentions,
}

/// `text` with each placeholder that has a pill replaced by `with(pill)`.
fn fill_pills(
    text: &str,
    pills: &[ComposerPill],
    with: impl Fn(&ComposerPill) -> String,
) -> String {
    let mut remaining = pills.iter();
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match (c == PILL).then(|| remaining.next()).flatten() {
            Some(pill) => out.push_str(&with(pill)),
            None => out.push(c),
        }
    }
    out
}

/// `@room` stands alone in a paragraph, wherever it is, code included.
fn mentions_room(text: &str, pills: usize) -> bool {
    let mut placed = 0;
    text.split("\n\n").any(|paragraph| {
        let words: String = paragraph
            .chars()
            .map(|c| {
                let pill = c == PILL && placed < pills;
                placed += usize::from(pill);
                if c == '\n' || pill { ' ' } else { c }
            })
            .collect();
        words.match_indices("@room").any(|(at, word)| {
            let before = head(&words, at).chars().next_back();
            let after = tail(&words, at + word.len()).chars().next();
            before.is_none_or(is_space) && after.is_none_or(is_space)
        })
    })
}

fn mentions(text: &str, pills: &[ComposerPill], blocks: &[Block<Vec<Inline>>]) -> ComposerMentions {
    let used = text.chars().filter(|c| *c == PILL).count().min(pills.len());
    let mut contents = Vec::new();
    for block in blocks {
        block.contents(&mut contents);
    }
    let mut user_ids: Vec<String> = Vec::new();
    for index in contents
        .into_iter()
        .flatten()
        .filter_map(|node| match node {
            Inline::Pill(index) => Some(*index),
            _ => None,
        })
    {
        if let Some(ComposerPill::Mention { user_id, .. }) = pills.get(index)
            && user_id.starts_with('@')
            && !user_ids.contains(user_id)
        {
            user_ids.push(user_id.clone());
        }
    }
    ComposerMentions {
        user_ids,
        room: mentions_room(text, used),
    }
}

/// The pills put back where their placeholders were. A pill keeps none of the
/// marks around it; inside a code block it is its text.
fn splice_pills(nodes: Vec<Inline>, next: &mut usize, pills: &[ComposerPill]) -> Vec<Inline> {
    let mut out = Vec::with_capacity(nodes.len());
    for node in nodes {
        let Inline::Text(text, marks) = node else {
            out.push(node);
            continue;
        };
        let coded = marks.contains(&Mark::Code);
        for (index, part) in text.split(PILL).enumerate() {
            if index > 0 {
                match pills.get(*next) {
                    Some(pill) if coded && !matches!(pill, ComposerPill::Emote { .. }) => {
                        out.push(Inline::Text(pill.text(), marks.clone()));
                        *next += 1;
                    }
                    Some(_) => {
                        out.push(Inline::Pill(*next));
                        *next += 1;
                    }
                    None => out.push(Inline::Text(PILL.to_string(), marks.clone())),
                }
            }
            if !part.is_empty() {
                out.push(Inline::Text(part.to_owned(), marks.clone()));
            }
        }
    }
    out
}

fn splice_code(text: &str, next: &mut usize, pills: &[ComposerPill]) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match (c == PILL).then(|| pills.get(*next)).flatten() {
            Some(pill) => {
                out.push_str(&pill.text());
                *next += 1;
            }
            None => out.push(c),
        }
    }
    out
}

fn splice_blocks(
    blocks: Vec<Block<Vec<Inline>>>,
    next: &mut usize,
    pills: &[ComposerPill],
) -> Vec<Block<Vec<Inline>>> {
    blocks
        .into_iter()
        .map(|block| match block {
            Block::Code { language, text } => Block::Code {
                language,
                text: splice_code(&text, next, pills),
            },
            Block::Quote(children) => Block::Quote(splice_blocks(children, next, pills)),
            Block::List { order, items } => Block::List {
                order,
                items: items
                    .into_iter()
                    .map(|item| splice_blocks(item, next, pills))
                    .collect(),
            },
            other => other.map(&mut |nodes| splice_pills(nodes, next, pills)),
        })
        .collect()
}

fn word_char(c: char) -> bool {
    c.is_alphanumeric() || c == '_'
}

/// The byte ranges of `MSC1234`-style references in `text`.
fn msc_references(text: &str) -> Vec<(usize, usize, String)> {
    let mut found = Vec::new();
    let lower = text.to_ascii_lowercase();
    let mut from = 0;
    while let Some(offset) = tail(&lower, from).find("msc") {
        let at = from + offset;
        from = at + 3;
        if head(text, at).chars().next_back().is_some_and(word_char) {
            continue;
        }
        let digits = tail(text, at + 3)
            .bytes()
            .take_while(u8::is_ascii_digit)
            .count();
        let end = at + 3 + digits;
        if (1..=5).contains(&digits) && !tail(text, end).chars().next().is_some_and(word_char) {
            found.push((at, end, span(text, at + 3, end).to_owned()));
            from = end;
        }
    }
    found
}

fn link_mscs(nodes: Vec<Inline>) -> Vec<Inline> {
    let mut out = Vec::with_capacity(nodes.len());
    for node in nodes {
        match node {
            Inline::Text(text, marks)
                if !marks
                    .iter()
                    .any(|mark| matches!(mark, Mark::Link(_) | Mark::Code)) =>
            {
                let mut from = 0;
                for (start, end, number) in msc_references(&text) {
                    if start > from {
                        out.push(Inline::Text(
                            span(&text, from, start).to_owned(),
                            marks.clone(),
                        ));
                    }
                    let href = format!(
                        "https://github.com/matrix-org/matrix-spec-proposals/pull/{number}"
                    );
                    out.push(Inline::Text(
                        span(&text, start, end).to_owned(),
                        add_mark(&marks, Mark::Link(href)),
                    ));
                    from = end;
                }
                if from < text.len() {
                    out.push(Inline::Text(tail(&text, from).to_owned(), marks));
                }
            }
            other => out.push(other),
        }
    }
    out
}

/// The top-level domains markdown-it's linkify accepts besides the two-letter ones.
const GENERIC_TLDS: [&str; 16] = [
    "biz", "com", "edu", "gov", "net", "org", "pro", "web", "xxx", "aero", "asia", "coop", "info",
    "museum", "name", "shop",
];

/// Where a bare address leads, as markdown-it's linkify reads it: a scheme, or a domain whose
/// top-level domain it knows.
fn bare_href(address: &str, kind: &LinkKind) -> Option<String> {
    if *kind == LinkKind::Email {
        return Some(format!("mailto:{address}"));
    }
    if let Some((scheme, _)) = address.split_once("://") {
        return ["http", "https", "ftp"]
            .iter()
            .any(|allowed| scheme.eq_ignore_ascii_case(allowed))
            .then(|| address.to_owned());
    }
    let host = address.split(['/', '?', '#', ':']).next()?;
    let tld = host.rsplit('.').next()?;
    let known = (tld.len() == 2 && tld.bytes().all(|byte| byte.is_ascii_alphabetic()))
        || GENERIC_TLDS.contains(&tld.to_ascii_lowercase().as_str());
    known.then(|| format!("http://{address}"))
}

/// A topic is plain text, so only the bare addresses in it become links.
fn topic_inlines(nodes: Vec<Inline>) -> Vec<Inline> {
    let mut finder = LinkFinder::new();
    finder.url_must_have_scheme(false);
    let mut out = Vec::with_capacity(nodes.len());
    for node in nodes {
        match node {
            Inline::Text(text, marks) => {
                for piece in finder.spans(&text) {
                    let href = piece
                        .kind()
                        .and_then(|kind| bare_href(piece.as_str(), kind));
                    let marks = href
                        .map_or_else(|| marks.clone(), |href| add_mark(&marks, Mark::Link(href)));
                    out.push(Inline::Text(piece.as_str().to_owned(), marks));
                }
            }
            other => out.push(other),
        }
    }
    merged(out)
}

fn without_trailing_paragraphs(mut blocks: Vec<Block<Vec<Inline>>>) -> Vec<Block<Vec<Inline>>> {
    while blocks.len() > 1
        && matches!(blocks.last(), Some(Block::Paragraph(nodes)) if nodes.is_empty())
    {
        blocks.pop();
    }
    blocks
}

/// The text a plain document says, or `None` when it carries anything else.
fn plain_text(blocks: &[Block<Vec<Inline>>]) -> Option<String> {
    let mut paragraphs = Vec::with_capacity(blocks.len());
    for block in blocks {
        let Block::Paragraph(nodes) = block else {
            return None;
        };
        let mut text = String::new();
        for node in nodes {
            match node {
                Inline::Text(part, marks) if marks.is_empty() => text.push_str(part),
                Inline::Break(marks) if marks.is_empty() => text.push('\n'),
                _ => return None,
            }
        }
        paragraphs.push(text);
    }
    Some(paragraphs.join("\n\n"))
}

fn token_blocks(source: &str) -> Vec<Block<Vec<Token>>> {
    blocks::parse(source)
        .into_iter()
        .map(|block| block.map(&mut sable_syntax))
        .collect()
}

/// Whether a receiver reading `text` as inline markdown would format it.
#[must_use]
pub fn receiver_formats(text: &str) -> bool {
    let blocks = token_blocks(&format!("# {}", text.replace(['\n', '\r'], " ")));
    let mut contents = Vec::new();
    for block in &blocks {
        block.contents(&mut contents);
    }
    let owned: Vec<Token> = contents.into_iter().flatten().cloned().collect();
    formats(&owned)
}

fn parse(source: &str, pills: &[ComposerPill]) -> Vec<Block<Vec<Inline>>> {
    let parsed: Vec<Block<Vec<Inline>>> = token_blocks(source)
        .into_iter()
        .map(|block| block.map(&mut |tokens| fold(tokens)))
        .collect();
    let spliced = splice_blocks(parsed, &mut 0, pills);
    without_trailing_paragraphs(spliced)
        .into_iter()
        .map(|block| block.map(&mut |nodes| merged(link_mscs(nodes))))
        .collect()
}

fn line_feeds(markdown: &str) -> String {
    markdown.replace("\r\n", "\n").replace('\r', "\n")
}

fn typed_source(typed: &str) -> String {
    trim(&typed.replace('\u{a0}', " ")).replace("¯\\_(ツ)_/¯", "¯\\\\\\_(ツ)\\_/¯")
}

#[must_use]
pub fn markdown_to_content(markdown: &str, pills: &[ComposerPill]) -> ComposerContent {
    let typed = line_feeds(markdown);
    let body =
        trim(&fill_pills(&typed, pills, ComposerPill::text).replace('\u{a0}', " ")).to_owned();
    if body.is_empty() {
        return ComposerContent {
            body,
            formatted_body: None,
            mentions: ComposerMentions {
                user_ids: Vec::new(),
                room: false,
            },
        };
    }
    let linked = parse(&typed_source(&typed), pills);
    let mentions = mentions(&typed, pills, &linked);

    let plain = plain_text(&linked).is_some_and(|text| text == body) && !receiver_formats(&body);
    let formatted_body = (!plain).then(|| html::html(&linked, pills, receiver_formats));
    let body = match formatted_body.as_deref() {
        Some(formatted) if formatted.contains("data-mx-spoiler") => {
            crate::html::preview_body(&body, Some(formatted))
        }
        _ => body,
    };
    ComposerContent {
        body,
        formatted_body,
        mentions,
    }
}

#[must_use]
pub fn topic_to_html(topic: &str) -> String {
    let mut nodes = Vec::new();
    for (index, line) in line_feeds(topic).split('\n').enumerate() {
        if index > 0 {
            nodes.push(Inline::Break(Vec::new()));
        }
        nodes.push(Inline::Text(line.to_owned(), Vec::new()));
    }
    html::html(
        &[Block::Paragraph(topic_inlines(nodes))],
        &[],
        receiver_formats,
    )
}

#[must_use]
pub fn markdown_to_doc(markdown: &str, pills: &[ComposerPill]) -> serde_json::Value {
    doc::doc(&parse(&typed_source(&line_feeds(markdown)), pills), pills)
}

#[cfg(test)]
mod tests {
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
        assert!(
            topic_to_html("FTP://files.example.org/a")
                .contains("href=\"FTP://files.example.org/a\"")
        );
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
            (
                "MSC1234",
                Some(
                    "<a href=\"https://github.com/matrix-org/matrix-spec-proposals/pull/1234\">MSC1234</a>",
                ),
            ),
            ("-# small", Some("<sub data-md=\"-#\">small</sub>")),
            (
                "$[fg.color=f00 red]",
                Some("<span data-mx-color=\"#ff0000\">red</span>"),
            ),
            ("> quote", Some("<blockquote><p>quote</p></blockquote>")),
        ];
        for &(markdown, formatted) in cases {
            let content = markdown_to_content(markdown, &[]);
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
            let content = markdown_to_content(&source, &[]);
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
        let content = markdown_to_content("the ||butler **did**|| it", &[]);
        assert_eq!(content.body, "the [Spoiler] it");
        assert_eq!(
            content.formatted_body.as_deref(),
            Some("the <span data-mx-spoiler=\"\">butler <strong>did</strong></span> it")
        );
        let plain = markdown_to_content("no **secret** here", &[]);
        assert_eq!(plain.body, "no **secret** here");
    }

    #[test]
    fn a_tilde_run_opens_a_fence_whatever_follows() {
        for markdown in [
            "~~~) &amp;~~ ![](mxc://a.b/0)",
            "* ~~~\n\n  x",
            "> > * ]\n> >   ~~~) a~~",
        ] {
            let html = markdown_to_content(markdown, &[])
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
        let content = markdown_to_content("**hey** \u{fffc}", &pills);
        assert_eq!(content.body, "**hey** :wave:");
        assert_eq!(
            content.formatted_body.as_deref(),
            Some(
                "<strong>hey</strong> <img data-mx-emoticon=\"\" src=\"mxc://example.org/wave\" alt=\"wave\" title=\"wave\" height=\"32\">"
            )
        );
    }

    #[test]
    fn a_mention_in_code_is_text_and_does_not_notify() {
        let pills = [mention("@a:b")];
        let content = markdown_to_content("`\u{fffc}` x", &pills);
        assert_eq!(
            content.formatted_body.as_deref(),
            Some("<code>@a:b</code> x")
        );
        assert_eq!(content.mentions.user_ids, Vec::<String>::new());
        let content = markdown_to_content("```\n\u{fffc}\n```", &pills);
        assert_eq!(content.mentions.user_ids, Vec::<String>::new());
    }

    #[test]
    fn an_image_pill_is_an_image_in_the_text() {
        let pills = [ComposerPill::Image {
            src: "mxc://a/b".to_owned(),
            alt: "cat".to_owned(),
            title: String::new(),
        }];
        let content = markdown_to_content("see \u{fffc}", &pills);
        assert_eq!(content.body, "see cat");
        assert_eq!(
            content.formatted_body.as_deref(),
            Some("see <img src=\"mxc://a/b\" alt=\"cat\">")
        );
    }

    #[test]
    fn a_placeholder_without_a_pill_stays_text_in_both_bodies() {
        let plain = markdown_to_content("a\u{fffc}b", &[]);
        assert_eq!(
            (plain.body.as_str(), plain.formatted_body),
            ("a\u{fffc}b", None)
        );
        let marked = markdown_to_content("**a**\u{fffc}`\u{fffc}`\n```\n\u{fffc}\n```", &[]);
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
            markdown_to_content("so $x^2$ holds", &[])
                .formatted_body
                .as_deref(),
            Some("so <span data-mx-maths=\"x^2\"><code>x^2</code></span> holds")
        );
        assert_eq!(
            markdown_to_content("$$\\int f\n$$", &[])
                .formatted_body
                .as_deref(),
            Some("<div data-mx-maths=\"\\int f\"><code>\\int f</code></div>")
        );
        assert_eq!(
            markdown_to_content("costs $5 and $6", &[]).formatted_body,
            None
        );
    }

    #[test]
    fn prices_code_and_escapes_are_not_math() {
        for text in ["costs $5 and $6", "`$x$`", "\\$x$", "$ x$", "$x $", "$$x"] {
            assert!(
                !markdown_to_content(text, &[])
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
                &[]
            )
            .formatted_body
            .as_deref(),
            Some(
                "<a href=\"https://example.org\"><span data-mx-color=\"#ff0000\">a</span><span data-mx-color=\"#00ff00\">b</span>c</a>"
            )
        );
    }

    #[test]
    fn functions_take_the_dollar_signs_math_would_pair() {
        let content = markdown_to_content("$[fg.color=f00 a]$[bg.color=000 b] $x$", &[]);
        let html = content.formatted_body.unwrap_or_default();
        assert!(html.contains("data-mx-color") && html.contains("data-mx-bg-color"));
        assert!(!html.contains("data-mx-maths"));
    }

    #[test]
    fn math_holds_any_character() {
        assert_eq!(
            markdown_to_content("so $😀 + \u{1d7d8}$ holds", &[])
                .formatted_body
                .as_deref(),
            Some(
                "so <span data-mx-maths=\"😀 + \u{1d7d8}\"><code>😀 + \u{1d7d8}</code></span> holds"
            )
        );
    }

    #[test]
    fn typed_private_use_characters_are_never_markers() {
        let typed = "a\u{E000}b\u{E001}c\u{E002}d $x$ e\u{E000}1;\u{E002}";
        let content = markdown_to_content(typed, &[]);
        assert_eq!(content.body, typed);
        assert_eq!(
            content.formatted_body.as_deref(),
            Some(
                "a\u{E000}b\u{E001}c\u{E002}d <span data-mx-maths=\"x\"><code>x</code></span> e\u{E000}1;\u{E002}"
            )
        );
        assert_eq!(markdown_to_content("\u{E000}", &[]).formatted_body, None);
    }

    #[test]
    fn unclosed_math_and_code_runs_are_read_in_linear_time() {
        let runs: String = (1..280).map(|run| "`".repeat(run) + " ").collect();
        let lines = format!("$$\n{}", "x\n".repeat(200_000));
        let started = std::time::Instant::now();
        assert_eq!(markdown_to_content(&runs, &[]).body, runs.trim());
        assert_eq!(markdown_to_content(&lines, &[]).body, lines.trim());
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
            let content = markdown_to_content(typed, &[]);
            assert_eq!(content.body, typed);
            let html = content.formatted_body.unwrap_or_default();
            assert!(!html.contains("<em>"), "{html}");
            assert!(!html.contains('\\'), "{html}");
        }
        assert_eq!(
            markdown_to_content("`https://example.org/a_b_c`", &[]).formatted_body,
            Some("<code>https://example.org/a_b_c</code>".to_owned())
        );
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
            let content = markdown_to_content(&case.markdown, &case.pills);
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
}
