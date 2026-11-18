// @vitest-environment happy-dom

import { screen } from '@testing-library/svelte';
import { renderWithTooltips } from '#lib/test-support/render-with-tooltips.js';
import { userEvent } from '@testing-library/user-event';
import { expect, test, vi } from 'vitest';

vi.mock('#lib/core/context.js');

import { core } from '#lib/core/__mocks__/context.js';

import RoomAttachmentsPanel from '../RoomAttachmentsPanel.svelte';

const roomAttachments = vi.fn();
Object.assign(core.rpc.rooms, { attachments: roomAttachments });

const user = userEvent.setup();
const tab = (name: string) => screen.getByRole('tab', { name });

test('the tabs follow the arrow keys and keep one tab stop', async () => {
  roomAttachments.mockResolvedValue({ items: [], next_batch: null });
  renderWithTooltips(RoomAttachmentsPanel, {
    props: { roomId: '!room:example.org', members: [], onJump: vi.fn(), onClose: vi.fn() },
  });
  await vi.waitFor(() => {
    expect(roomAttachments).toHaveBeenCalledTimes(1);
  });

  const media = tab('Media');
  expect(media).toHaveAttribute('tabindex', '0');
  expect(tab('Links')).toHaveAttribute('tabindex', '-1');
  expect(media).toHaveAttribute('aria-controls', 'attachments-panel');

  media.focus();
  await user.keyboard('{ArrowLeft}');
  expect(tab('Links')).toHaveAttribute('aria-selected', 'true');
  expect(tab('Links')).toHaveFocus();
  expect(screen.getByRole('tabpanel', { name: 'Links' })).toBeInTheDocument();
  expect(roomAttachments).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'link' }));
});
