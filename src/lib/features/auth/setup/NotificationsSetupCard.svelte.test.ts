// @vitest-environment happy-dom

import { flushSync, mount, unmount } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';

vi.mock('#lib/core/context.js');
const present = vi.hoisted(() => ({
  permissionState: vi.fn(() => Promise.resolve('prompt' as string)),
  grantPermission: vi.fn(() => Promise.resolve(true)),
}));
vi.mock('#lib/features/notifications/present.js', () => present);
const prefs = vi.hoisted(() => ({ setPreference: vi.fn() }));
vi.mock('#lib/settings/preferences.svelte.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  setPreference: prefs.setPreference,
}));

import { core } from '#lib/core/__mocks__/context.js';

const setDefaultNotificationMode = vi.fn(() => Promise.resolve());
Object.assign(core, { setDefaultNotificationMode });

import NotificationsSetupCard from './NotificationsSetupCard.svelte';

async function render(askDefault = true) {
  const props = { askDefault, onComplete: vi.fn(), onSkip: vi.fn() };
  const instance = mount(NotificationsSetupCard, { target: document.body, props });
  await vi.waitFor(() => {
    expect(present.permissionState).toHaveBeenCalled();
  });
  await Promise.resolve();
  flushSync();
  return { instance, ...props };
}

const button = (name: RegExp) =>
  [...document.querySelectorAll('button')].find((element) => name.test(element.textContent.trim()));
const radio = (name: RegExp) =>
  [...document.querySelectorAll<HTMLElement>('[role="radio"]')].find((element) =>
    name.test(element.textContent)
  );

afterEach(() => {
  document.body.replaceChildren();
  vi.clearAllMocks();
});

test('mentions and keywords is the pre-selected group default, written to push rules', async () => {
  const { instance, onComplete } = await render();

  expect(radio(/Mentions and keywords/)?.getAttribute('aria-checked')).toBe('true');
  button(/^Continue$/)?.click();
  await vi.waitFor(() => {
    expect(onComplete).toHaveBeenCalledOnce();
  });
  expect(setDefaultNotificationMode).toHaveBeenCalledWith(false, 'mentions');

  await unmount(instance);
});

test('choosing all messages writes the spec default instead', async () => {
  const { instance } = await render();

  radio(/All messages/)?.click();
  flushSync();
  button(/^Continue$/)?.click();
  await vi.waitFor(() => {
    expect(setDefaultNotificationMode).toHaveBeenCalledWith(false, 'all');
  });

  await unmount(instance);
});

test('an account that already chose only asks this device for its permission', async () => {
  const { instance, onComplete } = await render(false);

  expect(radio(/All messages/)).toBeUndefined();
  button(/^Continue$/)?.click();
  expect(onComplete).toHaveBeenCalledOnce();
  expect(setDefaultNotificationMode).not.toHaveBeenCalled();

  await unmount(instance);
});

test('the OS prompt runs inside the click, and a grant turns the alerts on', async () => {
  const { instance } = await render();

  button(/Allow notifications/)?.click();
  expect(present.grantPermission).toHaveBeenCalledOnce();
  await vi.waitFor(() => {
    expect(prefs.setPreference).toHaveBeenCalledWith('systemNotifications', true);
  });
  expect(button(/Allow notifications/)).toBeUndefined();
  expect(document.body.textContent).toContain('Notifications are allowed');

  await unmount(instance);
});

test('a permission already denied is not asked for again', async () => {
  present.permissionState.mockResolvedValueOnce('denied');
  const { instance } = await render();

  expect(button(/Allow notifications/)).toBeUndefined();
  expect(document.body.textContent).toContain('blocked for Sable');

  await unmount(instance);
});

test('a failed write stays on the step and says so', async () => {
  setDefaultNotificationMode.mockRejectedValueOnce(new Error('offline'));
  const { instance, onComplete } = await render();

  button(/^Continue$/)?.click();
  await vi.waitFor(() => {
    expect(document.body.textContent).toContain("couldn't be saved");
  });
  expect(onComplete).not.toHaveBeenCalled();

  await unmount(instance);
});
