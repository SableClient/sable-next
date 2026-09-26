// @vitest-environment happy-dom

import { render, screen } from '@testing-library/svelte';
import { expect, test, vi } from 'vitest';

import ActiveCallBar from './ActiveCallBarHarness.test.svelte';
import type { CallSession } from './call-session.svelte.js';

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

test('announces the call status', () => {
  const joining = render(ActiveCallBar, {
    session: session('joining', false),
    roomName: 'Sable voice',
    onReturn: vi.fn(),
  });

  expect(screen.getByRole('status')).toHaveTextContent('Joining call');
  expect(joining.container.querySelector('.call-bar')).not.toHaveClass('live');
  joining.unmount();

  const active = render(ActiveCallBar, {
    session: session('active', true),
    roomName: 'Sable voice',
    onReturn: vi.fn(),
  });

  expect(screen.getByRole('status')).toHaveTextContent('Connected');
  expect(active.container.querySelector('.call-bar')).toHaveClass('live');
});
