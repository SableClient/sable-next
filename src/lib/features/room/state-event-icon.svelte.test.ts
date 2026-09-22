// @vitest-environment happy-dom

import { mount, unmount } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';

import type { MembershipChangeView, TimelineItemView } from '#src/generated/protocol';

vi.mock('#lib/core/context.js');

import TimelineNotice from './TimelineNotice.svelte';

const mounted: { host: HTMLElement; instance: Record<string, unknown> }[] = [];

afterEach(() => {
  for (const { host, instance } of mounted.splice(0)) {
    void unmount(instance);
    host.remove();
  }
});

function render(change: MembershipChangeView): HTMLElement {
  const item = {
    id: change,
    sender: '@alice:example.org',
    sender_name: 'Alice',
    content: {
      kind: 'membership',
      user_id: '@bob:example.org',
      change,
      display_name: 'Bob',
      reason: null,
    },
  } as TimelineItemView;

  const host = document.createElement('div');
  document.body.append(host);
  mounted.push({
    host,
    instance: mount(TimelineNotice, { target: host, props: { item, unreadCount: 0 } }),
  });
  return host;
}

test('a state event carries its icon in the avatar gutter', () => {
  const gutter = render('joined').querySelector('.state > .state-icon');

  expect(gutter?.getAttribute('aria-hidden')).toBe('true');
  expect(gutter?.querySelector('svg')).not.toBeNull();
});

test('a transition that is not a join draws a different icon', () => {
  const joined = render('joined').querySelector('.state-icon svg')?.innerHTML;
  const banned = render('banned').querySelector('.state-icon svg')?.innerHTML;

  expect(joined).toBeTruthy();
  expect(joined).not.toBe(banned);
});
