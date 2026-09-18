// @vitest-environment happy-dom

import { mount, unmount } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';

vi.mock('#lib/core/context.js');

import { core as baseCore } from '#lib/core/__mocks__/context.js';

type Mode = 'off' | 'notify' | 'loud';

const core = Object.assign(baseCore, {
  session: { user_id: '@erwan:example.org' },
  userProfile: vi.fn(() => Promise.resolve({ display_name: 'Erwan' })),
  mentionNotifications: vi.fn<() => Promise<Record<string, Mode>>>(),
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
    expect(selector('Mention User ID ("@erwan:example.org")').textContent).toContain('Loud');
  });
  expect(selector('Contains Displayname ("Erwan")').textContent).toContain('Off');
  expect(selector('Contains Username ("erwan")').textContent).toContain('Loud');
  expect(selector('Mention @room').textContent).toContain('Notify');

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
