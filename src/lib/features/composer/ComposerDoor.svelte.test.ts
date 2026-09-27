// @vitest-environment happy-dom

import { render, screen } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { expect, test, vi } from 'vitest';

vi.mock('#lib/i18n.js', () => import('#lib/test-support/i18n.js'));

import ComposerDoor from './ComposerDoor.svelte';

test('offers a voice message only when the composer hands it a recorder', async () => {
  const user = userEvent.setup();
  const onVoice = vi.fn();
  render(ComposerDoor, { desktop: true, onPick: vi.fn(), onVoice });

  await user.click(screen.getByRole('button', { name: 'composer.insert' }));
  await user.click(await screen.findByRole('menuitem', { name: 'composer.voiceMessage' }));

  expect(onVoice).toHaveBeenCalledOnce();
});

test('leaves the voice message out without a recorder', async () => {
  const user = userEvent.setup();
  render(ComposerDoor, { desktop: true, onPick: vi.fn() });

  await user.click(screen.getByRole('button', { name: 'composer.insert' }));
  await screen.findByRole('menuitem', { name: 'composer.photoOrVideo' });

  expect(screen.queryByRole('menuitem', { name: 'composer.voiceMessage' })).not.toBeInTheDocument();
});
