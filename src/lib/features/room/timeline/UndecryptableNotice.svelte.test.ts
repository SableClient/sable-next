// @vitest-environment happy-dom

import { fireEvent, render, screen } from '@testing-library/svelte';
import { expect, test, vi } from 'vitest';

vi.mock('#lib/core/context.js');
vi.mock('./utd-grace', () => ({ utdGraceRemaining: () => 0 }));

import { core } from '#lib/core/__mocks__/context.js';

import UndecryptableNotice from './UndecryptableNotice.svelte';

const retryDecryption = vi.fn(() => Promise.resolve());
Object.assign(core, { retryDecryption });

test('retries only the undecryptable session in its timeline', async () => {
  render(UndecryptableNotice, {
    id: 'item',
    cause: 'unknown',
    roomId: '!room:example.org',
    sessionId: 'session',
    sender: '@alice:example.org',
    threadRoot: '$thread',
  });

  await fireEvent.click(screen.getByRole('button', { name: 'Retry decryption' }));

  expect(retryDecryption).toHaveBeenCalledWith(
    '!room:example.org',
    'session',
    '@alice:example.org',
    '$thread'
  );
});

test('does not offer a retry without Megolm session metadata', () => {
  render(UndecryptableNotice, {
    id: 'item-without-session',
    cause: 'unknown',
    roomId: '!room:example.org',
    sessionId: null,
    sender: '@alice:example.org',
    threadRoot: null,
  });

  expect(screen.queryByRole('button', { name: 'Retry decryption' })).not.toBeInTheDocument();
});
