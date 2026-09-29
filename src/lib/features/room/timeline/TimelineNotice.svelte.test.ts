// @vitest-environment happy-dom

import { render } from '@testing-library/svelte';
import { expect, test, vi } from 'vitest';

import type { TimelineItemView } from '#src/generated/protocol';

vi.mock('#lib/core/context.js');

import TimelineNotice from './TimelineNotice.svelte';

test('a redacted reaction renders as removed instead of as a generic hidden event', () => {
  const item = {
    id: '$reaction',
    sender: '@alice:example.org',
    sender_name: 'Alice',
    content: { kind: 'hidden_event', event_type: 'm.reaction', content: {}, redacts: null },
  } as TimelineItemView;

  const container = render(TimelineNotice, { item, unreadCount: 0 }).container;

  expect(container.querySelector('.state.redacted')).not.toBeNull();
  expect(container.querySelector('.debug-event')).toBeNull();
});
