// @vitest-environment happy-dom

import { render, screen } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { expect, test, vi } from 'vitest';

import type { TimelineItemView } from '#src/generated/protocol';

vi.mock('#lib/core/context.js');

import { core } from '#lib/core/__mocks__/context.js';
import { renderWithTooltips } from '#lib/test-support/render-with-tooltips.js';

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

test.each([
  [{ shortcode: ':sable-circular:' }, ':sable-circular:', true],
  [{ 'com.beeper.reaction.shortcode': 'sable-circular' }, ':sable-circular:', false],
  [{}, 'Custom emote', false],
] satisfies [Record<string, string>, string, boolean][])(
  'a custom reaction state event renders its image in the sentence (%j)',
  async (metadata, label, profile) => {
    core.fetchMedia.mockResolvedValue(
      new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>')
    );
    const item = {
      id: '$reaction',
      sender: '@alice:example.org',
      sender_name: 'Alice',
      content: {
        kind: 'hidden_event',
        event_type: 'm.reaction',
        content: {
          ...metadata,
          'm.relates_to': {
            rel_type: 'm.annotation',
            event_id: '$target',
            key: 'mxc://example.org/state-reaction',
          },
        },
        redacts: null,
      },
    } as TimelineItemView;

    renderWithTooltips(TimelineNotice, {
      item,
      unreadCount: 0,
      onSenderProfile: profile ? vi.fn() : undefined,
    });
    const image = await screen.findByAltText(label);

    expect(image.closest('.state-event-text')).toHaveTextContent(/^Alice reacted with\s*$/);
    await userEvent.hover(image);
    await vi.waitFor(() => expect(document.querySelector('.tooltip')).toHaveTextContent(label));
    expect(document.querySelector('.tooltip .emote-card-image img')).toBeInTheDocument();
    await userEvent.unhover(image);
    expect(document.querySelector('.tooltip')).not.toBeInTheDocument();
  }
);
