use serde_json::{Value, json};

use super::ComposerPill;
use super::blocks::Block;
use super::inline::{Inline, Mark};

fn mark(mark: &Mark) -> Value {
    match mark {
        Mark::Strong => json!({ "type": "strong" }),
        Mark::Em => json!({ "type": "em" }),
        Mark::Strike => json!({ "type": "strike" }),
        Mark::Code => json!({ "type": "code" }),
        Mark::Color(value) => json!({ "type": "color", "attrs": { "value": value } }),
        Mark::BgColor(value) => json!({ "type": "bg_color", "attrs": { "value": value } }),
        Mark::Spoiler => json!({ "type": "spoiler" }),
        Mark::Link(href) => json!({ "type": "link", "attrs": { "href": href } }),
    }
}

fn marked(mut node: Value, marks: &[Mark]) -> Value {
    if !marks.is_empty()
        && let Value::Object(object) = &mut node
    {
        object.insert("marks".to_owned(), marks.iter().map(mark).collect());
    }
    node
}

fn pill(pill: &ComposerPill) -> Value {
    match pill {
        ComposerPill::Mention { user_id, name, via } => {
            json!({ "type": "mention", "attrs": { "userId": user_id, "name": name, "via": via } })
        }
        ComposerPill::Emote {
            shortcode,
            url,
            body,
        } => json!({
            "type": "emoticon",
            "attrs": { "url": url, "shortcode": shortcode, "body": body },
        }),
        ComposerPill::Image { src, alt, title } => {
            json!({ "type": "image", "attrs": { "src": src, "alt": alt, "title": title } })
        }
    }
}

fn inline(node: &Inline, pills: &[ComposerPill]) -> Option<Value> {
    Some(match node {
        Inline::Text(text, marks) => marked(json!({ "type": "text", "text": text }), marks),
        Inline::Break(marks) => marked(json!({ "type": "hard_break" }), marks),
        Inline::Image {
            src,
            alt,
            title,
            marks,
        } => marked(
            json!({ "type": "image", "attrs": { "src": src, "alt": alt, "title": title } }),
            marks,
        ),
        Inline::Time {
            datetime,
            label,
            marks,
        } => marked(
            json!({ "type": "mfm_time", "attrs": { "datetime": datetime, "label": label } }),
            marks,
        ),
        Inline::Math { latex, marks } => marked(
            json!({ "type": "math_inline", "attrs": { "latex": latex } }),
            marks,
        ),
        Inline::Pill(index, marks) => marked(pill(pills.get(*index)?), marks),
    })
}

fn inlines(nodes: &[Inline], pills: &[ComposerPill]) -> Vec<Value> {
    nodes
        .iter()
        .filter_map(|node| inline(node, pills))
        .collect()
}

fn container(kind: &str, content: Vec<Value>) -> Value {
    json!({ "type": kind, "content": Value::Array(content) })
}

fn block(node: &Block<Vec<Inline>>, pills: &[ComposerPill]) -> Value {
    match node {
        Block::Paragraph(nodes) => container("paragraph", inlines(nodes, pills)),
        Block::Heading(level, nodes) => {
            json!({ "type": "heading", "attrs": { "level": level }, "content": inlines(nodes, pills) })
        }
        Block::Subtext(nodes) => container("subtext", inlines(nodes, pills)),
        Block::Quote(children) => container("blockquote", blocks(children, pills)),
        Block::Code { language, text } => json!({
            "type": "code_block",
            "attrs": { "language": language },
            "content": if text.is_empty() { vec![] } else { vec![json!({ "type": "text", "text": text })] },
        }),
        Block::Rule => json!({ "type": "horizontal_rule" }),
        Block::Math(latex) => json!({ "type": "math_block", "attrs": { "latex": latex } }),
        Block::List { order, items } => {
            let items = items
                .iter()
                .map(|item| container("list_item", blocks(item, pills)))
                .collect();
            match order {
                None => container("bullet_list", items),
                Some(start) => {
                    json!({ "type": "ordered_list", "attrs": { "order": start }, "content": items })
                }
            }
        }
        Block::Table(rows) => {
            let rows = rows
                .iter()
                .map(|row| {
                    let cells = row
                        .iter()
                        .map(|cell| {
                            let kind = if cell.header {
                                "table_header"
                            } else {
                                "table_cell"
                            };
                            container(kind, inlines(&cell.content, pills))
                        })
                        .collect();
                    container("table_row", cells)
                })
                .collect();
            container("table", rows)
        }
    }
}

fn blocks(nodes: &[Block<Vec<Inline>>], pills: &[ComposerPill]) -> Vec<Value> {
    nodes.iter().map(|node| block(node, pills)).collect()
}

pub(super) fn doc(nodes: &[Block<Vec<Inline>>], pills: &[ComposerPill]) -> Value {
    let content = if nodes.is_empty() {
        vec![container("paragraph", Vec::new())]
    } else {
        blocks(nodes, pills)
    };
    container("doc", content)
}
