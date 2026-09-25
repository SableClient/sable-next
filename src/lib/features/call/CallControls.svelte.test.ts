// @vitest-environment happy-dom

import { mount, tick, unmount } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';

import CallControlsHarness from './CallControlsHarness.test.svelte';

afterEach(() => {
  document.body.replaceChildren();
});

function mountControls(state: { microphoneEnabled: boolean; cameraEnabled: boolean }) {
  return mount(CallControlsHarness, {
    target: document.body,
    props: {
      ...state,
      screenShareEnabled: false,
      deafened: false,
      ready: true,
      canScreenShare: false,
      onToggleMicrophone: vi.fn(),
      onToggleCamera: vi.fn(),
      onToggleScreenShare: vi.fn(),
      onToggleDeafen: vi.fn(),
      onHangUp: vi.fn(),
    },
  });
}

const button = (label: string) => document.querySelector(`button[aria-label="${label}"]`);

test('uses the shared button variants for the call toggles', async () => {
  const instance = mountControls({ microphoneEnabled: false, cameraEnabled: true });
  await tick();

  expect(button('Unmute microphone')?.classList).toContain('btn-danger');
  expect(button('Turn camera off')?.classList).toContain('btn-primary');
  expect(button('Deafen')?.classList).toContain('btn-secondary');

  await unmount(instance);
});
