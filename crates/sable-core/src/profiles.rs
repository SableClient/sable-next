use matrix_sdk::ruma::OwnedUserId;
use matrix_sdk::ruma::api::client::profile::{AvatarUrl, DisplayName};

use crate::protocol::{
    AnimalIdentityView, BrightnessView, ProfileFieldView, ProfileView, PronounView, StatusView,
};

type ProfileResponse = matrix_sdk::ruma::api::client::profile::get_profile::v3::Response;

const RENDERED_PROFILE_FIELDS: [&str; 22] = [
    "displayname",
    "avatar_url",
    "moe.sable.app.bio",
    "chat.commet.profile_bio",
    "gay.fomx.biography",
    "chat.commet.profile_color_scheme",
    "chat.commet.profile_banner",
    "chat.commet.profile_status",
    "m.status",
    "org.matrix.msc4426.status",
    "io.fsky.nyx.pronouns",
    "us.cloke.msc4175.tz",
    "m.tz",
    "eu.she-a.color",
    "moe.sable.app.name_color",
    "moe.sable.app.name_color_light_theme",
    "moe.sable.app.name_color_dark_theme",
    "kitty.meow.is_cat",
    "kitty.meow.has_cats",
    "pet.plz.me",
    "pet.plz.my",
    "pet.plz.gib",
];

fn profile_field<'a>(response: &'a ProfileResponse, name: &str) -> Option<&'a serde_json::Value> {
    response
        .iter()
        .find(|(field, _)| field.as_str() == name)
        .map(|(_, value)| value)
}

fn profile_text(value: Option<&serde_json::Value>) -> Option<String> {
    value
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn profile_hex_color(value: Option<&serde_json::Value>) -> Option<String> {
    profile_text(value).filter(|color| {
        let digits = color.strip_prefix('#').unwrap_or_default();
        matches!(digits.len(), 3 | 6) && digits.bytes().all(|digit| digit.is_ascii_hexdigit())
    })
}

use crate::matrix_html::display_html;

/// A bio is arbitrary remote text, so it goes through the same sanitiser as a
/// message body and reaches the UI as display HTML.
fn profile_bio(response: &ProfileResponse) -> Option<String> {
    let texts = profile_field(response, "gay.fomx.biography")
        .and_then(|value| value.get("m.text"))
        .and_then(serde_json::Value::as_array);
    // `m.text` carries one entry per representation; only the HTML one may keep
    // its markup.
    let representation = |mimetype: Option<&str>| {
        texts.and_then(|texts| {
            texts
                .iter()
                .find(|text| text.get("mimetype").and_then(serde_json::Value::as_str) == mimetype)
                .and_then(|text| profile_text(text.get("body")))
        })
    };

    let legacy = profile_text(profile_field(response, "moe.sable.app.bio"))
        .or_else(|| profile_text(profile_field(response, "chat.commet.profile_bio")));
    let (legacy_plain, legacy_html) = match legacy {
        Some(bio) if bio.contains('<') => (None, Some(bio)),
        other => (other, None),
    };

    let plain = legacy_plain
        .or_else(|| representation(None))
        .or_else(|| representation(Some("text/plain")));
    let html = legacy_html.or_else(|| representation(Some("text/html")));

    (plain.is_some() || html.is_some())
        .then(|| display_html(plain.as_deref().unwrap_or_default(), html.as_deref()))
}

fn profile_hero_brightness(response: &ProfileResponse) -> Option<BrightnessView> {
    match profile_text(
        profile_field(response, "chat.commet.profile_color_scheme")
            .and_then(|scheme| scheme.get("brightness")),
    )?
    .as_str()
    {
        "light" => Some(BrightnessView::Light),
        "dark" => Some(BrightnessView::Dark),
        _ => None,
    }
}

fn profile_hero_color(response: &ProfileResponse) -> Option<String> {
    profile_hex_color(
        profile_field(response, "chat.commet.profile_color_scheme")
            .and_then(|value| value.get("color")),
    )
}

/// MSC4426 first, then its unstable prefix, then the older single-string field.
fn profile_status(response: &ProfileResponse) -> Option<StatusView> {
    const MAX_TEXT_CHARS: usize = 256;
    const MAX_EMOJI_CHARS: usize = 32;

    let structured = |name| {
        let field = profile_field(response, name);
        let text = profile_text(field.and_then(|status| status.get("text")))?;
        Some(StatusView {
            text: text.chars().take(MAX_TEXT_CHARS).collect(),
            emoji: profile_text(field.and_then(|status| status.get("emoji")))
                .map(|emoji| emoji.chars().take(MAX_EMOJI_CHARS).collect()),
        })
    };

    structured("m.status")
        .or_else(|| structured("org.matrix.msc4426.status"))
        .or_else(|| {
            profile_text(profile_field(response, "chat.commet.profile_status")).map(|text| {
                StatusView {
                    text: text.chars().take(MAX_TEXT_CHARS).collect(),
                    emoji: None,
                }
            })
        })
}

/// Shared with per-message profiles, which carry pronouns in the same shape.
pub(crate) fn pronoun_sets(value: Option<&serde_json::Value>) -> Vec<PronounView> {
    const MAX_SUMMARY_CHARS: usize = 16;

    value
        .and_then(serde_json::Value::as_array)
        .map(|sets| {
            sets.iter()
                .filter_map(|set| {
                    Some(PronounView {
                        summary: profile_text(set.get("summary"))?
                            .chars()
                            .take(MAX_SUMMARY_CHARS)
                            .collect(),
                        language: profile_text(set.get("language"))
                            .map(|language| language.to_lowercase()),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

fn profile_pronouns(response: &ProfileResponse) -> Vec<PronounView> {
    pronoun_sets(profile_field(response, "io.fsky.nyx.pronouns"))
}

fn profile_timezone(response: &ProfileResponse) -> Option<String> {
    profile_text(profile_field(response, "us.cloke.msc4175.tz"))
        .or_else(|| profile_text(profile_field(response, "m.tz")))
        // Some clients store the zone with its JSON quotes still attached.
        .map(|zone| zone.trim_matches(['"', '\'']).to_owned())
        .filter(|zone| !zone.is_empty())
}

/// Light-theme colour then dark, each falling back to the theme-agnostic field.
fn profile_name_colors(response: &ProfileResponse) -> (Option<String>, Option<String>) {
    let colors = profile_field(response, "eu.she-a.color");
    let shared = profile_hex_color(profile_field(response, "moe.sable.app.name_color"));
    let per_theme = |msc_key, sable_key| {
        profile_hex_color(colors.and_then(|colors| colors.get(msc_key)))
            .or_else(|| profile_hex_color(profile_field(response, sable_key)))
            .or_else(|| shared.clone())
    };

    (
        per_theme("on_light", "moe.sable.app.name_color_light_theme"),
        per_theme("on_dark", "moe.sable.app.name_color_dark_theme"),
    )
}

fn profile_animal(response: &ProfileResponse) -> Option<AnimalIdentityView> {
    let legacy_cat = |field, label: &str| {
        profile_field(response, field)
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false)
            .then(|| label.to_owned())
    };
    let identity = AnimalIdentityView {
        is_animal: profile_text(profile_field(response, "pet.plz.me"))
            .or_else(|| legacy_cat("kitty.meow.is_cat", "cat")),
        has_animal: profile_text(profile_field(response, "pet.plz.my"))
            .or_else(|| legacy_cat("kitty.meow.has_cats", "cats")),
        animal_need: profile_text(profile_field(response, "pet.plz.gib")),
    };

    // The need alone says nothing without an animal to attach it to.
    (identity.is_animal.is_some() || identity.has_animal.is_some()).then_some(identity)
}

fn profile_extra(response: &ProfileResponse) -> Vec<ProfileFieldView> {
    const MAX_VALUE_CHARS: usize = 256;

    let mut extra = response
        .iter()
        .filter(|(field, _)| !RENDERED_PROFILE_FIELDS.contains(&field.as_str()))
        .map(|(field, value)| ProfileFieldView {
            key: field.as_str().to_owned(),
            value: value
                .as_str()
                .map_or_else(|| value.to_string(), ToOwned::to_owned)
                .chars()
                .take(MAX_VALUE_CHARS)
                .collect(),
        })
        .collect::<Vec<_>>();
    extra.sort_by(|left, right| left.key.cmp(&right.key));
    extra
}

pub(crate) fn profile_view(user_id: OwnedUserId, response: &ProfileResponse) -> ProfileView {
    let (name_color_light, name_color_dark) = profile_name_colors(response);

    ProfileView {
        user_id,
        display_name: response.get_static::<DisplayName>().ok().flatten(),
        avatar_url: response
            .get_static::<AvatarUrl>()
            .ok()
            .flatten()
            .map(|url| url.to_string()),
        bio: profile_bio(response),
        hero_color: profile_hero_color(response),
        hero_brightness: profile_hero_brightness(response),
        banner_url: profile_text(profile_field(response, "chat.commet.profile_banner")),
        status: profile_status(response),
        pronouns: profile_pronouns(response),
        timezone: profile_timezone(response),
        name_color_light,
        name_color_dark,
        animal: profile_animal(response),
        extra: profile_extra(response),
    }
}
