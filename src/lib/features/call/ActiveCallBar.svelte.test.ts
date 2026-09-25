// @vitest-environment happy-dom

import { mount, tick, unmount } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';

import ActiveCallBar from './ActiveCallBarHarness.test.svelte';
import type { CallSession } from './call-session.svelte.js';

afterEach(() => {
  document.body.replaceChildren();
});

function session(lifecycle: CallSession['lifecycle'], mediaReady: boolean): CallSession {
  return {
    lifecycle,
    mediaReady,
    deafened: false,
    canScreenShare: false,
    transport: {
      connection: 'connected',
      microphoneEnabled: false,
      cameraEnabled: false,
      screenShareEnabled: false,
    },
  } as unknown as CallSession;
}

test('announces the call status', async () => {
  const joining = mount(ActiveCallBar, {
    target: document.body,
    props: { session: session('joining', false), roomName: 'Sable voice', onReturn: vi.fn() },
  });
  await tick();

  expect(document.querySelector('[role="status"]')?.textContent).toContain('Joining call');
  expect(document.querySelector('.call-bar')?.classList).not.toContain('live');
  await unmount(joining);

  const active = mount(ActiveCallBar, {
    target: document.body,
    props: { session: session('active', true), roomName: 'Sable voice', onReturn: vi.fn() },
  });
  await tick();

  expect(document.querySelector('[role="status"]')?.textContent).toContain('Connected');
  expect(document.querySelector('.call-bar')?.classList).toContain('live');
  await unmount(active);
});
