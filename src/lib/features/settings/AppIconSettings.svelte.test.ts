// @vitest-environment happy-dom
import { render, screen } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { tick } from 'svelte';
import { beforeEach, expect, test, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(), isTauri: vi.fn() }));
vi.mock('@tauri-apps/plugin-os', () => ({ type: vi.fn() }));
import { invoke, isTauri } from '@tauri-apps/api/core';
import { type as osType } from '@tauri-apps/plugin-os';
import AppIconSettings from './AppIconSettings.svelte';

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
const user = userEvent.setup();

const selectorTrigger = () => screen.getByRole('button', { name: 'App icon' });

async function setup(): Promise<HTMLElement> {
  render(AppIconSettings);
  return screen.findByRole('button', { name: 'App icon' });
}

async function options(trigger: HTMLElement): Promise<HTMLElement[]> {
  await user.click(trigger);
  await vi.waitFor(() => {
    expect(screen.getAllByRole('option')).toHaveLength(3);
  });
  return screen.getAllByRole('option');
}

test('reads the installed icon without changing it, then restores default with null', async () => {
  const trigger = await setup();
  expect(trigger).toHaveTextContent('Pride');
  expect(invoke).toHaveBeenCalledTimes(2);
  const choices = await options(trigger);
  expect(choices.every((choice) => choice.querySelector('.select-item-image') !== null)).toBe(true);
  expect(choices[0].querySelector('.app-icon-image-android')).not.toBeNull();
  await user.click(choices[0]);
  await vi.waitFor(() => {
    expect(invoke).toHaveBeenCalledWith('plugin:app-icon|set_icon', {
      request: { icon: null },
    });
  });
  await tick();
  expect(trigger).toHaveTextContent('Default');
});

test('keeps the confirmed icon on failure and allows retry', async () => {
  const trigger = await setup();
  const choices = await options(trigger);
  vi.mocked(invoke).mockRejectedValueOnce(new Error('native failure'));
  await user.click(choices[1]);
  await vi.waitFor(() => {
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });
  expect(selectorTrigger()).toHaveTextContent('Pride');
  vi.mocked(invoke).mockResolvedValueOnce(undefined);
  const retryChoices = await options(selectorTrigger());
  await user.click(retryChoices[1]);
  await vi.waitFor(() => {
    expect(selectorTrigger()).toHaveTextContent('Propeller');
  });
  expect(invoke).toHaveBeenLastCalledWith('plugin:app-icon|set_icon', {
    request: { icon: 'propeller' },
  });
});

test('disables choices during a native change', async () => {
  const trigger = await setup();
  const choices = await options(trigger);
  let complete!: () => void;
  vi.mocked(invoke).mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        complete = resolve;
      })
  );
  await user.click(choices[1]);
  await tick();
  expect(trigger).toBeDisabled();
  complete();
  await tick();
  expect(trigger).toHaveTextContent('Propeller');
});

test.each(['web', 'linux', 'macos', 'windows'])(
  'does not invoke the plugin on %s',
  async (platform) => {
    vi.mocked(isTauri).mockReturnValue(platform !== 'web');
    vi.mocked(osType).mockReturnValue(platform as ReturnType<typeof osType>);
    render(AppIconSettings);
    await tick();
    expect(invoke).not.toHaveBeenCalled();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  }
);

test('hides the picker when native discovery fails', async () => {
  vi.mocked(invoke).mockRejectedValue(new Error('missing plugin'));
  render(AppIconSettings);
  await tick();
  expect(screen.queryByRole('button')).not.toBeInTheDocument();
});

test('uses the current native icon on iOS', async () => {
  vi.mocked(osType).mockReturnValue('ios');
  const trigger = await setup();
  expect(trigger).toHaveTextContent('Pride');
  expect(document.querySelector('.app-icons.android')).toBeNull();
});

test('shows Default for an unknown native icon without resetting it', async () => {
  vi.mocked(invoke).mockImplementation((command) =>
    Promise.resolve(
      command === 'plugin:app-icon|get_available_icons' ? ['propeller', 'pride'] : 'old-icon'
    )
  );
  const trigger = await setup();
  expect(trigger).toHaveTextContent('Default');
  expect(invoke).toHaveBeenCalledTimes(2);
});
