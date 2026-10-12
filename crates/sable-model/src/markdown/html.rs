//! The `formatted_body` the composer's `html()` writes: `ProseMirror`'s DOM
//! serialisation of the parsed document, then the same passes over the DOM.

use std::fmt::Write as _;

use super::ComposerPill;
use super::blocks::Block;
use super::inline::{Inline, Mark};
use crate::matrix_link::parse_matrix_link;
use crate::mfm::{parse_mfm_color, parse_mfm_unixtime};
use crate::text::{span, tail};

const MSC4550_LINK: &str = "data-org.matrix.msc4550.link";
const MATRIX_TO: &str = "https://matrix.to/#/";

#[derive(Debug, Clone)]
enum Node {
    Element(Element),
    Text(String),
}

#[derive(Debug, Clone)]
struct Element {
    tag: &'static str,
    attrs: Vec<(&'static str, String)>,
    children: Vec<Node>,
}

const fn element(
    tag: &'static str,
    attrs: Vec<(&'static str, String)>,
    children: Vec<Node>,
) -> Node {
    Node::Element(Element {
        tag,
        attrs,
        children,
    })
}

fn mark_element(mark: &Mark) -> Element {
    let (tag, attrs) = match mark {
        Mark::Strong => ("strong", Vec::new()),
        Mark::Em => ("em", Vec::new()),
        Mark::Strike => ("del", Vec::new()),
        Mark::Code => ("code", Vec::new()),
        Mark::Color(value) => ("span", vec![("data-mx-color", value.clone())]),
        Mark::BgColor(value) => ("span", vec![("data-mx-bg-color", value.clone())]),
        Mark::Spoiler => ("span", vec![("data-mx-spoiler", String::new())]),
        Mark::Link(href) => {
            let mut attrs = vec![("href", href.clone())];
            if parse_matrix_link(href).is_some() {
                attrs.push((MSC4550_LINK, String::new()));
            }
            ("a", attrs)
        }
    };
    Element {
        tag,
        attrs,
        children: Vec::new(),
    }
}

/// `URLSearchParams` encoding, for a room mention's `via`.
fn form_encode(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'*' | b'-' | b'.' | b'_' => {
                out.push(char::from(byte));
            }
            b' ' => out.push('+'),
            _ => {
                let _ = write!(out, "%{byte:02X}");
            }
        }
    }
    out
}

fn pill_node(pill: &ComposerPill) -> Node {
    match pill {
        ComposerPill::Mention { user_id, name, via } => {
            let mut href = format!("{MATRIX_TO}{user_id}");
            if user_id.starts_with('!') && !via.is_empty() {
                let query: Vec<String> = via
                    .iter()
                    .map(|server| format!("via={}", form_encode(server)))
                    .collect();
                href = format!("{href}?{}", query.join("&"));
            }
            element("a", vec![("href", href)], vec![Node::Text(name.clone())])
        }
        ComposerPill::Emote {
            shortcode,
            url,
            body,
        } => {
            let label = format!(":{shortcode}:");
            let alt = body
                .clone()
                .filter(|body| !body.is_empty() && !body.starts_with("mxc://"))
                .unwrap_or_else(|| label.clone());
            element(
                "img",
                vec![
                    ("data-mx-emoticon", String::new()),
                    ("src", url.clone()),
                    ("alt", alt),
                    ("title", label),
                    ("height", "32".to_owned()),
                ],
                Vec::new(),
            )
        }
    }
}

fn inline_node(node: &Inline, pills: &[ComposerPill]) -> Option<Node> {
    Some(match node {
        Inline::Text(text, _) => Node::Text(text.clone()),
        Inline::Break(_) => element("br", Vec::new(), Vec::new()),
        Inline::Image {
            src, alt, title, ..
        } => {
            let mut attrs = vec![("src", src.clone()), ("alt", alt.clone())];
            if !title.is_empty() {
                attrs.push(("title", title.clone()));
            }
            element("img", attrs, Vec::new())
        }
        Inline::Time {
            datetime, label, ..
        } => element(
            "time",
            vec![("datetime", datetime.clone())],
            vec![Node::Text(label.clone())],
        ),
        Inline::Pill(index) => pill_node(pills.get(*index)?),
    })
}

/// `DOMSerializer.serializeFragment`: a mark's element stays open across
/// neighbours that share it and every mark before it.
fn inline_nodes(nodes: &[Inline], pills: &[ComposerPill]) -> Vec<Node> {
    fn close(active: &mut Vec<(Mark, Element)>, out: &mut Vec<Node>) {
        if let Some((_, element)) = active.pop() {
            push(active, out, Node::Element(element));
        }
    }
    fn push(active: &mut [(Mark, Element)], out: &mut Vec<Node>, node: Node) {
        match active.last_mut() {
            Some((_, parent)) => parent.children.push(node),
            None => out.push(node),
        }
    }

    let mut out = Vec::new();
    let mut active: Vec<(Mark, Element)> = Vec::new();
    for node in nodes {
        let marks = node.marks();
        let keep = active
            .iter()
            .zip(marks)
            .take_while(|((open, _), mark)| open == *mark)
            .count();
        while active.len() > keep {
            close(&mut active, &mut out);
        }
        for mark in marks.iter().skip(keep) {
            active.push((mark.clone(), mark_element(mark)));
        }
        if let Some(dom) = inline_node(node, pills) {
            push(&mut active, &mut out, dom);
        }
    }
    while !active.is_empty() {
        close(&mut active, &mut out);
    }
    out
}

fn block_node(block: &Block<Vec<Inline>>, pills: &[ComposerPill]) -> Node {
    let inline = |nodes: &Vec<Inline>| inline_nodes(nodes, pills);
    match block {
        Block::Paragraph(nodes) => element("p", Vec::new(), inline(nodes)),
        Block::Heading(level, nodes) => {
            let tag = match level {
                1 => "h1",
                2 => "h2",
                3 => "h3",
                4 => "h4",
                5 => "h5",
                _ => "h6",
            };
            element(tag, Vec::new(), inline(nodes))
        }
        Block::Subtext(nodes) => element("sub", vec![("data-md", "-#".to_owned())], inline(nodes)),
        Block::Quote(children) => element("blockquote", Vec::new(), block_nodes(children, pills)),
        Block::Code { language, text } => {
            let attrs = if language.is_empty() {
                Vec::new()
            } else {
                vec![("class", format!("language-{language}"))]
            };
            let code = element("code", attrs, vec![Node::Text(text.clone())]);
            element("pre", Vec::new(), vec![code])
        }
        Block::Rule => element("hr", Vec::new(), Vec::new()),
        Block::List { order, items } => {
            let (tag, attrs) = match order {
                None => ("ul", Vec::new()),
                Some(1) => ("ol", Vec::new()),
                Some(start) => ("ol", vec![("start", start.to_string())]),
            };
            let items = items
                .iter()
                .map(|item| match item.as_slice() {
                    [Block::Paragraph(nodes)] => element("li", Vec::new(), inline(nodes)),
                    blocks => element("li", Vec::new(), block_nodes(blocks, pills)),
                })
                .collect();
            element(tag, attrs, items)
        }
        Block::Table(rows) => {
            let rows = rows
                .iter()
                .map(|row| {
                    let cells = row
                        .iter()
                        .map(|cell| {
                            let tag = if cell.header { "th" } else { "td" };
                            element(tag, Vec::new(), inline(&cell.content))
                        })
                        .collect();
                    element("tr", Vec::new(), cells)
                })
                .collect();
            element(
                "table",
                Vec::new(),
                vec![element("tbody", Vec::new(), rows)],
            )
        }
    }
}

fn block_nodes(blocks: &[Block<Vec<Inline>>], pills: &[ComposerPill]) -> Vec<Node> {
    blocks
        .iter()
        .map(|block| block_node(block, pills))
        .collect()
}

fn text_content(nodes: &[Node], out: &mut String) {
    for node in nodes {
        match node {
            Node::Text(text) => out.push_str(text),
            Node::Element(element) => text_content(&element.children, out),
        }
    }
}

/// A link labelled with its own address is an ordinary link.
fn drop_redundant_link_markers(nodes: &mut [Node]) {
    for node in nodes {
        if let Node::Element(element) = node {
            drop_redundant_link_markers(&mut element.children);
            if element.tag == "a" && element.attrs.iter().any(|(name, _)| *name == MSC4550_LINK) {
                let mut text = String::new();
                text_content(&element.children, &mut text);
                let href = element.attrs.iter().find(|(name, _)| *name == "href");
                if href.is_some_and(|(_, href)| *href == text) {
                    element.attrs.retain(|(name, _)| *name != MSC4550_LINK);
                }
            }
        }
    }
}

/// Runs `apply` on every text node, telling it whether it sits inside `pre`
/// and whether inside `code`, `pre`, `a` or `time`.
fn each_text(
    nodes: &mut Vec<Node>,
    pre: bool,
    quoted: bool,
    apply: &mut impl FnMut(&str, bool, bool) -> Option<Vec<Node>>,
) {
    let mut index = 0;
    while let Some(node) = nodes.get_mut(index) {
        match node {
            Node::Element(element) => {
                let pre = pre || element.tag == "pre";
                let quoted = quoted || matches!(element.tag, "code" | "pre" | "a" | "time");
                each_text(&mut element.children, pre, quoted, apply);
                index += 1;
            }
            Node::Text(text) => match apply(text, pre, quoted) {
                Some(replacement) => {
                    let count = replacement.len();
                    nodes.splice(index..=index, replacement);
                    index += count;
                }
                None => index += 1,
            },
        }
    }
}

fn span_element(text: &str) -> Node {
    element("span", Vec::new(), vec![Node::Text(text.to_owned())])
}

/// A literal `$[…]` that a receiver would still read as MFM gets its `$`
/// wrapped, so the `[` no longer follows it.
fn split_literal_mfm(text: &str) -> Option<Vec<Node>> {
    let starts: Vec<usize> = text
        .match_indices("$[")
        .map(|(at, _)| at)
        .filter(|&at| {
            parse_mfm_unixtime(tail(text, at)).is_some()
                || parse_mfm_color(tail(text, at)).is_some()
        })
        .collect();
    if starts.is_empty() {
        return None;
    }
    let mut nodes = Vec::new();
    let mut from = 0;
    for at in starts {
        nodes.push(Node::Text(span(text, from, at).to_owned()));
        nodes.push(span_element("$"));
        from = at + 1;
    }
    nodes.push(Node::Text(tail(text, from).to_owned()));
    Some(nodes)
}

/// Every delimiter a receiver would format is wrapped on its own, so nothing
/// pairs across the tags.
fn split_delimiters(text: &str) -> Vec<Node> {
    let mut nodes = Vec::new();
    let mut from = 0;
    for (at, c) in text.char_indices() {
        if matches!(c, '*' | '_' | '~' | '`' | '|') {
            nodes.push(Node::Text(span(text, from, at).to_owned()));
            nodes.push(span_element(span(text, at, at + 1)));
            from = at + 1;
        }
    }
    nodes.push(Node::Text(tail(text, from).to_owned()));
    nodes
}

fn escape(text: &str, attribute: bool, out: &mut String) {
    for c in text.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '\u{a0}' => out.push_str("&nbsp;"),
            '<' if !attribute => out.push_str("&lt;"),
            '>' if !attribute => out.push_str("&gt;"),
            '"' if attribute => out.push_str("&quot;"),
            c => out.push(c),
        }
    }
}

fn serialize(nodes: &[Node], out: &mut String) {
    for node in nodes {
        match node {
            Node::Text(text) => escape(text, false, out),
            Node::Element(element) => {
                out.push('<');
                out.push_str(element.tag);
                for (name, value) in &element.attrs {
                    out.push(' ');
                    out.push_str(name);
                    out.push_str("=\"");
                    escape(value, true, out);
                    out.push('"');
                }
                out.push('>');
                if !matches!(element.tag, "br" | "hr" | "img") {
                    serialize(&element.children, out);
                    out.push_str("</");
                    out.push_str(element.tag);
                    out.push('>');
                }
            }
        }
    }
}

pub(super) fn html(
    blocks: &[Block<Vec<Inline>>],
    pills: &[ComposerPill],
    receiver_formats: impl Fn(&str) -> bool,
) -> String {
    let mut nodes = block_nodes(blocks, pills);
    drop_redundant_link_markers(&mut nodes);
    each_text(&mut nodes, false, false, &mut |text, pre, _| {
        if pre || !text.contains("  ") {
            return None;
        }
        let chars: Vec<char> = text.chars().collect();
        let spaced = chars
            .iter()
            .enumerate()
            .map(|(at, &c)| {
                if c == ' ' && chars.get(at + 1) == Some(&' ') {
                    '\u{a0}'
                } else {
                    c
                }
            })
            .collect();
        Some(vec![Node::Text(spaced)])
    });
    each_text(&mut nodes, false, false, &mut |text, _, quoted| {
        if quoted {
            None
        } else {
            split_literal_mfm(text)
        }
    });
    each_text(&mut nodes, false, false, &mut |text, _, quoted| {
        (!quoted && receiver_formats(text)).then(|| split_delimiters(text))
    });

    let mut out = String::new();
    match nodes.as_slice() {
        [Node::Element(only)] if only.tag == "p" => serialize(&only.children, &mut out),
        _ => serialize(&nodes, &mut out),
    }
    out
}
