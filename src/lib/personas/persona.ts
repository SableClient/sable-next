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
      body: body.slice(trigger.prefix?.length ?? 0, body.length - (trigger.suffix?.length ?? 0)),
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

  const textNodes = (): Text[] => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const nodes: Text[] = [];
    while (walker.nextNode()) nodes.push(walker.currentNode as Text);
    return nodes;
  };
  const remove = (count: number, reverse: boolean): void => {
    for (const node of reverse ? textNodes().reverse() : textNodes()) {
      if (count === 0) return;
      const removed = Math.min(count, node.data.length);
      count -= removed;
      node.data = reverse ? node.data.slice(0, -removed) : node.data.slice(removed);
      if (node.data === '') node.remove();
    }
  };

  remove(prefix.length, false);
  remove(suffix.length, true);
  return document.body.innerHTML;
}

export function triggerLabel(trigger: PersonaTriggerView): string {
  return `${trigger.prefix ?? ''}text${trigger.suffix ?? ''}`;
}
