// @vitest-environment happy-dom

import { mount, unmount } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';

vi.mock('#lib/core/context.js');

import { core as baseCore } from '#lib/core/__mocks__/context.js';

type Mode = 'off' | 'notify' | 'loud';

const core = Object.assign(baseCore, {
  session: { user_id: '@erwan:example.org' },
  userProfile: vi.fn(() => Promise.resolve({ display_name: 'Erwan' })),
  mentionNotifications: vi.fn<() => Promise<Record<string, Mode | null>>>(),
  setMentionNotifications: vi.fn<(rule: string, mode: Mode) => Promise<void>>(),
});

import MentionNotifications from './MentionNotifications.svelte';

afterEach(() => {
  document.body.replaceChildren();
  vi.clearAllMocks();
});

const loaded = { room: 'notify', user: 'loud', display_name: 'off', username: 'loud' } as const;

function selector(label: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(`[aria-label='${label}']`);
  if (element === null) throw new Error(`expected the ${label} selector`);
  return element;
}

test('shows every mention rule at its account mode', async () => {
  core.mentionNotifications.mockResolvedValue(loaded);

  const instance = mount(MentionNotifications, { target: document.body });

  await vi.waitFor(() => {
    expect(selector('Mentions of your user ID (@erwan:example.org)').textContent).toContain('Loud');
  });
  expect(selector('Messages with your display name (Erwan)').textContent).toContain('Off');
  expect(selector('Messages with your username (erwan)').textContent).toContain('Loud');
  expect(selector('Mention @room').textContent).toContain('Notify');

  await unmount(instance);
});

test('hides the legacy rules a server has removed', async () => {
  core.mentionNotifications.mockResolvedValue({ ...loaded, display_name: null, username: null });

  const instance = mount(MentionNotifications, { target: document.body });

  await vi.waitFor(() => {
    expect(selector('Mention @room').textContent).toContain('Notify');
  });
  expect(document.querySelector("[aria-label^='Contains Displayname']")).toBeNull();
  expect(document.querySelector("[aria-label^='Contains Username']")).toBeNull();

  await unmount(instance);
});

test('reports a failed lookup', async () => {
  core.mentionNotifications.mockRejectedValue(new Error('denied'));

  const instance = mount(MentionNotifications, { target: document.body });

  await vi.waitFor(() => {
    expect(document.body.textContent).toContain(
      'Those mention notification settings could not be saved.'
    );
  });

  await unmount(instance);
});
