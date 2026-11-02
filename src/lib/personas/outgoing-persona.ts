import type { PerMessageProfileView } from '#src/generated/protocol';
import { preferences } from '#lib/settings/preferences.svelte.js';
import type { PersonaStore } from './personas.svelte.js';
import {
  alternateAvatarId,
  heldSelection,
  projectPersona,
  resolvePersona,
  resolveProxy,
  stripProxyHtml,
} from './persona.js';

export function outgoingPersona(
  personas: PersonaStore,
  targetRoomId: string,
  spaceIds: readonly string[],
  body = '',
  formatted: string | null = null
): { body: string; formatted: string | null; persona: PerMessageProfileView | null } {
  const proxied = preferences.personaProxying ? resolveProxy(personas.personas, body) : undefined;
  const scope = {
    personas: personas.personas,
    room: personas.associationFor(targetRoomId),
    spaces: spaceIds.map((id) => personas.associationFor(id)),
    account: personas.selectionFor(null) ?? undefined,
    now: Date.now(),
  };
  const persona = resolvePersona({ ...scope, proxied: proxied?.persona });

  if (!persona) return { body, formatted, persona: null };
  const alternate_avatar_id = alternateAvatarId(persona, proxied?.trigger, heldSelection(scope));
  if (proxied && preferences.personaKeepAfterShorthand) {
    const spaces = { target: spaceIds[0] ?? null, order: spaceIds };
    void personas
      .remember(
        personas.scopeFor(preferences.personaSelectionScope, targetRoomId, spaces),
        targetRoomId,
        spaces,
        proxied.persona.id,
        alternate_avatar_id
      )
      .catch((error: unknown) => {
        console.warn('[sable personas] latching failed', error);
      });
  }
  const basePersona = { ...persona };
  persona.last_used = Date.now();
  personas.save(persona, persona.id, basePersona).catch((error: unknown) => {
    console.warn('[sable personas] updating timestamp failed', error);
  });

  const avatar_url =
    (alternate_avatar_id
      ? persona.alternate_avatars?.find((avatar) => avatar.id == alternate_avatar_id)
      : undefined
    )?.avatar_url ?? persona.avatar_url;

  return {
    body: proxied?.body ?? body,
    formatted: proxied ? stripProxyHtml(formatted, proxied.trigger) : formatted,
    persona: projectPersona({ ...persona, avatar_url }, preferences.personaFallback),
  };
}
