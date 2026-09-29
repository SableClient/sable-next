import { expect, test, vi } from 'vitest';

import type { CoreEvent } from '#src/generated/protocol';
import { CoreError } from '#src/transport';

import { QrFlow, type QrFlowCore } from './qr-flow.svelte';

function fakeCore() {
  let listener: ((event: CoreEvent) => void) | null = null;
  const core = {
    subscribeEvents: vi.fn((next: (event: CoreEvent) => void) => {
      listener = next;
      return () => {
        listener = null;
      };
    }),
    startQrLogin: vi.fn(() => Promise.resolve()),
    finishQrLogin: vi.fn(() => Promise.resolve()),
    startQrGrant: vi.fn(() => Promise.resolve()),
    qrCheckCode: vi.fn(() => Promise.resolve()),
    qrGrantContinue: vi.fn(() => Promise.resolve()),
    cancelQr: vi.fn(() => Promise.resolve()),
  } satisfies QrFlowCore;
  const emit = (event: CoreEvent) => {
    listener?.(event);
  };
  return { core, emit };
}

test('a new device scanning a code signs in against the homeserver the code names', async () => {
  const { core } = fakeCore();
  const flow = new QrFlow(
    core,
    () => 'login',
    () => ({ homeserver: () => 'example.org', redirectUri: () => 'https://app.example/callback' })
  );

  await flow.scanned(new Uint8Array([1, 2, 3]));

  expect(core.startQrLogin).toHaveBeenCalledWith(
    'example.org',
    'https://app.example/callback',
    'AQID'
  );
});

test('progress follows the core, and signing in finishes the session', async () => {
  const { core, emit } = fakeCore();
  const onSignedIn = vi.fn();
  const flow = new QrFlow(
    core,
    () => 'login',
    () => null,
    onSignedIn
  );
  const stop = flow.listen();

  emit({ type: 'qr_login', grant: false, progress: { stage: 'enter_check_code' } });
  expect(flow.progress).toEqual({ stage: 'enter_check_code' });

  emit({ type: 'qr_login', grant: true, progress: { stage: 'done' } });
  expect(flow.progress).toEqual({ stage: 'enter_check_code' });

  emit({
    type: 'qr_login',
    grant: false,
    progress: { stage: 'signed_in', user_id: '@ana:example.org' },
  });
  await vi.waitFor(() => {
    expect(onSignedIn).toHaveBeenCalled();
  });
  expect(core.finishQrLogin).toHaveBeenCalledWith('@ana:example.org');
  stop();
  expect(core.cancelQr).toHaveBeenCalled();
});

test('a signed-in device lets another one in by showing a code', async () => {
  const { core } = fakeCore();
  const flow = new QrFlow(core, () => 'grant');

  await flow.showCode();
  await flow.submitCheckCode(42);
  await flow.continueGrant(true);

  expect(core.startQrGrant).toHaveBeenCalledWith(null);
  expect(core.qrCheckCode).toHaveBeenCalledWith(42);
  expect(core.qrGrantContinue).toHaveBeenCalledWith(true);
});

test('continues the grant when the other device confirms the check code', async () => {
  const { core, emit } = fakeCore();
  const flow = new QrFlow(core, () => 'grant');
  const stop = flow.listen();

  emit({
    type: 'qr_login',
    grant: true,
    progress: { stage: 'waiting_for_auth', verification_uri: 'https://auth.example/approve' },
  });

  await vi.waitFor(() => {
    expect(core.qrGrantContinue).toHaveBeenCalledWith(true);
  });
  stop();
});

test('a refused step is reported as a failure', async () => {
  const { core } = fakeCore();
  core.startQrGrant.mockRejectedValue(new Error('no session'));
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const flow = new QrFlow(core, () => 'grant');

  await flow.showCode();

  expect(flow.progress).toEqual({ stage: 'failed', reason: 'other' });
});

test('a code from the wrong side is named as such', async () => {
  const { core } = fakeCore();
  core.startQrGrant.mockRejectedValue(new CoreError({ code: 'denied' }));
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const flow = new QrFlow(core, () => 'grant');

  await flow.scanned(new Uint8Array([1]));

  expect(flow.progress).toEqual({ stage: 'failed', reason: 'wrong_code' });
  expect(core.cancelQr).toHaveBeenCalled();
});

test('a second press while a step is in flight sends nothing', async () => {
  const { core } = fakeCore();
  let finish = () => {};
  core.qrCheckCode.mockReturnValue(new Promise<void>((resolve) => (finish = resolve)));
  const flow = new QrFlow(core, () => 'grant');

  const first = flow.submitCheckCode(42);
  await flow.submitCheckCode(42);
  finish();
  await first;

  expect(core.qrCheckCode).toHaveBeenCalledOnce();
  expect(flow.progress).toBeNull();
});
