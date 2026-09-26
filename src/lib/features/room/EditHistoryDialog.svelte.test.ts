// @vitest-environment happy-dom

import { render, screen, within } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

vi.mock('#lib/core/context.js');

vi.mock('#lib/rooms/room-list.svelte.js', () => ({
  useRoomList: () => ({ rooms: [] }),
}));

import EditHistoryDialog from './EditHistoryDialog.svelte';

beforeEach(() => {
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const versions = [
  { event_id: '$original', timestamp: 1, body: 'helo', html: '<p>helo</p>' },
  { event_id: '$edit', timestamp: 2, body: 'hello', html: '<p><b>hello</b></p>' },
];

async function versionRows(): Promise<HTMLElement[]> {
  const dialog = await screen.findByRole('dialog');
  return within(dialog).getAllByRole('listitem');
}

test('renders every version as a message body and replies to the one picked', async () => {
  const user = userEvent.setup();
  const onReply = vi.fn();
  render(EditHistoryDialog, { open: true, versions, onReply });

  const [original, edit] = await versionRows();
  expect(within(original).getByText('helo')).toBeInTheDocument();
  expect(within(edit).getByText('hello').tagName).toBe('B');
  expect(within(original).getByText('Original')).toBeInTheDocument();
  expect(within(edit).queryByText('Original')).not.toBeInTheDocument();

  await user.click(within(original).getByRole('button', { name: 'Reply' }));
  expect(onReply).toHaveBeenCalledWith(versions[0]);
});

test('only the original can start a thread', async () => {
  const user = userEvent.setup();
  const onThread = vi.fn();
  render(EditHistoryDialog, { open: true, versions, onThread, onDelete: vi.fn() });

  const [original, edit] = await versionRows();
  expect(within(edit).queryByRole('button', { name: 'Reply in thread' })).not.toBeInTheDocument();
  await user.click(within(original).getByRole('button', { name: 'Reply in thread' }));
  expect(onThread).toHaveBeenCalledWith(versions[0]);
});

test('any version can be deleted', async () => {
  const user = userEvent.setup();
  const onDelete = vi.fn();
  render(EditHistoryDialog, { open: true, versions, onThread: vi.fn(), onDelete });

  const [, edit] = await versionRows();
  await user.click(within(edit).getByRole('button', { name: 'Delete message' }));
  expect(onDelete).toHaveBeenCalledWith(versions[1]);
});
