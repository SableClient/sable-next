import { expect, test, vi } from 'vitest';

import type { CoreEvent } from '#src/generated/protocol';

const stored = vi.hoisted(() => ({
  put: vi.fn(() => Promise.resolve()),
  forget: vi.fn(() => Promise.resolve()),
}));

vi.mock('./room-names', () => ({
  putPushSession: stored.put,
  forgetPushSession: stored.forget,
}));

import { answerPushEvent, sharePushSession } from './push-session';

function sharer(token: string | null) {
  let listener: ((event: CoreEvent) => void) | null = null;
  const accessToken = vi.fn(() => Promise.resolve(token));
  const core = {
    session: { user_id: '@me:example.org', homeserver: 'https://hs.example/' },
    commands: { accessToken },
    subscribeEvents: (onEvent: (event: CoreEvent) => void) => {
      listener = onEvent;
      return () => {
        listener = null;
      };
    },
  } as unknown as Parameters<typeof sharePushSession>[0];
  return { core, accessToken, emit: (event: CoreEvent) => listener?.(event) };
}

test('the worker is handed the token, and handed it again when it is refreshed', async () => {
  stored.put.mockClear();
  const { core, accessToken, emit } = sharer('token');

  const stop = sharePushSession(core);
  await vi.waitFor(() => {
    expect(stored.put).toHaveBeenCalledWith({
      userId: '@me:example.org',
      homeserver: 'https://hs.example/',
      accessToken: 'token',
    });
  });
  emit({ type: 'session_tokens_refreshed' });
  expect(accessToken).toHaveBeenCalledTimes(2);

  stop();
  emit({ type: 'session_tokens_refreshed' });
  expect(accessToken).toHaveBeenCalledTimes(2);
});

test('a session with no token takes the stored one away', async () => {
  stored.forget.mockClear();
  sharePushSession(sharer(null).core);

  await vi.waitFor(() => {
    expect(stored.forget).toHaveBeenCalledWith('@me:example.org');
  });
});

test('a tab only decrypts a push for the account it has open', async () => {
  const pushEvent = vi.fn(() => Promise.resolve({ kind: 'discard' as const }));
  const core = {
    session: { user_id: '@me:example.org' },
    commands: { pushEvent },
  } as unknown as Parameters<typeof answerPushEvent>[0];

  expect(
    await answerPushEvent(core, { roomId: '!r', eventId: '$e', userId: '@me:example.org' })
  ).toEqual({ kind: 'discard' });
  expect(
    await answerPushEvent(core, { roomId: '!r', eventId: '$e', userId: '@other:example.org' })
  ).toBeNull();
  expect(await answerPushEvent(core, { roomId: '!r' })).toBeNull();
  expect(pushEvent).toHaveBeenCalledTimes(1);
});
