export const PRONOUNS_FIELD = 'io.fsky.nyx.pronouns';
export const NAME_COLOR_FIELD = 'eu.she-a.color';
export const STATUS_FIELD = 'm.status';
export const BANNER_FIELD = 'chat.commet.profile_banner';
export const BIO_FIELD = 'gay.fomx.biography';
export const LEGACY_BIO_FIELDS = ['moe.sable.app.bio', 'chat.commet.profile_bio'];
export const LEGACY_STATUS_FIELDS = ['chat.commet.profile_status', 'org.matrix.msc4426.status'];

export function legacyDeletes(present: string[], legacy: string[]): Array<[string, null]> {
  return legacy.filter((field) => present.includes(field)).map((field) => [field, null]);
}
