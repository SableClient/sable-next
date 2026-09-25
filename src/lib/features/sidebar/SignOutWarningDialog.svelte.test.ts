// @vitest-environment happy-dom

import { mount, tick, unmount } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';

import type { CoreClient } from '#lib/core/client.svelte.js';
import type { SignOutSafetyView } from '#src/generated/protocol';

const mocks = vi.hoisted(() => ({
  goto: vi.fn(() => Promise.resolve()),
}));

vi.mock('$app/navigation', () => ({ goto: mocks.goto }));
vi.mock('$app/state', () => ({ page: { state: {}, url: new URL('http://localhost/profile') } }));
vi.mock('#lib/platform/overlay-back.svelte.js', () => ({
  afterOverlayPops: () => Promise.resolve(),
  holdOverlayBack: () => {},
}));

import { SignOutGuard } from './sign-out-guard.svelte.js';
import SignOutWarningDialog from './SignOutWarningDialog.svelte';

const safe: SignOutSafetyView = {
  encryption: {
    verification: 'verified',
    recovery: 'enabled',
    cross_signing_ready: true,
    recovery_passphrase: false,
  },
  backup_enabled: true,
  backup_uploaded: true,
  has_encrypted_rooms: true,
};

afterEach(() => {
  document.body.replaceChildren();
  mocks.goto.mockClear();
});

async function openWarning(safety: SignOutSafetyView) {
  const guard = new SignOutGuard({
    commands: { signOutSafety: () => Promise.resolve(safety) },
  } as unknown as CoreClient);
  const proceed = vi.fn(() => Promise.resolve());
  const instance = mount(SignOutWarningDialog, { target: document.body, props: { guard } });
  await guard.request(proceed);
  await tick();
  return { guard, proceed, instance };
}

function button(name: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll('button')].find(
    (candidate) => candidate.textContent.trim() === name
  );
}

test('stays closed when the sign-out is safe', async () => {
  const { proceed, instance } = await openWarning(safe);

  expect(proceed).toHaveBeenCalledOnce();
  expect(document.querySelector('[role="dialog"]')).toBeNull();

  await unmount(instance);
});

test('explains the risk and signs out only when asked to', async () => {
  const { proceed, instance } = await openWarning({
    ...safe,
    encryption: { ...safe.encryption, recovery: 'disabled' },
  });

  expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
    'Recovery is not set up.'
  );
  expect(proceed).not.toHaveBeenCalled();

  button('Log out anyway')?.click();
  await vi.waitFor(() => {
    expect(proceed).toHaveBeenCalledOnce();
  });

  await unmount(instance);
});

test('routes an unverified session to the security settings instead', async () => {
  const { guard, proceed, instance } = await openWarning({
    ...safe,
    encryption: { ...safe.encryption, verification: 'unverified' },
  });

  button('Verify this session')?.click();
  await vi.waitFor(() => {
    expect(mocks.goto).toHaveBeenCalledWith('/settings/devices');
  });
  expect(guard.risk).toBeNull();
  expect(proceed).not.toHaveBeenCalled();

  await unmount(instance);
});

test('offers only the export while keys are still uploading', async () => {
  const { instance } = await openWarning({ ...safe, backup_uploaded: false });

  expect(button('Export keys')).toBeDefined();
  expect(button('Set up recovery')).toBeUndefined();
  expect(button('Verify this session')).toBeUndefined();

  await unmount(instance);
});
