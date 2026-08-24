import type { PerMessageProfileView } from '#src/generated/PerMessageProfileView';
import type { PersonaSelectionView } from '#src/generated/PersonaSelectionView';
import type { PersonaTriggerView } from '#src/generated/PersonaTriggerView';
import type { PersonaView } from '#src/generated/PersonaView';

export function projectPersona(persona: PersonaView, fallback: boolean): PerMessageProfileView {
  return {
    id: persona.id,
    display_name: persona.display_name,
    avatar_url: persona.avatar_url,
    pronouns: persona.pronouns,
    color_on_light: persona.color_on_light,
    color_on_dark: persona.color_on_dark,
    has_fallback: fallback,
  };
}

export function personaById(
  personas: readonly PersonaView[],
  id: string | undefined
): PersonaView | undefined {
  if (id === undefined) return undefined;
  return personas.find((persona) => persona.id === id);
}

function live(selection: PersonaSelectionView | undefined, now: number): boolean {
  if (!selection) return false;
  return selection.valid_until === null || selection.valid_until > now;
}

export function resolvePersona({
  personas,
  proxied,
  room,
  account,
  now,
}: {
  personas: readonly PersonaView[];
  proxied?: PersonaView | undefined;
  room?: PersonaSelectionView | undefined;
  account?: PersonaSelectionView | undefined;
  now: number;
}): PersonaView | undefined {
  if (proxied) return proxied;

  if (live(room, now)) {
    const selected = personaById(personas, room?.persona_id);
    if (selected) return selected;
  }
  if (live(account, now)) {
    const selected = personaById(personas, account?.persona_id);
    if (selected) return selected;
  }
  return undefined;
}

export interface ProxyMatch {
  persona: PersonaView;
  body: string;
}

function matches(trigger: PersonaTriggerView, body: string): boolean {
  const prefix = trigger.prefix ?? '';
  const suffix = trigger.suffix ?? '';
  if (prefix === '' && suffix === '') return false;
  if (body.length < prefix.length + suffix.length) return false;
  return body.startsWith(prefix) && body.endsWith(suffix);
}

export function resolveProxy(
  personas: readonly PersonaView[],
  body: string
): ProxyMatch | undefined {
  for (const persona of personas) {
    const trigger = persona.triggers.find((candidate) => matches(candidate, body));
    if (!trigger) continue;
    if (trigger.keep_trigger) return { persona, body };

    return {
      persona,
      body: body.slice(trigger.prefix?.length ?? 0, body.length - (trigger.suffix?.length ?? 0)),
    };
  }
  return undefined;
}

export function triggerLabel(trigger: PersonaTriggerView): string {
  return `${trigger.prefix ?? ''}text${trigger.suffix ?? ''}`;
}
