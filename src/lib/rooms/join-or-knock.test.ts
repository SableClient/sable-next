// @vitest-environment happy-dom

import { expect, test, vi } from 'vitest';

import type { Rpc, RoomPreviewView } from '#src/generated/protocol';

vi.mock('$app/paths', () => ({
  resolve: (path: string, params: Record<string, string> = {}) =>
    path.replace('/(app)', '').replace(/\[([^\]]+)\]/g, (_, key: string) => params[key] ?? key),
}));

import { CoreError } from '#src/transport';
import { joinOrOfferKnock, knockPagePath } from './join-or-knock.js';

function rpcWith(
  join: () => Promise<string>,
  preview: () => Promise<Pick<RoomPreviewView, 'join_rule'>>
): Pick<Rpc, 'rooms'> {
  return { rooms: { join, preview } } as unknown as Pick<Rpc, 'rooms'>;
}

test('a successful join never asks for a preview', async () => {
  const preview = vi.fn(() => Promise.resolve({ join_rule: 'knock' as const }));
  const rpc = rpcWith(() => Promise.resolve('!room:example.org'), preview);

  await expect(joinOrOfferKnock(rpc, '#room:example.org')).resolves.toEqual({
    kind: 'joined',
    roomId: '!room:example.org',
  });
  expect(preview).not.toHaveBeenCalled();
});

test.each(['knock', 'knock_restricted'] as const)(
  'a refused join offers to knock on a %s room',
  async (join_rule) => {
    const rpc = rpcWith(
      () => Promise.reject(new Error('forbidden')),
      () => Promise.resolve({ join_rule })
    );

    await expect(joinOrOfferKnock(rpc, '!room:example.org', ['other.org'])).resolves.toEqual({
      kind: 'knock',
      address: '!room:example.org',
      via: ['other.org'],
    });
  }
);

test('the join error is kept when the room cannot be knocked on or previewed', async () => {
  const forbidden = new Error('forbidden');
  const invite = rpcWith(
    () => Promise.reject(forbidden),
    () => Promise.resolve({ join_rule: 'invite' as const })
  );
  const unavailable = rpcWith(
    () => Promise.reject(forbidden),
    () => Promise.reject(new Error('no preview'))
  );

  await expect(joinOrOfferKnock(invite, '#room:example.org')).rejects.toBe(forbidden);
  await expect(joinOrOfferKnock(unavailable, '#room:example.org')).rejects.toBe(forbidden);
});

test('the knock page path carries the address and routing servers', () => {
  expect(knockPagePath('#room:example.org', [])).toBe('/rooms/%23room%3Aexample.org');
  expect(knockPagePath('!id:example.org', ['a.org', 'b.org'])).toBe(
    '/rooms/!id%3Aexample.org?via=a.org&via=b.org'
  );
});

test('a banned user is not offered a knock', async () => {
  const banned = new CoreError({ code: 'banned', reason: null });
  const preview = vi.fn(() => Promise.resolve({ join_rule: 'knock' as const }));
  const rpc = rpcWith(() => Promise.reject(banned), preview);

  await expect(joinOrOfferKnock(rpc, '!room:example.org')).rejects.toBe(banned);
  expect(preview).not.toHaveBeenCalled();
});
