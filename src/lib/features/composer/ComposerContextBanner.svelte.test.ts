// @vitest-environment happy-dom

import { render, screen } from '@testing-library/svelte';
import { expect, test } from 'vitest';

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
