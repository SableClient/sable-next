// @vitest-environment happy-dom

import { render, screen } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { expect, test, vi } from 'vitest';

import type { PersonaView } from '#src/generated/protocol';

vi.mock('#lib/core/context.js');

import PersonaEditor from './PersonaEditor.svelte';
import { testPersona } from '#lib/personas/persona.ts';

const persona: PersonaView = {
  ...testPersona,
  id: 'kris',
  display_name: 'Kris',
  triggers: [
    { prefix: 'k:', suffix: null, keep_trigger: false, alternate_avatar_id: null },
    { prefix: null, suffix: '-kr', keep_trigger: true, alternate_avatar_id: null },
  ],
};

test('removing a trigger keeps the remaining rows and saves them unchanged', async () => {
  const onSave = vi.fn(() => Promise.resolve());
  const user = userEvent.setup();
  render(PersonaEditor, { open: true, persona, onSave, onOpenChange: vi.fn() });

  const after = await screen.findAllByRole('textbox', { name: 'After' });
  const kept = after[1];
  expect(kept).toHaveValue('-kr');

  await user.click(screen.getAllByRole('button', { name: 'Remove this trigger' })[0]);

  expect(screen.getAllByRole('textbox', { name: 'After' })).toEqual([kept]);
  expect(kept).toHaveValue('-kr');

  await user.click(screen.getByRole('button', { name: 'Save' }));

  expect(onSave).toHaveBeenCalledWith(
    expect.objectContaining({
      triggers: [{ prefix: null, suffix: '-kr', keep_trigger: true, alternate_avatar_id: null }],
    }),
    'kris',
    persona
  );
});

test('spaces inside a trigger survive saving while the outer edges are trimmed', async () => {
  const onSave = vi.fn(() => Promise.resolve());
  const user = userEvent.setup();
  render(PersonaEditor, { open: true, persona, onSave, onOpenChange: vi.fn() });

  const before = await screen.findAllByRole('textbox', { name: 'Before' });
  const after = await screen.findAllByRole('textbox', { name: 'After' });
  await user.clear(before[0]);
  await user.type(before[0], '  kr: ');
  await user.clear(after[1]);
  await user.type(after[1], ' -kr  ');
  await user.click(screen.getByRole('button', { name: 'Save' }));

  expect(onSave).toHaveBeenCalledWith(
    expect.objectContaining({
      triggers: [
        { prefix: 'kr: ', suffix: null, keep_trigger: false, alternate_avatar_id: null },
        { prefix: null, suffix: ' -kr', keep_trigger: true, alternate_avatar_id: null },
      ],
    }),
    'kris',
    persona
  );
});
