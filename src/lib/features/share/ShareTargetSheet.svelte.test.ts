// @vitest-environment happy-dom

import { mount, tick, unmount } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';

import type { RoomSummary } from '#src/generated/protocol';

vi.mock('#lib/core/context.js');

const mocks = vi.hoisted(() => ({
  goto: vi.fn(() => Promise.resolve()),
  afterOverlayPops: vi.fn(() => Promise.resolve()),
  rooms: [] as RoomSummary[],
}));

vi.mock('$app/navigation', () => ({ goto: mocks.goto }));
vi.mock('$app/state', () => ({ page: { state: {}, url: new URL('http://localhost/rooms') } }));
vi.mock('#lib/platform/overlay-back.svelte.js', () => ({
  afterOverlayPops: mocks.afterOverlayPops,
  holdOverlayBack: () => {},
}));
vi.mock('#lib/rooms/room-list.svelte.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('#lib/rooms/room-list.svelte.js')>()),
  useRoomList: () => ({ rooms: mocks.rooms, unreadFor: () => undefined }),
}));

import type { ShareInbox } from './share-inbox.svelte.js';
import ShareTargetSheet from './ShareTargetSheet.svelte';

afterEach(() => {
  document.body.replaceChildren();
  mocks.rooms.length = 0;
  mocks.goto.mockClear();
  mocks.afterOverlayPops.mockReset();
});

test('picking a room navigates there only once the sheet has popped its history entry', async () => {
  mocks.rooms.push({
    room_id: '!a:example.org',
    name: 'Alpha',
    state: 'joined',
    latest_event: null,
  } as unknown as RoomSummary);
  let popped!: () => void;
  mocks.afterOverlayPops.mockReturnValue(
    new Promise<void>((resolve) => {
      popped = resolve;
    })
  );
  const clear = vi.fn(() => Promise.resolve());
  const inbox = {
    pending: true,
    text: '',
    fileCount: 1,
    files: () => Promise.resolve([new File(['x'], 'holiday.png', { type: 'image/png' })]),
    clear,
  } as unknown as ShareInbox;

  const instance = mount(ShareTargetSheet, { target: document.body, props: { inbox } });
  await tick();

  document.querySelector<HTMLButtonElement>('[role="option"]')?.click();
  await vi.waitFor(() => {
    expect(mocks.afterOverlayPops).toHaveBeenCalled();
  });
  expect(clear).toHaveBeenCalled();
  expect(mocks.goto).not.toHaveBeenCalled();

  popped();
  await vi.waitFor(() => {
    expect(mocks.goto).toHaveBeenCalledWith(expect.stringContaining('/rooms/'), {
      replace: true,
    });
  });
  await unmount(instance);
});
