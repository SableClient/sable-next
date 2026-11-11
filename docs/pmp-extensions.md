# MSC4461 Extensions

Sable has custom namespaced extensions to [MSC4461: Storing per-message profiles for users](https://msc.sable.moe/msc/4461). These are largely namespaced under '`net.f0rest`', as they are part of Forest's wider experimental push for PMP adoption and feature completeness.

## Extensible Profile Parity

### Pronouns

Profiles now can contain `io.fsky.nyx.pronouns`. The format of this field is defined by [MSC4247: User Pronouns](https://msc.sable.moe/msc/4247). Clients SHOULD display this like they would display user pronouns.

```json
{
  "id": "9ced47e0-95d1-42a4-961d-680279b1a724",
  "displayname": "Kris",
  "io.fsky.nyx.pronouns": [
    {
      "language": "en",
      "summary": "they/them"
    }
  ]
}
```

If this MSC is stabilised, this key will change to `m.pronouns`, so clients SHOULD also accept this key for future compatability.

### Username colors

Profiles now can contain `eu.she-a.color`. The format of this field is defined by [MSC4522: Username Colors](https://msc.sable.moe/msc/4522). Clients SHOULD display this like they would display username colors.

```json
{
  "id": "9ced47e0-95d1-42a4-961d-680279b1a724",
  "displayname": "Kris",
  "eu.she-a.color": {
    "on_dark": "#ff4646",
    "on_light": "#e42933"
  }
}
```

If this MSC is stabilised, this key will change to `m.color_preference`, so clients SHOULD also accept this key for future compatability.

## PluralKit import

Profiles now can contain `net.f0rest.pkimport`. This is used to coordinate PluralKit data imports. All fields are optional, but it is highly recommended to include, at least, an `id` and `avatar_url`, so that a PMP can be linked back to a PluralKit member and avatars are not needlessly reuploaded. The `description` field is deprecated, and SHOULD NOT be used.

```json
{
  "id": "9ced47e0-95d1-42a4-961d-680279b1a724",
  "displayname": "Kris",
  "net.f0rest.pkimport": {
    "avatar_url": "https://cdn.pluralkit.me/images/xx/yyyyyyyyyyyyyyyyyyyyyyyy.webp",
    "id": "exmpl",
    "uuid": "b52671d7-f805-40ad-8161-c43d4511c715"
  }
}
```

Clients SHOULD use this behavior to assist in updating profiles from a PluralKit imports. Clients MUST NOT delete any PMP keys that are not able to be mapped from a PluralKit import.

## Sorting

### Last used

Profiles now can contain `net.f0rest.last_used`. This is used to show recently used profiles in a selection menu. If supplied, this data MUST be a number corresponding to a valid Unix timestamp in milliseconds.

```json
{
  "id": "9ced47e0-95d1-42a4-961d-680279b1a724",
  "displayname": "Kris",
  "net.f0rest.last_used": 1794396996013
}
```

Clients SHOULD record when a profile is used (i.e. a message is sent with it) and update this value.

### Sort flags

Profiles now can contain `net.f0rest.sort_flags`. This is used to dictate how profiles are displayed in a selection menu. This field is unstable and new features may be added in the future based on experimental research (e.g. tags, folders, parent/child relations, etc.)

```json
{
  "id": "9ced47e0-95d1-42a4-961d-680279b1a724",
  "displayname": "Kris",
  "net.f0rest.sort_flags": {
    "hidden": true
  }
}
```

If `hidden` is set, and the value is `true`, clients SHOULD hide this profile from a selection menu. However, this profile SHOULD become visible if searched for within that menu, making them 'unlisted'.

## Sable Extensible Profile Extension Parity

### Biography

Profiles now can contain `net.f0rest.biography`. This is displayed within a profile like a biography from an extensible profile. This field contains HTML, and is limited to 2048 characters due to strict message size concerns.

```json
{
  "id": "9ced47e0-95d1-42a4-961d-680279b1a724",
  "displayname": "Kris",
  "net.f0rest.biography": "<span>Kris, a human!<br>Attack is 35!<br>Defense is 7!<br>Magic is... none!<br>Has a knife!</span>"
}
```

This markup SHOULD be santisized in the same way that a message is before it is recorded, but MAY be further sanitized for safety.

### Banner

Profiles now can contain `net.f0rest.banner_url`. This is displayed within a profile like a banner from an extensible profile. This field MUST be a valid MXC URI to an image. Images SHOULD be presented in a 5:1 aspect ratio, or similar.

```json
{
  "id": "9ced47e0-95d1-42a4-961d-680279b1a724",
  "displayname": "Kris",
  "net.f0rest.banner_url": "mxc://example.com/xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
}
```

### Animal

Profiles now can contain `net.f0rest.is_animal`, `net.f0rest.has_animal`, `net.f0rest.animal_need`. These are cosmetic and are displayed on a profile.

```json
{
  "id": "9ced47e0-95d1-42a4-961d-680279b1a724",
  "displayname": "Kris",
  "net.f0rest.is_animal": "human",
  "net.f0rest.has_animal": "knife",
  "net.f0rest.animal_need": "The Roaring"
}
```

## Alternate Avatars

Profiles now can contain `net.f0rest.alternate_avatars`. These are used to allow a profile to contain multiple avatars, and choose to attach one to a message though a graphical selection menu, or through a command-like trigger. Alternate avatars contain an `id`, which MUST be unique for that profile, and `avatar_url`, which MUST be a valid MXC URI to an image.

```json
{
  "id": "9ced47e0-95d1-42a4-961d-680279b1a724",
  "displayname": "Kris",
  "net.f0rest.alternate_avatars": [
    {
      "avatar_url": "mxc://example.com/xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      "id": "a8af088c-d725-4b92-a47b-354beec9648d"
    }
  ]
}
```

### Triggers

Triggers now can contain `net.f0rest.alternate_avatar_id`. This is an optional string identifier to an [alternate avatar](#Alternate-avatars). This identifier SHOULD refer to an existing alternate avatar on this profile, and if it is found to not, clients SHOULD ignore this field during parsing.

```json
{
  "triggers": [
    {
      "prefix": "k:"
    },
    {
      "prefix": "k1:",
      "net.f0rest.alternate_avatar": "a8af088c-d725-4b92-a47b-354beec9648d"
    }
  ]
}
```

When a trigger does not specify an alternate avatar, the resulting message MUST NOT contain an alternate avatar. 'Latching' behavior must remove a latched alternate avatar.
