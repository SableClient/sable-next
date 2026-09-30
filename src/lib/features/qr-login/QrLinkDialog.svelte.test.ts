// @vitest-environment happy-dom

import { render, screen } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { tick } from 'svelte';
import { expect, test, vi } from 'vitest';

import type { CoreEvent } from '#src/generated/protocol';

vi.mock('#lib/core/context.js');
vi.mock('$app/navigation', () => import('#lib/test-support/app-navigation.js'));
vi.mock('$app/state', () => import('#lib/test-support/app-state.js'));

import { core as baseCore } from '#lib/core/__mocks__/context.js';

let listener: ((event: CoreEvent) => void) | null = null;
const core = Object.assign(baseCore, {
  subscribeEvents: vi.fn((next: (event: CoreEvent) => void) => {
    listener = next;
    return () => {
      listener = null;
    };
  }),
  startQrLogin: vi.fn(() => Promise.resolve()),
  startQrGrant: vi.fn(() => Promise.resolve()),
  qrCheckCode: vi.fn(() => Promise.resolve()),
  cancelQr: vi.fn(() => Promise.resolve()),
});

import QrLinkDialog from './QrLinkDialog.svelte';

async function emit(progress: Extract<CoreEvent, { type: 'qr_login' }>['progress'], grant = true) {
  listener?.({ type: 'qr_login', grant, progress });
  await tick();
}

test('points QR sign-in instructions to Account settings', async () => {
  const user = userEvent.setup();
  render(QrLinkDialog, { open: true, mode: 'login' });

  await user.click(await screen.findByRole('button', { name: 'Scan a QR code' }));
  expect(screen.getByRole('dialog')).toHaveTextContent(
    'On your signed-in device, open Settings → Account, choose Link a new device and scan the code it shows.'
  );

  await user.click(screen.getByRole('button', { name: 'Back' }));
  await user.click(screen.getByRole('button', { name: 'Show a QR code' }));
  await emit({ stage: 'show_code', code: { width: 21, modules: '1'.repeat(441) } }, false);
  expect(screen.getByRole('dialog')).toHaveTextContent(
    'On your signed-in device, open Settings → Account, choose Link a new device and scan this code.'
  );
});

test('links a new device through the code, the check number and a clear failure', async () => {
  const user = userEvent.setup();
  render(QrLinkDialog, { open: true, mode: 'grant' });

  await user.click(await screen.findByRole('button', { name: 'Show a QR code' }));
  expect(core.startQrGrant).toHaveBeenCalledWith(null);

  await emit({ stage: 'show_code', code: { width: 21, modules: '1'.repeat(441) } });
  expect(screen.getByRole('img', { name: 'QR code for signing in' })).toBeInTheDocument();

  await emit({ stage: 'enter_check_code' });
  const field = screen.getByLabelText('Two-digit number');
  expect(field).toHaveFocus();
  await user.type(field, '42');
  await user.click(screen.getByRole('button', { name: 'Confirm' }));
  expect(core.qrCheckCode).toHaveBeenCalledWith(42);

  await emit({ stage: 'show_check_code', check_code: 7 });
  expect(screen.getByRole('status')).toHaveTextContent('Your number is 7.');

  await emit({ stage: 'failed', reason: 'unsupported' });
  expect(screen.getByRole('status')).toHaveTextContent(
    "Your homeserver doesn't support signing in with a QR code."
  );
  expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument();
});
