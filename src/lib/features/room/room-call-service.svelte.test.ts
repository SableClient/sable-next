// @vitest-environment happy-dom

import { flushSync } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';

import type { CoreClient } from '#lib/core/client.svelte.js';
import { setPreference } from '#lib/settings/preferences.svelte.js';
import { RoomCallSupport } from './room-call-support.svelte.js';

vi.mock('#lib/config/runtime-config.js', () => ({
  runtimeConfig: () =>
    Promise.resolve({
      calls: { livekitServiceUrl: 'https://deployment.example.org/rtc' },
    }),
}));

afterEach(() => {
  setPreference('callServiceUrl', '');
  vi.unstubAllGlobals();
});

test('refreshes call support when the fallback is saved or cleared', async () => {
  vi.stubGlobal('RTCPeerConnection', vi.fn());
  const support = vi.fn(() => Promise.resolve({ has_focus: true, can_join: true }));
  const core = { rpc: { calls: { support } } } as unknown as Pick<CoreClient, 'rpc'>;
  const cleanup = $effect.root(() => {
    new RoomCallSupport(core, () => '!room:example.org');
  });
  try {
    flushSync();
    await vi.waitFor(() => {
      expect(support).toHaveBeenLastCalledWith({
        room_id: '!room:example.org',
        livekit_service_url: 'https://deployment.example.org/rtc',
      });
    });
    setPreference('callServiceUrl', 'https://custom.example.org/rtc');
    flushSync();
    expect(support).toHaveBeenLastCalledWith({
      room_id: '!room:example.org',
      livekit_service_url: 'https://custom.example.org/rtc',
    });
    for (const value of ['', 'file:///tmp/rtc']) {
      setPreference('callServiceUrl', value);
      flushSync();
      expect(support).toHaveBeenLastCalledWith({
        room_id: '!room:example.org',
        livekit_service_url: 'https://deployment.example.org/rtc',
      });
    }
  } finally {
    cleanup();
  }
});
