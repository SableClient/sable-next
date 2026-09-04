import { expect, test, vi } from 'vitest';

import type { CoreEvent } from '#src/generated/CoreEvent';
import type { SessionInfo } from '#src/generated/SessionInfo';
import type { Transport } from '#src/transport';

import { createCoreClient } from './client.svelte.js';

const session: SessionInfo = {
  account_id: 'account-a',
  user_id: '@erwan:example.org',
  device_id: 'LAPTOP',
};

function fakeTransport(responses: Record<string, unknown> = {}) {
  const listeners = new Set<(event: CoreEvent) => void>();
  const sent: { type: string }[] = [];
  const close = vi.fn();
  const transport = {
    send: vi.fn((command: { type: string }) => {
      sent.push(command);

      return Promise.resolve(responses[command.type] ?? {});
    }),
    subscribe: (listener: (event: CoreEvent) => void) => {
      listeners.add(listener);

      return () => listeners.delete(listener);
    },
    subscribeCrash: () => () => {},
    subscribeStall: () => () => {},
    setDebugLogs: vi.fn(),
    close,
    fetchMedia: vi.fn(),
    sendAttachment: vi.fn(),
    uploadMedia: vi.fn(),
  } as unknown as Transport;

  return {
    transport,
    sent,
    close,
    emit: (event: CoreEvent) => {
      for (const listener of listeners) listener(event);
    },
  };
}

test('a restore that returns a session leaves the client ready', async () => {
  const fake = fakeTransport({ restore: { session }, list_accounts: { accounts: [session] } });
  const core = createCoreClient(() => fake.transport);

  await core.start();

  expect(core.status).toBe('ready');
  expect(core.session?.user_id).toBe('@erwan:example.org');
  expect(core.accounts).toHaveLength(1);
});

test('a restore that returns no session reports signed out, not an error', async () => {
  const fake = fakeTransport({ restore: { session: null } });
  const core = createCoreClient(() => fake.transport);

  await core.start();

  expect(core.status).toBe('signed-out');
  expect(core.session).toBeNull();
});

test('a transport that refuses to restore leaves the client signed out for relogin', async () => {
  const fake = fakeTransport();
  fake.transport.send = vi.fn(() => Promise.reject(new Error('worker gone')));
  const core = createCoreClient(() => fake.transport);

  await core.start();

  expect(core.status).toBe('signed-out');
  expect(core.session).toBeNull();
});

test('concurrent starts share one restore', async () => {
  const fake = fakeTransport({ restore: { session: null } });
  const core = createCoreClient(() => fake.transport);

  await Promise.all([core.start(), core.start(), core.start()]);

  expect(fake.sent.filter((command) => command.type === 'restore')).toHaveLength(1);
});

test('commands dispatch through the transport the client was given', async () => {
  const fake = fakeTransport({ restore: { session: null }, room_aliases: { aliases: ['#a:b'] } });
  const core = createCoreClient(() => fake.transport);

  await core.start();

  await expect(core.commands.roomAliases('!room:example.org')).resolves.toEqual(['#a:b']);
  expect(fake.sent).toContainEqual({ type: 'room_aliases', room_id: '!room:example.org' });
});

test('stopping clears the session and closes the transport', async () => {
  const fake = fakeTransport({ restore: { session }, list_accounts: { accounts: [session] } });
  const core = createCoreClient(() => fake.transport);

  await core.start();
  core.stop();

  expect(core.status).toBe('idle');
  expect(core.session).toBeNull();
  expect(fake.close).toHaveBeenCalled();
});

test('core events from the transport reach client state', async () => {
  const fake = fakeTransport({ restore: { session }, list_accounts: { accounts: [session] } });
  const core = createCoreClient(() => fake.transport);

  await core.start();

  const status = { type: 'sync_status', state: 'running' } as unknown as CoreEvent;
  fake.emit(status);
  expect(core.sync).toBe(status);

  fake.emit({ type: 'devices_changed', devices: [] } as unknown as CoreEvent);
  expect(core.deviceList).toEqual([]);
});

test('the sync status outlives the reset the session replacement performs', async () => {
  const fake = fakeTransport({
    restore: { session },
    list_accounts: { accounts: [session] },
    sync_status: { status: { state: 'live' } },
  });
  const core = createCoreClient(() => fake.transport);

  await core.start();

  await vi.waitFor(() => {
    expect(core.sync?.state).toBe('live');
  });
});

test('a cancellation for an unknown verification flow does not open the verification dialog', async () => {
  const fake = fakeTransport({ restore: { session }, list_accounts: { accounts: [session] } });
  const core = createCoreClient(() => fake.transport);

  await core.start();
  const unsubscribe = core.subscribeEvents(() => {});

  fake.emit({
    type: 'verification',
    user_id: session.user_id,
    flow_id: 'stale-flow',
    state: { phase: 'cancelled', reason: 'm.user' },
  });

  expect(core.verification).toBeNull();

  fake.emit({
    type: 'verification',
    user_id: session.user_id,
    flow_id: 'active-flow',
    state: { phase: 'requested', is_self: true, initiated_by_us: false },
  });
  fake.emit({
    type: 'verification',
    user_id: session.user_id,
    flow_id: 'active-flow',
    state: { phase: 'cancelled', reason: 'm.user' },
  });

  expect(core.verification).toEqual({
    flowId: 'active-flow',
    state: { phase: 'cancelled', reason: 'm.user' },
  });
  unsubscribe();
});

test('a session ending clears the session and looks for a fallback account', async () => {
  const fake = fakeTransport({
    restore: { session },
    list_accounts: { accounts: [session] },
  });
  const core = createCoreClient(() => fake.transport);

  await core.start();
  fake.emit({ type: 'session_ended' } as unknown as CoreEvent);

  expect(core.session).toBeNull();
  expect(core.status).toBe('authenticating');
});
