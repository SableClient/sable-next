// @vitest-environment happy-dom

import { screen } from '@testing-library/svelte';
import { renderWithTooltips } from '#lib/test-support/render-with-tooltips.js';
import { userEvent } from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';

vi.mock('#lib/core/context.js');

import { core } from '#lib/core/__mocks__/context.js';
import { mediaViewerState } from '#lib/ui/media/media-viewer-state.svelte.ts';

import RoomFileAttachments from './RoomFileAttachments.svelte';
import { FEBRUARY, file } from './attachment-fixtures';

const roomAttachments = vi.fn();
Object.assign(core.rpc.rooms, { attachments: roomAttachments });

afterEach(() => {
  roomAttachments.mockReset();
});

const user = userEvent.setup();

function setup(props: { onJump?: () => void } = {}) {
  return renderWithTooltips(RoomFileAttachments, {
    props: {
      roomId: '!room:example.org',
      members: [],
      onJump: props.onJump ?? vi.fn(),
    },
  });
}

function request(from: string | null) {
  return { room_id: '!room:example.org', kind: 'file', limit: 30, from };
}

test('files are grouped by month, page on demand and open in the viewer', async () => {
  roomAttachments
    .mockResolvedValueOnce({ items: [file('$a', 'notes.pdf')], next_batch: 'next' })
    .mockResolvedValueOnce({
      items: [file('$b', 'slides.pdf', { timestamp: FEBRUARY })],
      next_batch: null,
    });
  const openPanelSpy = vi.spyOn(mediaViewerState, 'openPanel');
  setup();
  expect(await screen.findByRole('button', { name: /notes\.pdf/ })).toBeInTheDocument();
  expect(roomAttachments).toHaveBeenLastCalledWith(request(null));

  await user.click(screen.getByRole('button', { name: 'Load more' }));
  expect(await screen.findByRole('button', { name: /slides\.pdf/ })).toBeInTheDocument();
  expect(roomAttachments).toHaveBeenLastCalledWith(request('next'));
  expect(screen.getAllByRole('heading', { level: 3 })).toHaveLength(2);
  expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();

  await user.click(screen.getByRole('button', { name: /slides\.pdf/ }));
  expect(openPanelSpy).toHaveBeenCalledWith(
    [
      expect.objectContaining({ eventId: '$a', kind: 'file', filename: 'notes.pdf' }),
      expect.objectContaining({ eventId: '$b', kind: 'file', filename: 'slides.pdf' }),
    ],
    '$b',
    expect.any(Function)
  );
});

test('an audio file opens in the viewer as audio', async () => {
  roomAttachments.mockResolvedValueOnce({
    items: [file('$voice', 'memo.ogg', { mime: 'audio/ogg' })],
    next_batch: null,
  });
  const openPanelSpy = vi.spyOn(mediaViewerState, 'openPanel');
  setup();

  await user.click(await screen.findByRole('button', { name: /memo\.ogg/ }));
  expect(openPanelSpy).toHaveBeenCalledWith(
    [expect.objectContaining({ kind: 'audio', filename: 'memo.ogg' })],
    '$voice',
    expect.any(Function)
  );
});
