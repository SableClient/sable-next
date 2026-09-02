// @vitest-environment happy-dom

import { describe, expect, it } from 'vitest';

import type { PersonaTriggerView } from '#src/generated/PersonaTriggerView';
import type { PersonaView } from '#src/generated/PersonaView';

import {
  projectPersona,
  resolvePersona,
  resolveProxy,
  stripProxyHtml,
  triggerLabel,
} from './persona';

function persona(id: string, triggers: PersonaTriggerView[] = []): PersonaView {
  return {
    id,
    display_name: id,
    avatar_url: null,
    pronouns: [],
    color_on_light: null,
    color_on_dark: null,
    triggers,
    pluralkit: null,
  };
}

function trigger(
  prefix: string | null,
  suffix: string | null = null,
  keep = false
): PersonaTriggerView {
  return { prefix, suffix, keep_trigger: keep };
}

describe('resolveProxy', () => {
  it('strips a prefix trigger', () => {
    const kris = persona('Kris', [trigger('k:')]);
    expect(resolveProxy([kris], 'k:hello')).toEqual({
      persona: kris,
      body: 'hello',
      trigger: trigger('k:'),
    });
  });

  it('strips both ends of a circumfix', () => {
    const kris = persona('Kris', [trigger('[', ']')]);
    expect(resolveProxy([kris], '[hello]')?.body).toBe('hello');
  });

  it('keeps the trigger when the persona asks it to', () => {
    const kris = persona('Kris', [trigger('k:', null, true)]);
    expect(resolveProxy([kris], 'k:hello')?.body).toBe('k:hello');
  });

  it('takes the first matching persona in catalog order', () => {
    const first = persona('First', [trigger('[', ']')]);
    const second = persona('Second', [trigger('[')]);
    expect(resolveProxy([first, second], '[hello]')?.persona.id).toBe('First');
  });

  it('ignores a trigger with neither end, which would match everything', () => {
    expect(resolveProxy([persona('Kris', [trigger(null, null)])], 'hello')).toBeUndefined();
  });

  it('does not match a body shorter than its two ends together', () => {
    const kris = persona('Kris', [trigger('ab', 'cd')]);
    expect(resolveProxy([kris], 'abd')).toBeUndefined();
  });

  it('returns nothing when no trigger matches', () => {
    expect(resolveProxy([persona('Kris', [trigger('k:')])], 'hello')).toBeUndefined();
  });
});

describe('stripProxyHtml', () => {
  it('retains formatting after removing a prefix trigger', () => {
    expect(stripProxyHtml('k:<code>const answer = 42</code>', trigger('k:'))).toBe(
      '<code>const answer = 42</code>'
    );
  });

  it('retains formatting after removing a circumfix trigger', () => {
    expect(stripProxyHtml('[<em>test</em>]', trigger('[', ']'))).toBe('<em>test</em>');
  });

  it('does not strip HTML that does not contain the trigger as text', () => {
    expect(stripProxyHtml('<em>test</em>', trigger('k:'))).toBeNull();
  });
});

describe('resolvePersona', () => {
  const kris = persona('Kris');
  const robin = persona('Robin');
  const personas = [kris, robin];

  it('prefers a proxied persona over every stored selection', () => {
    const resolved = resolvePersona({
      personas,
      proxied: robin,
      room: { persona_id: 'Kris', valid_until: null },
      now: 1000,
    });
    expect(resolved?.id).toBe('Robin');
  });

  it('prefers the room over the account', () => {
    const resolved = resolvePersona({
      personas,
      room: { persona_id: 'Robin', valid_until: null },
      account: { persona_id: 'Kris', valid_until: null },
      now: 1000,
    });
    expect(resolved?.id).toBe('Robin');
  });

  it('falls through an expired room selection to the account', () => {
    const resolved = resolvePersona({
      personas,
      room: { persona_id: 'Robin', valid_until: 500 },
      account: { persona_id: 'Kris', valid_until: null },
      now: 1000,
    });
    expect(resolved?.id).toBe('Kris');
  });

  it('ignores a selection pointing at a deleted persona', () => {
    const resolved = resolvePersona({
      personas,
      room: { persona_id: 'Gone', valid_until: null },
      now: 1000,
    });
    expect(resolved).toBeUndefined();
  });

  it('resolves to nothing with no selection at all', () => {
    expect(resolvePersona({ personas, now: 1000 })).toBeUndefined();
  });
});

describe('projectPersona', () => {
  it('carries the fallback flag the core acts on', () => {
    expect(projectPersona(persona('Kris'), true).has_fallback).toBe(true);
    expect(projectPersona(persona('Kris'), false).has_fallback).toBe(false);
  });

  it('leaves the triggers and the import record behind', () => {
    const projected: Record<string, unknown> = projectPersona(
      persona('Kris', [trigger('k:')]),
      false
    );
    expect(projected.triggers).toBeUndefined();
    expect(projected.pluralkit).toBeUndefined();
  });
});

describe('triggerLabel', () => {
  it('shows where the text sits', () => {
    expect(triggerLabel(trigger('k:'))).toBe('k:text');
    expect(triggerLabel(trigger('[', ']'))).toBe('[text]');
    expect(triggerLabel(trigger(null, '-k'))).toBe('text-k');
  });
});
