// @vitest-environment happy-dom

import { render, screen } from '@testing-library/svelte';
import { expect, test, vi } from 'vitest';

vi.mock('#lib/core/context.js');
vi.mock('#lib/rooms/room-list.svelte.js', () => ({
  useRoomList: () => ({ rooms: [] }),
}));

import ComposerContextBanner from './ComposerContextBanner.svelte';

test('a reply context shows its sender and announces who is being replied to', () => {
  const { container } = render(ComposerContextBanner, {
    props: {
      context: { kind: 'reply', eventId: '$one:example.org', sender: 'Alice', body: 'Hello' },
    },
  });

  expect(screen.getByText('Replying to Alice')).toHaveClass('screen-reader-only');
  expect(container.querySelector('.context-sender')).toHaveTextContent('Alice');
  expect(container.querySelector('.context-reply-icon svg')).toBeInTheDocument();
  expect(screen.getByText('Hello')).toBeInTheDocument();
});

test('an edit context offers no reply controls', () => {
  render(ComposerContextBanner, {
    props: { context: { kind: 'edit', eventId: '$one:example.org', body: 'look at this' } },
  });

  expect(screen.queryByText(/Replying to/)).not.toBeInTheDocument();
  expect(screen.getAllByRole('button')).toHaveLength(1);
});

test('a reply context renders a custom emote from its formatted body', () => {
  render(ComposerContextBanner, {
    props: {
      context: {
        kind: 'reply',
        eventId: '$one:example.org',
        sender: 'Alice',
        body: ':rotate:',
        html: '<img data-mx-emoticon src="mxc://example.org/rotate" alt=":rotate:">',
      },
    },
  });

  expect(screen.getByRole('img', { name: ':rotate:' })).toBeInTheDocument();
  expect(screen.queryByText(':rotate:')).not.toBeInTheDocument();
});
