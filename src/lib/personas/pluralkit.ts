import * as v from 'valibot';

import type { PersonaTriggerView, PersonaView, PronounView } from '#src/generated/protocol';
import { splitPluralkitNamePronouns } from './pronouns';

const OptionalText = v.nullish(v.string());
const MemberSchema = v.looseObject({
  id: v.string(),
  name: v.string(),
  uuid: OptionalText,
  display_name: OptionalText,
  color: OptionalText,
  pronouns: OptionalText,
  avatar_url: OptionalText,
  description: OptionalText,
  proxy_tags: v.nullish(v.array(v.looseObject({ prefix: OptionalText, suffix: OptionalText }))),
});
const MembersSchema = v.array(MemberSchema);
const ExportSchema = v.union([
  MembersSchema,
  v.pipe(
    v.object({ members: MembersSchema }),
    v.transform((value) => value.members)
  ),
]);

export type PluralkitMember = v.InferOutput<typeof MemberSchema>;

const API = 'https://api.pluralkit.me/v2';

export function systemIdFromInput(input: string): string {
  const trimmed = input.trim();
  const fromUrl = /pluralkit\.me\/(?:v2\/)?systems\/([^/?#]+)/i.exec(trimmed);
  if (fromUrl?.[1]) return fromUrl[1];
  return trimmed.replace(/^pk;?\s*/i, '');
}

export async function fetchPluralkitMembers(
  systemId: string,
  token: string | null = null
): Promise<PluralkitMember[]> {
  const response = await fetch(`${API}/systems/${encodeURIComponent(systemId)}/members`, {
    headers: token ? { Authorization: token } : undefined,
  });
  if (!response.ok) throw new Error(`pluralkit responded ${String(response.status)}`);

  const result = v.safeParse(MembersSchema, await response.json());
  if (!result.success) throw new Error('pluralkit returned an invalid member list');
  return result.output;
}

export function parsePluralkitExport(text: string): PluralkitMember[] {
  const result = v.safeParse(ExportSchema, JSON.parse(text));
  if (!result.success) {
    throw new Error('not a PluralKit member list');
  }
  return result.output;
}

function colors(
  color: string | null | undefined
): Pick<PersonaView, 'color_on_light' | 'color_on_dark'> {
  if (!color || !/^#?[0-9a-f]{6}$/i.test(color)) {
    return { color_on_light: null, color_on_dark: null };
  }
  const hex = color.startsWith('#') ? color : `#${color}`;
  return { color_on_light: hex, color_on_dark: hex };
}

function pronouns(value: string | null | undefined): PronounView[] {
  if (!value) return [];
  return value
    .split(/[,;]/)
    .map((set) => set.trim())
    .filter((set) => set !== '')
    .map((summary) => ({ summary, language: null }));
}

function triggers(tags: PluralkitMember['proxy_tags']): PersonaTriggerView[] {
  return (tags ?? [])
    .map((tag) => ({
      prefix: tag.prefix ?? null,
      suffix: tag.suffix ?? null,
      keep_trigger: false,
      alternate_avatar_id: null,
    }))
    .filter((trigger) => trigger.prefix !== null || trigger.suffix !== null);
}

export type PluralkitImportOptions = {
  extractPronouns?: boolean;
};

export function personaFromPluralkit(
  id: string,
  member: PluralkitMember,
  avatarUrl: string | null,
  options: PluralkitImportOptions = {},
  existing?: PersonaView
): PersonaView {
  let display_name = member.display_name?.trim();
  let pronoun_set = pronouns(member.pronouns);

  if (options.extractPronouns && display_name) {
    const parsed = splitPluralkitNamePronouns(display_name);
    display_name = parsed.name;
    pronoun_set = parsed.pronouns;
  }

  return {
    id,
    display_name: display_name || member.name,
    avatar_url: avatarUrl,
    pronouns: pronoun_set,
    ...colors(member.color),
    triggers: triggers(member.proxy_tags).map((trigger) => {
      const kept = existing?.triggers.find(
        (old) => old.prefix === trigger.prefix && old.suffix === trigger.suffix
      );
      return kept
        ? {
            ...trigger,
            keep_trigger: kept.keep_trigger,
            alternate_avatar_id: kept.alternate_avatar_id,
          }
        : trigger;
    }),
    pluralkit: {
      id: member.id,
      uuid: member.uuid ?? null,
      avatar_url: member.avatar_url ?? null,
      description: existing?.pluralkit?.description ?? null,
    },
    last_used: existing?.last_used ?? null,
    alternate_avatars: existing?.alternate_avatars ?? null,
    biography: existing?.biography ?? null,
    banner_url: existing?.banner_url ?? null,
    is_animal: existing?.is_animal ?? null,
    has_animal: existing?.has_animal ?? null,
    animal_need: existing?.animal_need ?? null,
    sort_flags: existing?.sort_flags ?? null,
  };
}

export function matchImported(
  personas: readonly PersonaView[],
  member: PluralkitMember
): PersonaView | undefined {
  return personas.find(
    (persona) =>
      persona.pluralkit !== null &&
      ((member.uuid != null && persona.pluralkit.uuid === member.uuid) ||
        persona.pluralkit.id === member.id)
  );
}
