// @vitest-environment happy-dom

import { render, waitFor } from '@testing-library/svelte';
import { expect, test, vi } from 'vitest';
import NativeCallAudio from './NativeCallAudio.svelte';
import type { CallParticipant } from './call-transport';

const track = (id: string) => ({ id, muted: false, subscribed: true });
const participant: CallParticipant = {
  identity: 'alice',
  microphone: track('mic'),
  screenShare: track('video'),
  screenShareAudio: track('audio'),
};

test('native audio follows watching, volume changes and deafen without snapshot loops', async () => {
  const setVolume = vi.fn(() => Promise.resolve());
  const { rerender } = render(NativeCallAudio, {
    participants: [participant],
    deafened: false,
    volumeOf: (_identity, screen) => (screen ? 0 : 0.8),
    setVolume,
  });
  await waitFor(() => {
    expect(setVolume).toHaveBeenCalledTimes(2);
  });
  expect(setVolume).toHaveBeenCalledWith('alice', 0.8, false);
  expect(setVolume).toHaveBeenCalledWith('alice', 0, true);

  await rerender({ participants: [{ ...participant }] });
  expect(setVolume).toHaveBeenCalledTimes(2);

  await rerender({ volumeOf: (_identity, screen) => (screen ? 0.6 : 0.8) });
  await waitFor(() => {
    expect(setVolume).toHaveBeenLastCalledWith('alice', 0.6, true);
  });

  await rerender({ volumeOf: (_identity, screen) => (screen ? 0.3 : 0.4) });
  await waitFor(() => {
    expect(setVolume).toHaveBeenLastCalledWith('alice', 0.3, true);
  });
  expect(setVolume).toHaveBeenCalledWith('alice', 0.4, false);

  await rerender({ deafened: true });
  await waitFor(() => {
    expect(setVolume).toHaveBeenLastCalledWith('alice', 0, true);
  });
  expect(setVolume).toHaveBeenCalledWith('alice', 0, false);

  await rerender({ deafened: false });
  await waitFor(() => {
    expect(setVolume).toHaveBeenLastCalledWith('alice', 0.3, true);
  });

  await rerender({ volumeOf: (_identity, screen) => (screen ? 0 : 0.4) });
  await waitFor(() => {
    expect(setVolume).toHaveBeenLastCalledWith('alice', 0, true);
  });
});

test('replacement tracks receive the current volume again', async () => {
  const setVolume = vi.fn(() => Promise.resolve());
  const { rerender } = render(NativeCallAudio, {
    participants: [participant],
    deafened: false,
    volumeOf: () => 0.5,
    setVolume,
  });
  await waitFor(() => {
    expect(setVolume).toHaveBeenCalledTimes(2);
  });
  await rerender({
    participants: [{ ...participant, screenShareAudio: track('new-audio') }],
  });
  await waitFor(() => {
    expect(setVolume).toHaveBeenCalledTimes(3);
  });
  expect(setVolume).toHaveBeenLastCalledWith('alice', 0.5, true);
});

test('volume updates still queued when the call ends are dropped', async () => {
  let release = () => {};
  const setVolume = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      })
  );
  const { unmount } = render(NativeCallAudio, {
    participants: [participant],
    deafened: false,
    volumeOf: () => 0.5,
    setVolume,
  });
  await waitFor(() => {
    expect(setVolume).toHaveBeenCalledOnce();
  });

  unmount();
  release();
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(setVolume).toHaveBeenCalledOnce();
});
