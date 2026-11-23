// @vitest-environment happy-dom

import { render, screen } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { expect, test, vi } from 'vitest';

import type { ReactionGroup } from '#src/generated/protocol';

vi.mock('#lib/core/context.js');
vi.mock('#lib/i18n.js', () => import('#lib/test-support/i18n.js'));
vi.mock('#lib/rooms/presence.svelte.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('#lib/rooms/presence.svelte.js')>()),
  usePresenceStore: () => ({ get: () => null, peek: () => null }),
}));

import ReactionsDialogHarness from './ReactionsDialogHarness.test.svelte';

const thumbs: ReactionGroup = { key: '👍', senders: ['@alice:example.org'] };
const heart: ReactionGroup = { key: '❤️', senders: ['@bob:example.org'] };
const laugh: ReactionGroup = { key: '😂', senders: ['@carol:example.org'] };

function dialog(reactions: ReactionGroup[]) {
  return {
    dialog: { open: true, reactions, roomId: '!room:example.org', eventId: '$event', members: [] },
  };
}

// Reactions sync live, so an earlier one can disappear while the dialog is open.
test('the chosen reaction stays shown when an earlier reaction is removed', async () => {
  const user = userEvent.setup();
  const view = render(ReactionsDialogHarness, dialog([thumbs, heart, laugh]));
  await user.click(await screen.findByRole('tab', { name: /😂/ }));

  await view.rerender(dialog([heart, laugh]));

  // Not the first tab, which is also what an unknown choice falls back to.
  expect(screen.getByRole('tab', { name: /😂/ })).toHaveAttribute('aria-selected', 'true');
  expect(screen.getByText('@carol:example.org')).toBeInTheDocument();
});

test('the first reaction is shown once the chosen one is gone', async () => {
  const user = userEvent.setup();
  const view = render(ReactionsDialogHarness, dialog([thumbs, heart, laugh]));
  await user.click(await screen.findByRole('tab', { name: /❤️/ }));

  await view.rerender(dialog([thumbs, laugh]));

  expect(screen.getByRole('tab', { name: /👍/ })).toHaveAttribute('aria-selected', 'true');
  expect(screen.getByText('@alice:example.org')).toBeInTheDocument();
});
