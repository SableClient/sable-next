// @vitest-environment happy-dom

import { render, screen } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import HeadphonesIcon from 'phosphor-svelte/lib/HeadphonesIcon';
import { expect, test, vi } from 'vitest';

import CallControlsHarness from './CallControlsHarness.test.svelte';

function mountControls(state: { microphoneEnabled: boolean; cameraEnabled: boolean }) {
  return render(CallControlsHarness, {
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

const button = (name: string) => screen.getByRole('button', { name });

test('uses the shared button variants for the call toggles', () => {
  mountControls({ microphoneEnabled: false, cameraEnabled: true });

  expect(button('Unmute microphone')).toHaveClass('btn-danger');
  expect(button('Turn camera off')).toHaveClass('btn-primary');
  expect(button('Deafen')).toHaveClass('btn-secondary');
});

test('deafening keeps the headphones and only fills them', () => {
  const icon = (weight: 'regular' | 'fill') => {
    const { container, unmount } = render(HeadphonesIcon, { weight });
    const path = container.querySelector('path')?.getAttribute('d');
    unmount();
    return path;
  };
  const { unmount } = mountControls({ microphoneEnabled: true, cameraEnabled: true });
  const idle = button('Deafen').querySelector('path')?.getAttribute('d');
  unmount();
  render(CallControlsHarness, {
    props: {
      microphoneEnabled: true,
      cameraEnabled: true,
      screenShareEnabled: false,
      deafened: true,
      ready: true,
      canScreenShare: false,
      onToggleMicrophone: vi.fn(),
      onToggleCamera: vi.fn(),
      onToggleScreenShare: vi.fn(),
      onToggleDeafen: vi.fn(),
      onHangUp: vi.fn(),
    },
  });
  const deafened = button('Undeafen').querySelector('path')?.getAttribute('d');

  expect(idle).toBe(icon('regular'));
  expect(deafened).toBe(icon('fill'));
});

test('keeps a muted mic legible and focusable while media is not ready', async () => {
  const onToggleMicrophone = vi.fn();
  render(CallControlsHarness, {
    props: {
      microphoneEnabled: false,
      cameraEnabled: false,
      screenShareEnabled: false,
      deafened: false,
      ready: false,
      canScreenShare: false,
      onToggleMicrophone,
      onToggleCamera: vi.fn(),
      onToggleScreenShare: vi.fn(),
      onToggleDeafen: vi.fn(),
      onHangUp: vi.fn(),
    },
  });

  const mic = button('Unmute microphone');
  expect(mic).toHaveClass('btn-danger');
  expect(mic).not.toHaveAttribute('disabled');
  expect(mic).toHaveAttribute('aria-disabled', 'true');
  await userEvent.click(mic);
  expect(onToggleMicrophone).not.toHaveBeenCalled();
});

test('uses borderless neutral toggles in the compact sidebar bar', () => {
  render(CallControlsHarness, {
    props: {
      compact: true,
      microphoneEnabled: false,
      cameraEnabled: false,
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

  expect(button('Unmute microphone')).toHaveClass('btn-danger');
  expect(button('Deafen')).toHaveClass('btn-ghost');
  expect(button('Turn camera on')).toHaveClass('btn-ghost');
});
