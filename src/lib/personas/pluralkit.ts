import type { PersonaTriggerView } from '#src/generated/PersonaTriggerView';
import type { PersonaView } from '#src/generated/PersonaView';
import type { PronounView } from '#src/generated/PronounView';

export interface PluralkitMember {
  id: string;
  uuid?: string | null;
  name: string;
  display_name?: string | null;
  color?: string | null;
  pronouns?: string | null;
  avatar_url?: string | null;
  description?: string | null;
  proxy_tags?: { prefix?: string | null; suffix?: string | null }[] | null;
}

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

  const members: unknown = await response.json();
  if (!Array.isArray(members)) throw new Error('pluralkit returned no member list');
  return members as PluralkitMember[];
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
    }))
    .filter((trigger) => trigger.prefix !== null || trigger.suffix !== null);
}

export function personaFromPluralkit(
  member: PluralkitMember,
  avatarUrl: string | null
): PersonaView {
  return {
    id: member.name,
    display_name: member.display_name?.trim() || member.name,
    avatar_url: avatarUrl,
    pronouns: pronouns(member.pronouns),
    ...colors(member.color),
    triggers: triggers(member.proxy_tags),
    pluralkit: {
      id: member.id,
      uuid: member.uuid ?? null,
      avatar_url: member.avatar_url ?? null,
      description: member.description ?? null,
    },
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
