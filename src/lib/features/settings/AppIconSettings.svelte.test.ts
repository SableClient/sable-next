// @vitest-environment happy-dom
import { mount, tick, unmount } from 'svelte';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(), isTauri: vi.fn() }));
vi.mock('@tauri-apps/plugin-os', () => ({ type: vi.fn() }));
import { invoke, isTauri } from '@tauri-apps/api/core';
import { type as osType } from '@tauri-apps/plugin-os';
import AppIconSettings from './AppIconSettings.svelte';

let instance: ReturnType<typeof mount>;
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(isTauri).mockReturnValue(true);
  vi.mocked(osType).mockReturnValue('android');
  vi.mocked(invoke).mockImplementation((command) => {
    if (command === 'plugin:app-icon|get_available_icons')
      return Promise.resolve(['propeller', 'pride']);
    if (command === 'plugin:app-icon|get_current_icon') return Promise.resolve('pride');
    return Promise.resolve(undefined);
  });
});
afterEach(async () => {
  await unmount(instance);
  document.body.replaceChildren();
});

async function render(): Promise<HTMLButtonElement[]> {
  instance = mount(AppIconSettings, { target: document.body });
  await vi.waitFor(() => {
    expect(document.querySelectorAll('button')).toHaveLength(3);
  });
  return Array.from(document.querySelectorAll('button'));
}

test('reads the installed icon without changing it, then restores default with null', async () => {
  const buttons = await render();
  expect(buttons[2].getAttribute('aria-pressed')).toBe('true');
  expect(invoke).toHaveBeenCalledTimes(2);
  buttons[0].click();
  await vi.waitFor(() => {
    expect(invoke).toHaveBeenCalledWith('plugin:app-icon|set_icon', {
      request: { icon: null },
    });
  });
  await tick();
  expect(buttons[0].getAttribute('aria-pressed')).toBe('true');
});

test('keeps the confirmed icon on failure and allows retry', async () => {
  const buttons = await render();
  vi.mocked(invoke).mockRejectedValueOnce(new Error('native failure'));
  buttons[1].click();
  await vi.waitFor(() => {
    expect(document.querySelector('[role="alert"]')).not.toBeNull();
  });
  expect(buttons[2].getAttribute('aria-pressed')).toBe('true');
  vi.mocked(invoke).mockResolvedValueOnce(undefined);
  buttons[1].click();
  await vi.waitFor(() => {
    expect(buttons[1].getAttribute('aria-pressed')).toBe('true');
  });
  expect(invoke).toHaveBeenLastCalledWith('plugin:app-icon|set_icon', {
    request: { icon: 'propeller' },
  });
});

test('disables choices during a native change', async () => {
  const buttons = await render();
  let complete!: () => void;
  vi.mocked(invoke).mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        complete = resolve;
      })
  );
  buttons[1].click();
  await tick();
  expect(buttons.every((button) => button.disabled)).toBe(true);
  complete();
  await tick();
  expect(buttons[1].getAttribute('aria-pressed')).toBe('true');
});

test.each(['web', 'linux', 'macos', 'windows'])(
  'does not invoke the plugin on %s',
  async (platform) => {
    vi.mocked(isTauri).mockReturnValue(platform !== 'web');
    vi.mocked(osType).mockReturnValue(platform as ReturnType<typeof osType>);
    instance = mount(AppIconSettings, { target: document.body });
    await tick();
    expect(invoke).not.toHaveBeenCalled();
    expect(document.querySelector('button')).toBeNull();
  }
);

test('hides the picker when native discovery fails', async () => {
  vi.mocked(invoke).mockRejectedValue(new Error('missing plugin'));
  instance = mount(AppIconSettings, { target: document.body });
  await tick();
  expect(document.querySelector('button')).toBeNull();
});

test('uses the current native icon on iOS', async () => {
  vi.mocked(osType).mockReturnValue('ios');
  const buttons = await render();
  expect(buttons[2].getAttribute('aria-pressed')).toBe('true');
  expect(document.querySelector('.app-icons.android')).toBeNull();
});

test('shows Default for an unknown native icon without resetting it', async () => {
  vi.mocked(invoke).mockImplementation((command) =>
    Promise.resolve(
      command === 'plugin:app-icon|get_available_icons' ? ['propeller', 'pride'] : 'old-icon'
    )
  );
  const buttons = await render();
  expect(buttons[0].getAttribute('aria-pressed')).toBe('true');
  expect(invoke).toHaveBeenCalledTimes(2);
});
