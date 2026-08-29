// @vitest-environment happy-dom

import { mount, tick, unmount } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';

const core = vi.hoisted(() => {
  const stub = {
    notificationKeywords: vi.fn<() => Promise<string[]>>(),
    addNotificationKeyword: vi.fn<(keyword: string) => Promise<void>>(),
    removeNotificationKeyword: vi.fn<(keyword: string) => Promise<void>>(),
  };

  return Object.assign(stub, { commands: stub });
});

vi.mock('#lib/core/context.js', () => ({
  useCoreClient: () => core,
}));

import NotificationKeywords from './NotificationKeywords.svelte';

afterEach(() => {
  document.body.replaceChildren();
  vi.clearAllMocks();
});

function required<T extends Element>(selector: string, kind: new () => T): T {
  const element = document.querySelector(selector);
  if (!(element instanceof kind)) throw new Error(`expected to find ${selector}`);
  return element;
}

function setInput(input: HTMLInputElement, value: string): void {
  input.value = value;
  input.dispatchEvent(new Event('input'));
}

test('lists the account keywords and lets one be removed', async () => {
  core.notificationKeywords.mockResolvedValueOnce(['erwan', 'sable']);
  core.notificationKeywords.mockResolvedValueOnce(['sable']);
  core.removeNotificationKeyword.mockResolvedValue(undefined);

  const instance = mount(NotificationKeywords, { target: document.body });
  await vi.waitFor(() => {
    expect(document.querySelectorAll('.keyword-list li').length).toBe(2);
  });

  document.querySelector<HTMLButtonElement>('[aria-label="Remove keyword erwan"]')?.click();

  await vi.waitFor(() => {
    expect(core.removeNotificationKeyword).toHaveBeenCalledWith('erwan');
    expect(document.querySelectorAll('.keyword-list li').length).toBe(1);
  });

  await unmount(instance);
});

test('refuses a blank or whitespace-only keyword', async () => {
  core.notificationKeywords.mockResolvedValue([]);

  const instance = mount(NotificationKeywords, { target: document.body });
  await vi.waitFor(() => {
    expect(document.querySelector('.keywords-empty')).not.toBeNull();
  });

  const input = required('input.text-input', HTMLInputElement);
  const form = required('.keyword-form', HTMLFormElement);

  setInput(input, '   ');
  await tick();

  form.dispatchEvent(new Event('submit', { cancelable: true }));
  await tick();

  expect(core.addNotificationKeyword).not.toHaveBeenCalled();

  await unmount(instance);
});

test('does not add a keyword already in the list', async () => {
  core.notificationKeywords.mockResolvedValue(['sable']);

  const instance = mount(NotificationKeywords, { target: document.body });
  await vi.waitFor(() => {
    expect(document.querySelectorAll('.keyword-list li').length).toBe(1);
  });

  const input = required('input.text-input', HTMLInputElement);
  const form = required('.keyword-form', HTMLFormElement);
  setInput(input, 'sable');
  await tick();

  form.dispatchEvent(new Event('submit', { cancelable: true }));
  await tick();

  expect(core.addNotificationKeyword).not.toHaveBeenCalled();

  await unmount(instance);
});

test('does not leave the list showing an add the server rejected', async () => {
  core.notificationKeywords.mockResolvedValue(['sable']);
  core.addNotificationKeyword.mockRejectedValue(new Error('denied'));

  const instance = mount(NotificationKeywords, { target: document.body });
  await vi.waitFor(() => {
    expect(document.querySelectorAll('.keyword-list li').length).toBe(1);
  });

  const input = required('input.text-input', HTMLInputElement);
  const form = required('.keyword-form', HTMLFormElement);
  setInput(input, 'erwan');
  await tick();

  form.dispatchEvent(new Event('submit', { cancelable: true }));

  await vi.waitFor(() => {
    expect(document.querySelector('[role="status"]')).not.toBeNull();
  });
  expect(document.querySelectorAll('.keyword-list li').length).toBe(1);
  expect(core.notificationKeywords).toHaveBeenCalledTimes(1);

  await unmount(instance);
});

test('reports a load failure instead of showing an empty list', async () => {
  core.notificationKeywords.mockRejectedValue(new Error('denied'));

  const instance = mount(NotificationKeywords, { target: document.body });
  await vi.waitFor(() => {
    expect(document.querySelector('[role="status"]')).not.toBeNull();
  });

  await unmount(instance);
});
