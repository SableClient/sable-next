// @vitest-environment happy-dom

import { render, screen } from '@testing-library/svelte';
import { expect, test, vi } from 'vitest';

import ActiveCallBar from './ActiveCallBarHarness.test.svelte';
import type { CallSession } from './call-session.svelte.js';

function session(
  lifecycle: CallSession['lifecycle'],
  mediaReady: boolean,
  members = 0
): CallSession {
  return {
    lifecycle,
    members: Array.from({ length: members }),
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

test('shows how many people are in the call', () => {
  render(ActiveCallBar, {
    session: session('active', true, 3),
    roomName: 'Sable voice',
    onReturn: vi.fn(),
  });

  expect(screen.getByText('3 participants')).toBeInTheDocument();
});
