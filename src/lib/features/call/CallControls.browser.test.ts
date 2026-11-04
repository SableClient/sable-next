import { expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';
import { expectNoA11yViolations } from '#lib/test-support/a11y.js';
import CallControlsHarness from './CallControlsHarness.test.svelte';

test.each([
  { name: 'desktop', width: 1100, height: 700 },
  { name: 'narrow', width: 390, height: 700 },
])('push-to-talk controls work at $name width', async ({ width, height }) => {
  await page.viewport(width, height);
  const onPushToTalk = vi.fn<(held: boolean, source: string) => void>();
  const screen = await render(CallControlsHarness, {
    microphoneEnabled: true,
    cameraEnabled: false,
    screenShareEnabled: false,
    deafened: false,
    ready: true,
    canScreenShare: true,
    pushToTalk: true,
    onPushToTalk,
    onToggleMicrophone: vi.fn(),
    onToggleCamera: vi.fn(),
    onToggleScreenShare: vi.fn(),
    onToggleDeafen: vi.fn(),
    onHangUp: vi.fn(),
  });
  const talk = screen.getByRole('button', { name: 'Hold to talk' });
  await userEvent.click(talk);
  expect(onPushToTalk.mock.calls.map(([held]) => held)).toEqual([true, false]);
  const button = talk.element();
  button.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }));
  await expect.element(talk).toHaveAttribute('aria-pressed', 'true');
  button.dispatchEvent(new KeyboardEvent('keyup', { key: ' ', bubbles: true, cancelable: true }));
  await expect.element(talk).toHaveAttribute('aria-pressed', 'false');
  await expectNoA11yViolations(document.body);
  button.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
  );
  await screen.rerender({ pushToTalk: false });
  expect(onPushToTalk).toHaveBeenLastCalledWith(false, expect.any(String));
});
