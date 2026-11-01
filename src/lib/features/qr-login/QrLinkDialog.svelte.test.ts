// @vitest-environment happy-dom

import { render, screen } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { tick } from 'svelte';
import { beforeEach, expect, test, vi } from 'vitest';

import type { CoreEvent } from '#src/generated/protocol';

vi.mock('#lib/core/context.js');
vi.mock('$app/navigation', () => import('#lib/test-support/app-navigation.js'));
vi.mock('$app/state', () => import('#lib/test-support/app-state.js'));
const browser = vi.hoisted(() => ({
  navigate: vi.fn(() => Promise.resolve(false)),
  close: vi.fn(),
}));
vi.mock('#lib/platform/external-auth.js', () => ({
  isDesktopAuthClient: vi.fn(() => true),
  openSystemAuthUrl: vi.fn(() => Promise.resolve()),
  openExternalAuthWindow: vi.fn(() => browser),
}));

import { core as baseCore } from '#lib/core/__mocks__/context.js';
import {
  openExternalAuthWindow,
  isDesktopAuthClient,
  openSystemAuthUrl,
} from '#lib/platform/external-auth.js';

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
  qrGrantContinue: vi.fn(() => Promise.resolve()),
  cancelQr: vi.fn(() => Promise.resolve()),
});

import QrLinkDialog from './QrLinkDialog.svelte';

beforeEach(() => {
  vi.clearAllMocks();
  browser.navigate.mockResolvedValue(false);
  vi.mocked(openExternalAuthWindow).mockReturnValue(browser);
  vi.mocked(isDesktopAuthClient).mockReturnValue(true);
  vi.mocked(openSystemAuthUrl).mockResolvedValue(undefined);
});

async function emit(progress: Extract<CoreEvent, { type: 'qr_login' }>['progress'], grant = true) {
  listener?.({ type: 'qr_login', grant, progress });
  await tick();
}

test('opens device approval through the authentication browser', async () => {
  const user = userEvent.setup();
  render(QrLinkDialog, { open: true, mode: 'grant' });

  const uri = 'https://auth.example.org/device?user_code=ABCD';
  await emit({ stage: 'waiting_for_auth', verification_uri: uri });
  await user.click(screen.getByRole('button', { name: 'Open the approval page' }));

  expect(openExternalAuthWindow).toHaveBeenCalledWith(expect.stringMatching(/^sable-qr-/), {
    sheet: true,
  });
  expect(browser.navigate).toHaveBeenCalledExactlyOnceWith(uri);
  expect(core.cancelQr).not.toHaveBeenCalled();
});

test('shows approval browser errors and allows retrying without cancelling the link', async () => {
  const user = userEvent.setup();
  browser.navigate.mockRejectedValueOnce('activity class not found');
  render(QrLinkDialog, { open: true, mode: 'grant' });

  const uri = 'https://auth.example.org/device?user_code=ABCD';
  await emit({ stage: 'waiting_for_auth', verification_uri: uri });
  const button = screen.getByRole('button', { name: 'Open the approval page' });
  await user.click(button);

  expect(screen.getByRole('alert')).toHaveTextContent(
    'Could not open the approval page. Try again.'
  );
  expect(button).toBeEnabled();
  expect(core.cancelQr).not.toHaveBeenCalled();

  await user.click(button);
  expect(browser.navigate).toHaveBeenCalledTimes(2);
  expect(browser.navigate).toHaveBeenLastCalledWith(uri);
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(core.cancelQr).not.toHaveBeenCalled();
});

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
    'Your homeserver doesn’t support signing in with a QR code.'
  );
  expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument();
});

test.each(['syncing_secrets', 'done', 'failed'] as const)(
  'closes approval when QR linking reaches %s',
  async (stage) => {
    const user = userEvent.setup();
    render(QrLinkDialog, { open: true, mode: 'grant' });
    await emit({ stage: 'waiting_for_auth', verification_uri: 'https://auth.example.org/device' });
    await user.click(screen.getByRole('button', { name: 'Open the approval page' }));
    expect(browser.close).not.toHaveBeenCalled();
    await emit(stage === 'failed' ? { stage, reason: 'other' } : { stage });
    expect(browser.close).toHaveBeenCalledOnce();
  }
);

test('closes approval when the dialog is disposed', async () => {
  const user = userEvent.setup();
  const { unmount } = render(QrLinkDialog, { open: true, mode: 'grant' });
  await emit({ stage: 'waiting_for_auth', verification_uri: 'https://auth.example.org/device' });
  await user.click(screen.getByRole('button', { name: 'Open the approval page' }));
  unmount();
  expect(browser.close).toHaveBeenCalledOnce();
});

test('offers a retry when the popup is blocked', async () => {
  vi.mocked(openExternalAuthWindow).mockReturnValueOnce(null);
  const user = userEvent.setup();
  render(QrLinkDialog, { open: true, mode: 'grant' });
  await emit({ stage: 'waiting_for_auth', verification_uri: 'https://auth.example.org/device' });
  await user.click(screen.getByRole('button', { name: 'Open the approval page' }));
  expect(screen.getByRole('alert')).toHaveTextContent(
    'Could not open the approval page. Try again.'
  );
  expect(core.cancelQr).not.toHaveBeenCalled();
});

test('finishes closing the previous browser before reopening approval', async () => {
  let finishClosing: () => void = () => {};
  const first = {
    navigate: vi.fn().mockResolvedValue(false),
    close: vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishClosing = resolve;
        })
    ),
  };
  const second = { navigate: vi.fn().mockResolvedValue(false), close: vi.fn() };
  vi.mocked(openExternalAuthWindow).mockReturnValueOnce(first).mockReturnValueOnce(second);
  const user = userEvent.setup();
  render(QrLinkDialog, { open: true, mode: 'grant' });
  const uri = 'https://auth.example.org/device';
  await emit({ stage: 'waiting_for_auth', verification_uri: uri });
  const button = screen.getByRole('button', { name: 'Open the approval page' });
  await user.click(button);
  expect(first.navigate).toHaveBeenCalledWith(uri);
  await user.click(button);
  expect(first.close).toHaveBeenCalledOnce();
  expect(second.navigate).not.toHaveBeenCalled();
  finishClosing();
  await vi.waitFor(() => {
    expect(second.navigate).toHaveBeenCalledWith(uri);
  });
});

test('opens desktop approval externally without restarting QR login', async () => {
  const user = userEvent.setup();
  render(QrLinkDialog, { open: true, mode: 'grant' });
  const uri = 'https://auth.example.org/device?user_code=ABCD';
  await emit({ stage: 'waiting_for_auth', verification_uri: uri });
  await user.click(screen.getByRole('button', { name: 'Open the approval page' }));
  await user.click(screen.getByRole('button', { name: 'Open in browser' }));
  expect(openSystemAuthUrl).toHaveBeenCalledExactlyOnceWith(uri);
  expect(browser.close).toHaveBeenCalledOnce();
  expect(core.cancelQr).not.toHaveBeenCalled();
  expect(core.startQrGrant).not.toHaveBeenCalled();
});

test('keeps approval open if the system browser cannot launch', async () => {
  vi.mocked(openSystemAuthUrl).mockRejectedValueOnce('Browser unavailable');
  const user = userEvent.setup();
  render(QrLinkDialog, { open: true, mode: 'grant' });
  await emit({ stage: 'waiting_for_auth', verification_uri: 'https://auth.example.org/device' });
  await user.click(screen.getByRole('button', { name: 'Open the approval page' }));
  await user.click(screen.getByRole('button', { name: 'Open in browser' }));
  expect(screen.getByRole('alert')).toHaveTextContent(
    'Could not open the approval page. Try again.'
  );
  expect(browser.close).not.toHaveBeenCalled();
  expect(core.cancelQr).not.toHaveBeenCalled();
});

test('keeps mobile approval inside the app', async () => {
  vi.mocked(isDesktopAuthClient).mockReturnValue(false);
  render(QrLinkDialog, { open: true, mode: 'grant' });
  await emit({ stage: 'waiting_for_auth', verification_uri: 'https://auth.example.org/device' });
  expect(screen.queryByRole('button', { name: 'Open in browser' })).not.toBeInTheDocument();
});
