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

async function press(element: Element): Promise<void> {
  element.dispatchEvent(
    new PointerEvent('pointerdown', {
      bubbles: true,
      cancelable: true,
      pointerType: 'mouse',
      button: 0,
      isPrimary: true,
    })
  );
  element.dispatchEvent(
    new PointerEvent('pointerup', { bubbles: true, cancelable: true, pointerType: 'mouse' })
  );
  element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }));
  await tick();
}

async function render(): Promise<HTMLButtonElement> {
  instance = mount(AppIconSettings, { target: document.body });
  await vi.waitFor(() => {
    expect(document.querySelectorAll('button')).toHaveLength(1);
  });
  const button = document.querySelector<HTMLButtonElement>('button');
  if (!button) throw new Error('App icon selector did not render');
  return button;
}

async function options(trigger: HTMLElement): Promise<HTMLElement[]> {
  await press(trigger);
  await vi.waitFor(() => {
    expect(document.querySelectorAll<HTMLElement>('[role="option"]')).toHaveLength(3);
  });
  return Array.from(document.querySelectorAll<HTMLElement>('[role="option"]'));
}

function selectorTrigger(): HTMLButtonElement {
  const button = document.querySelector<HTMLButtonElement>('button');
  if (!button) throw new Error('App icon selector did not render');
  return button;
}

test('reads the installed icon without changing it, then restores default with null', async () => {
  const trigger = await render();
  expect(trigger.textContent).toContain('Pride');
  expect(invoke).toHaveBeenCalledTimes(2);
  const choices = await options(trigger);
  expect(choices.every((choice) => choice.querySelector('.select-item-image') !== null)).toBe(true);
  expect(choices[0].querySelector('.app-icon-image-android')).not.toBeNull();
  await press(choices[0]);
  await vi.waitFor(() => {
    expect(invoke).toHaveBeenCalledWith('plugin:app-icon|set_icon', {
      request: { icon: null },
    });
  });
  await tick();
  expect(trigger.textContent).toContain('Default');
});

test('keeps the confirmed icon on failure and allows retry', async () => {
  const trigger = await render();
  const choices = await options(trigger);
  vi.mocked(invoke).mockRejectedValueOnce(new Error('native failure'));
  await press(choices[1]);
  await vi.waitFor(() => {
    expect(document.querySelector('[role="alert"]')).not.toBeNull();
  });
  expect(selectorTrigger().textContent).toContain('Pride');
  vi.mocked(invoke).mockResolvedValueOnce(undefined);
  const retryChoices = await options(selectorTrigger());
  await press(retryChoices[1]);
  await vi.waitFor(() => {
    expect(selectorTrigger().textContent).toContain('Propeller');
  });
  expect(invoke).toHaveBeenLastCalledWith('plugin:app-icon|set_icon', {
    request: { icon: 'propeller' },
  });
});

test('disables choices during a native change', async () => {
  const trigger = await render();
  const choices = await options(trigger);
  let complete!: () => void;
  vi.mocked(invoke).mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        complete = resolve;
      })
  );
  await press(choices[1]);
  await tick();
  expect(trigger.disabled).toBe(true);
  complete();
  await tick();
  expect(trigger.textContent).toContain('Propeller');
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
  const trigger = await render();
  expect(trigger.textContent).toContain('Pride');
  expect(document.querySelector('.app-icons.android')).toBeNull();
});

test('shows Default for an unknown native icon without resetting it', async () => {
  vi.mocked(invoke).mockImplementation((command) =>
    Promise.resolve(
      command === 'plugin:app-icon|get_available_icons' ? ['propeller', 'pride'] : 'old-icon'
    )
  );
  const trigger = await render();
  expect(trigger.textContent).toContain('Default');
  expect(invoke).toHaveBeenCalledTimes(2);
});
