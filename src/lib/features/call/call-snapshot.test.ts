import { expect, test, vi } from 'vitest';

vi.mock('@sentry/sveltekit', () => ({}));

import type { CallSession } from './call-session.svelte.js';
import { collectCallSnapshot, holdCallSnapshot, takeCallSnapshot } from './call-snapshot';
import { idleTransportState } from './call-transport';

const session = {
  lifecycle: 'failed',
  failure: 'setup-failed',
  mediaReady: false,
  encryptsMedia: true,
  listenOnly: false,
  deviceError: null,
  inputMode: 'voice-activity',
  microphoneEnabled: true,
  deafened: false,
  connectedAt: null,
  telemetry: { attemptId: 'attempt-1' },
  members: [
    { user_id: '@alice:example.org', device_id: 'DEVICEAAAA', identity: 'alice:DEVICEAAAA' },
  ],
  rooms: [],
  transport: {
    ...idleTransportState(),
    self: { identity: 'alice:DEVICEAAAA', local: true, connectionQuality: 'poor' },
    participants: [{ identity: 'bob:DEVICEBBBB', backendId: 'sfu.example.org' }],
    error: 'could not reach wss://sfu.example.org',
    errorCode: 'sfu.example.org refused',
    disconnectReason: 'JOIN_FAILURE',
    unreachableBackends: ['sfu.example.org'],
  },
} as unknown as CallSession;

test('a call snapshot carries counts and allowlisted codes, never who or where', async () => {
  const snapshot = await collectCallSnapshot(session);
  const text = JSON.stringify(snapshot);

  expect(text).not.toMatch(/alice|bob|DEVICE|example\.org/);
  expect(snapshot).toMatchObject({
    attemptId: 'attempt-1',
    failure: 'setup-failed',
    errorCode: 'unknown',
    disconnectReason: 'JOIN_FAILURE',
    members: 1,
    participants: 1,
    unreachableBackends: 1,
    quality: { poor: 1, unknown: 1 },
    video: [],
  });
});

test('a held snapshot is attached to one report only', async () => {
  holdCallSnapshot(await collectCallSnapshot(session));
  expect(takeCallSnapshot()).toBeDefined();
  expect(takeCallSnapshot()).toBeUndefined();
});
