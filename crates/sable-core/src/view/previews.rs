use std::collections::BTreeSet;

use matrix_sdk::ruma::events::room::MediaSource;

use crate::protocol::UrlPreviewView;

use super::media::media_source;

fn bundled_previews_field(content: Option<&serde_json::Value>) -> Option<&serde_json::Value> {
    let content = content?;
    content
        .get(crate::link_previews::BUNDLED_LINK_PREVIEWS)
        .or_else(|| content.get(crate::link_previews::LEGACY_BUNDLED_LINK_PREVIEWS))
}

pub(super) fn link_previews_removed(content: Option<&serde_json::Value>) -> Option<bool> {
    bundled_previews_field(content)?;
    bundled_link_previews(content).is_empty().then_some(true)
}

pub(super) fn bundled_link_previews(content: Option<&serde_json::Value>) -> Vec<UrlPreviewView> {
    let mut seen = BTreeSet::new();
    let body = content
        .and_then(|content| content.get("body"))
        .and_then(serde_json::Value::as_str);
    bundled_previews_field(content)
        .and_then(serde_json::Value::as_array)
        .map_or_else(Vec::new, |bundles| {
            bundles
                .iter()
                .filter_map(|bundle| {
                    let mut data = sable_link_preview::PreviewData::read(bundle)?;
                    let video = data
                        .video(crate::link_previews::is_mxc)
                        .map(crate::link_previews::video_view);
                    let encrypted = crate::link_previews::encrypted_image(&data);
                    let post = data.post.take().map(|post| {
                        crate::link_previews::post_view(post, crate::link_previews::is_mxc)
                    });
                    let theme_color = data.valid_theme_color();
                    let card = data.valid_card();
                    let url = data.stable_matched_url.or(data.legacy_matched_url)?;
                    if !crate::link_previews::is_preview_url(&url) {
                        return None;
                    }
                    if !body.is_some_and(|body| body.contains(&url)) {
                        return None;
                    }
                    let image = encrypted
                        .filter(|file| file.url.is_valid())
                        .map(|file| media_source(&MediaSource::Encrypted(Box::new(file))))
                        .or_else(|| data.image.filter(|image| image.starts_with("mxc://")));
                    Some(UrlPreviewView {
                        url,
                        title: data.title,
                        description: data.description,
                        site_name: data.site_name,
                        image,
                        image_mime: data.image_type,
                        image_width: data.image_width,
                        image_height: data.image_height,
                        video,
                        theme_color,
                        card,
                        author_name: data.author_name,
                        post,
                    })
                })
                .filter(|preview| seen.insert(preview.url.clone()))
                .collect()
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    use serde_json::json;

    use crate::view::raw::RawFields;

    #[test]
    fn reads_bundled_link_previews_without_trusting_external_images() {
        let previews = bundled_link_previews(Some(&json!({
            "body": "https://example.org/post https://example.org/other",
            "com.beeper.linkpreviews": [{
                "matched_url": "https://example.org/post",
                "og:title": "Post",
                "og:image": "https://example.org/image.png",
            }, {
                "og:url": "https://example.org/other",
                "og:image": "mxc://example.org/image",
                "og:image:width": 640,
            }, {
                "matched_url": "mxc://example.org/not-a-link",
            }],
        })));

        assert_eq!(previews.len(), 1);
        assert_eq!(previews[0].title.as_deref(), Some("Post"));
        assert_eq!(previews[0].image, None);
    }

    #[test]
    fn an_empty_bundle_removes_previews_and_an_edit_carries_its_own() {
        let removed = RawFields {
            content: Some(json!({
                "body": "* see https://example.org",
                "com.beeper.linkpreviews": [{ "matched_url": "https://example.org" }],
                "m.new_content": { "body": "see https://example.org", "com.beeper.linkpreviews": [] },
                "m.relates_to": { "rel_type": "m.replace", "event_id": "$event" },
            })),
            ..Default::default()
        };
        assert_eq!(link_previews_removed(removed.message()), Some(true));
        assert!(bundled_link_previews(removed.message()).is_empty());

        let absent = json!({ "body": "see https://example.org" });
        assert_eq!(link_previews_removed(Some(&absent)), None);
    }

    #[test]
    fn reads_a_bundled_post() {
        let previews = bundled_link_previews(Some(&json!({
            "body": "https://bsky.app/profile/alice.test/post/3abc",
            "m.url_previews": [{
                "matrix:matched_url": "https://bsky.app/profile/alice.test/post/3abc",
                "og:type": "note",
                "note:author:handle": "alice.test",
                "note:content": "hello",
                "og:image": "https://cdn/x.png",
            }],
        })));

        let post = previews[0].post.as_ref().unwrap();
        assert_eq!(post.text.as_deref(), Some("hello"));
        assert!(post.media.is_empty());
    }

    #[test]
    fn reads_the_stable_field_ahead_of_the_legacy_one() {
        let previews = bundled_link_previews(Some(&json!({
            "body": "https://example.org/new https://example.org/old",
            "m.url_previews": [{ "matrix:matched_url": "https://example.org/new", "og:title": "New" }],
            "com.beeper.linkpreviews": [{ "matched_url": "https://example.org/old", "og:title": "Old" }],
        })));

        assert_eq!(previews.len(), 1);
        assert_eq!(previews[0].url, "https://example.org/new");
        assert_eq!(
            link_previews_removed(Some(&json!({ "m.url_previews": [] }))),
            Some(true)
        );
    }

    #[test]
    fn an_encrypted_thumbnail_becomes_a_serialized_source() {
        for field in ["matrix:image:encrypted", "beeper:image:encryption"] {
            let previews = bundled_link_previews(Some(&json!({
                "body": "https://example.org",
                "m.url_previews": [{
                    "matrix:matched_url": "https://example.org",
                    "og:title": "Example",
                    (field): {
                        "url": "mxc://example.org/thumb",
                        "key": {
                            "kty": "oct", "key_ops": ["encrypt", "decrypt"], "alg": "A256CTR",
                            "k": "GRAgOUnbbkcd-UWoX5kTiIXJII81qwpSCnxLd5X6pxU", "ext": true
                        },
                        "iv": "kZeoJfx4ehoAAAAAAAAAAA",
                        "hashes": { "sha256": "WDOJYFegjAHNlaJmOhEPpE/3reYeD1pRvPVcta4Tgbg" },
                        "v": "v2"
                    },
                }],
            })));

            let image = previews[0].image.as_deref().unwrap();
            assert!(image.contains("mxc://example.org/thumb") && image.starts_with('{'));
        }
    }

    #[test]
    fn a_preview_for_a_url_missing_from_the_body_is_ignored() {
        let previews = bundled_link_previews(Some(&json!({
            "body": "no link here",
            "m.url_previews": [{ "matrix:matched_url": "https://example.org", "og:title": "X" }],
        })));

        assert!(previews.is_empty());
    }

    #[test]
    fn a_list_with_no_usable_entry_still_suppresses_body_scanning() {
        let content = json!({
            "body": "no link here",
            "m.url_previews": [{ "matrix:matched_url": "https://example.org" }],
        });

        assert_eq!(link_previews_removed(Some(&content)), Some(true));
    }

    #[test]
    fn a_link_bundled_twice_is_previewed_once() {
        let previews = bundled_link_previews(Some(&json!({
            "body": "https://example.org/post",
            "com.beeper.linkpreviews": [
                { "matched_url": "https://example.org/post", "og:title": "First" },
                { "matched_url": "https://example.org/post", "og:title": "Second" },
            ],
        })));

        assert_eq!(previews.len(), 1);
        assert_eq!(previews[0].title.as_deref(), Some("First"));
    }

    #[test]
    fn a_bundled_preview_skips_wrong_typed_fields() {
        let content = json!({
            "body": "see https://e.org",
            "com.beeper.linkpreviews": [
                { "matched_url": "https://e.org", "og:title": 5, "og:image:width": "wide" },
                "junk",
            ],
        });
        let previews = bundled_link_previews(Some(&content));
        assert_eq!(previews.len(), 1);
        assert_eq!(previews[0].title, None);
        assert_eq!(previews[0].image_width, None);
    }

    #[test]
    fn previews_require_a_matched_url_and_a_body() {
        for content in [
            json!({"body": "https://example.org", "m.url_previews": [{
                "og:url": "https://example.org", "og:title": "No matched URL"
            }]}),
            json!({"m.url_previews": [{
                "matrix:matched_url": "https://example.org", "og:title": "No body"
            }]}),
        ] {
            assert!(bundled_link_previews(Some(&content)).is_empty());
            assert_eq!(link_previews_removed(Some(&content)), Some(true));
        }
    }

    #[test]
    fn a_whitelist_entry_is_kept_without_preview_metadata() {
        let content = json!({
            "body": "https://example.org https://other.example",
            "m.url_previews": [{"matrix:matched_url": "https://example.org"}],
        });
        let previews = bundled_link_previews(Some(&content));
        assert_eq!(previews.len(), 1);
        assert_eq!(previews[0].url, "https://example.org");
        assert_eq!(previews[0].title, None);
        assert_eq!(link_previews_removed(Some(&content)), None);
    }

    #[test]
    fn an_empty_stable_list_takes_precedence_over_legacy_data() {
        let content = json!({
            "body": "https://example.org",
            "m.url_previews": [],
            "com.beeper.linkpreviews": [{"matched_url": "https://example.org", "og:title": "Legacy"}],
        });
        assert!(bundled_link_previews(Some(&content)).is_empty());
        assert_eq!(link_previews_removed(Some(&content)), Some(true));
    }
}
