import type {
  PerMessageProfileView,
  PersonaSelectionView,
  PersonaTriggerView,
  PersonaView,
} from '#src/generated/protocol';

export function projectPersona(persona: PersonaView, fallback: boolean): PerMessageProfileView {
  return {
    id: persona.id,
    display_name: persona.display_name,
    avatar_url: persona.avatar_url,
    pronouns: persona.pronouns,
    color_on_light: persona.color_on_light,
    color_on_dark: persona.color_on_dark,
    has_fallback: fallback,
    biography: persona.biography,
    banner_url: persona.banner_url,
    is_animal: persona.is_animal,
    has_animal: persona.has_animal,
    animal_need: persona.animal_need,
  };
}

export function personaById(
  personas: readonly PersonaView[],
  id: string | undefined
): PersonaView | undefined {
  if (id === undefined) return undefined;
  return personas.find((persona) => persona.id === id);
}

export function filterPersonas(personas: readonly PersonaView[], query: string): PersonaView[] {
  const needle = query.trim().toLocaleLowerCase();
  return personas.filter(
    (persona) =>
      persona.display_name.toLocaleLowerCase().includes(needle) ||
      persona.id.toLocaleLowerCase().includes(needle)
  );
}

export function reorderPersonas(
  personas: readonly PersonaView[],
  from: number,
  to: number
): PersonaView[] {
  if (from === to || from < 0 || to < 0 || from >= personas.length || to >= personas.length) {
    return [...personas];
  }
  const reordered = [...personas];
  const [persona] = reordered.splice(from, 1);
  reordered.splice(to, 0, persona);
  return reordered;
}

function live(selection: PersonaSelectionView | undefined, now: number): boolean {
  if (!selection) return false;
  return selection.valid_until === null || selection.valid_until > now;
}

/** `'account'` sends as the account but lets triggers proxy, `false` turns personas off. */
export type PersonaAssociation = PersonaSelectionView | 'account' | false | undefined;

export type SelectionScope = 'room' | 'space' | 'account';

interface PersonaScope {
  personas: readonly PersonaView[];
  room?: PersonaAssociation;
  spaces?: readonly PersonaAssociation[];
  account?: PersonaSelectionView | undefined;
  now: number;
}

export function heldSelection({
  personas,
  room,
  spaces = [],
  account,
  now,
}: PersonaScope): PersonaAssociation {
  for (const selection of [room, ...spaces, account]) {
    if (selection === false || selection === 'account') return selection;
    if (live(selection, now) && personaById(personas, selection?.persona_id)) return selection;
  }
  return undefined;
}

export function resolvePersona({
  proxied,
  ...scope
}: PersonaScope & { proxied?: PersonaView | undefined }): PersonaView | undefined {
  const held = heldSelection(scope);
  if (held === false) return undefined;
  if (proxied) return proxied;
  return held === 'account' ? undefined : personaById(scope.personas, held?.persona_id);
}

export function alternateAvatarId(
  persona: PersonaView,
  trigger: PersonaTriggerView | undefined,
  held: PersonaAssociation
): string | null {
  return trigger
    ? trigger.alternate_avatar_id
    : held && held !== 'account' && held.persona_id === persona.id
      ? held.alternate_avatar_id
      : null;
}

export interface ProxyMatch {
  persona: PersonaView;
  body: string;
  trigger: PersonaTriggerView;
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
    if (trigger.keep_trigger) return { persona, body, trigger };

    return {
      persona,
      body: body
        .slice(trigger.prefix?.length ?? 0, body.length - (trigger.suffix?.length ?? 0))
        .trim(),
      trigger,
    };
  }
  return undefined;
}

/** Removes a matched proxy wrapper without discarding the message's rich HTML. */
export function stripProxyHtml(
  formatted: string | null,
  trigger: PersonaTriggerView
): string | null {
  if (!formatted || trigger.keep_trigger) return formatted;

  const prefix = trigger.prefix ?? '';
  const suffix = trigger.suffix ?? '';
  const document = new DOMParser().parseFromString(formatted, 'text/html');
  const text = document.body.textContent;
  if (
    !text.startsWith(prefix) ||
    !text.endsWith(suffix) ||
    text.length < prefix.length + suffix.length
  ) {
    return null;
  }

  const leaves = (): Node[] => {
    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT
    );
    const nodes: Node[] = [];
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (node instanceof Text || node.childNodes.length === 0) nodes.push(node);
    }
    return nodes;
  };
  const strip = (count: number, reverse: boolean): void => {
    for (const node of reverse ? leaves().reverse() : leaves()) {
      if (count === 0 || !(node instanceof Text)) return;
      const removed = Math.min(count, node.data.length);
      count -= removed;
      node.data = reverse ? node.data.slice(0, -removed) : node.data.slice(removed);
      if (node.data === '') node.remove();
    }
  };
  const trim = (reverse: boolean): void => {
    for (const node of reverse ? leaves().reverse() : leaves()) {
      if (!(node instanceof Text)) return;
      node.data = reverse ? node.data.trimEnd() : node.data.trimStart();
      if (node.data !== '') return;
      node.remove();
    }
  };

  strip(prefix.length, false);
  strip(suffix.length, true);
  trim(false);
  trim(true);
  return document.body.innerHTML;
}

export function triggerLabel(trigger: PersonaTriggerView): string {
  return `${trigger.prefix ?? ''}text${trigger.suffix ?? ''}`;
}

export const testPersona: PersonaView = {
  id: 'kris',
  display_name: 'Kris',
  avatar_url: null,
  pronouns: [],
  color_on_light: null,
  color_on_dark: null,
  triggers: [],
  pluralkit: null,
  last_used: null,
  alternate_avatars: null,
  biography: null,
  banner_url: null,
  is_animal: null,
  has_animal: null,
  animal_need: null,
  sort_flags: null,
};
