// @vitest-environment happy-dom

import { fireEvent, screen } from '@testing-library/svelte';
import { renderWithTooltips } from '#lib/test-support/render-with-tooltips.js';
import { userEvent } from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';

vi.mock('#lib/core/context.js');

import { core } from '#lib/core/__mocks__/context.js';

import RoomLinkAttachments from './RoomLinkAttachments.svelte';
import { links } from './attachment-fixtures';

const roomAttachments = vi.fn();
Object.assign(core.rpc.rooms, { attachments: roomAttachments });

afterEach(() => {
  roomAttachments.mockReset();
});

const user = userEvent.setup();

function setup(props: { onJump?: () => void; onMatrixLink?: () => void } = {}) {
  return renderWithTooltips(RoomLinkAttachments, {
    props: {
      roomId: '!room:example.org',
      members: [],
      onJump: props.onJump ?? vi.fn(),
      onMatrixLink: props.onMatrixLink ?? vi.fn(),
    },
  });
}

function request(from: string | null) {
  return { room_id: '!room:example.org', kind: 'link', limit: 30, from };
}

test('links show the host, cap the list and keep a named way back to the message', async () => {
  roomAttachments.mockResolvedValueOnce({
    items: [
      links('$link', [
        'https://example.org/a',
        'https://example.org/b',
        'https://example.org/c',
        'https://example.org/d',
      ]),
    ],
    next_batch: null,
  });
  const onJump = vi.fn();
  setup({ onJump });
  await vi.waitFor(() => {
    expect(screen.getAllByRole('link')).toHaveLength(3);
  });
  expect(roomAttachments).toHaveBeenCalledWith(request(null));
  const [first] = screen.getAllByRole('link');
  expect(first).toHaveAttribute('href', 'https://example.org/a');
  expect(first).toHaveAttribute('rel', 'external noopener noreferrer');
  expect(first.querySelector('.link-host')).toHaveTextContent('example.org');
  expect(screen.getByText('+1 more link')).toBeInTheDocument();

  await user.click(screen.getByRole('button', { name: /Jump to message/ }));
  expect(onJump).toHaveBeenCalledWith('$link');
});

test('a matrix.to link routes inside the app instead of opening a tab', async () => {
  roomAttachments.mockResolvedValueOnce({
    items: [links('$permalink', ['https://matrix.to/#/!other:example.org/$target'])],
    next_batch: null,
  });
  const onMatrixLink = vi.fn();
  setup({ onMatrixLink });
  const link = await screen.findByRole('link');

  expect(await fireEvent.click(link)).toBe(false);
  expect(onMatrixLink).toHaveBeenCalledWith(
    expect.objectContaining({ kind: 'event', event_id: '$target' }),
    expect.any(HTMLAnchorElement)
  );
});
