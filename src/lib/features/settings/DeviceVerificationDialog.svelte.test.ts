// @vitest-environment happy-dom

import { mount, tick, unmount } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';

const core = vi.hoisted(() => {
  const commands = {
    acceptVerification: vi.fn(() => Promise.resolve()),
    cancelVerification: vi.fn(() => Promise.resolve()),
    confirmVerification: vi.fn(() => Promise.resolve()),
  };
  return {
    commands,
    session: { user_id: '@alice:example.org' },
    subscribeEvents: vi.fn(() => () => {}),
    verification: {
      flowId: 'flow',
      state: {
        phase: 'compare' as const,
        emojis: [
          { symbol: '🐶', description: 'Dog' },
          { symbol: '🐶', description: 'Dog again' },
        ],
        decimals: [1, 2, 3] as [number, number, number],
      },
    },
  };
});

vi.mock('#lib/core/context.js', () => ({ useCoreClient: () => core }));

import DeviceVerificationDialog from './DeviceVerificationDialog.svelte';

afterEach(() => {
  document.body.replaceChildren();
  vi.clearAllMocks();
});

test('renders every SAS emoji slot when a symbol repeats', async () => {
  const instance = mount(DeviceVerificationDialog, { target: document.body });
  await tick();

  expect(
    Array.from(document.querySelectorAll('.emoji-item span'), (node) => node.textContent)
  ).toEqual(['🐶', '🐶']);
  expect(
    Array.from(document.querySelectorAll('.emoji-item small'), (node) => node.textContent)
  ).toEqual(['Dog', 'Dog again']);

  await unmount(instance);
});
