// @vitest-environment happy-dom

import { render } from '@testing-library/svelte';
import { expect, test, vi } from 'vitest';

import type { MembershipChangeView, TimelineItemView } from '#src/generated/protocol';

vi.mock('#lib/core/context.js');

import TimelineNotice from './TimelineNotice.svelte';

function setup(change: MembershipChangeView): HTMLElement {
  const item = {
    id: change,
    sender: '@alice:example.org',
    sender_name: 'Alice',
    timestamp: 1_700_000_000_000,
    content: {
      kind: 'membership',
      user_id: '@bob:example.org',
      change,
      display_name: 'Bob',
      reason: null,
    },
  } as TimelineItemView;

  return render(TimelineNotice, { item, unreadCount: 0 }).container;
}

test('a state event carries its icon in the avatar gutter', () => {
  const gutter = setup('joined').querySelector('.state > .state-icon');

  expect(gutter?.getAttribute('aria-hidden')).toBe('true');
  expect(gutter?.querySelector('svg')).not.toBeNull();
});

test('a transition that is not a join draws a different icon', () => {
  const joined = setup('joined').querySelector('.state-icon svg')?.innerHTML;
  const banned = setup('banned').querySelector('.state-icon svg')?.innerHTML;

  expect(joined).toBeTruthy();
  expect(joined).not.toBe(banned);
});
