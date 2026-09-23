// @vitest-environment happy-dom

import { afterEach, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  dismissRead: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('#lib/platform/native-notifications.js', () => ({
  dismissNativeRoomNotification: vi.fn().mockResolvedValue(undefined),
  dismissNativeReadRoomNotifications: mocks.dismissRead,
}));

import { retireReadAlerts } from './retire';
import { roomTag } from './tag';

afterEach(() => {
  vi.unstubAllGlobals();
  mocks.dismissRead.mockClear();
});

function presented(...tags: string[]) {
  const shown = tags.map((tag) => ({ tag, close: vi.fn() }));
  vi.stubGlobal('navigator', {
    serviceWorker: { getRegistration: () => Promise.resolve({ getNotifications: () => shown }) },
  });
  return shown;
}

test('closes the alerts of read rooms and nothing else', async () => {
  const [read, unread, otherAccount] = presented(
    roomTag('@me:example.org', '!read:example.org'),
    roomTag('@me:example.org', '!unread:example.org'),
    roomTag('@other:example.org', '!read:example.org')
  );

  await retireReadAlerts('@me:example.org', ['!read:example.org']);

  expect(read.close).toHaveBeenCalledOnce();
  expect(unread.close).not.toHaveBeenCalled();
  expect(otherAccount.close).not.toHaveBeenCalled();
  expect(mocks.dismissRead).toHaveBeenCalledExactlyOnceWith('@me:example.org', [
    '!read:example.org',
  ]);
});

test('asks nothing of the platform when no room is read', async () => {
  presented();

  await retireReadAlerts('@me:example.org', []);

  expect(mocks.dismissRead).not.toHaveBeenCalled();
});
