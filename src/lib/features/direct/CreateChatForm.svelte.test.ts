// @vitest-environment happy-dom

import { mount, tick, unmount } from 'svelte';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const core = vi.hoisted(() => ({
  createDm: vi.fn<() => Promise<string>>(),
}));

const navigation = vi.hoisted(() => ({ goto: vi.fn<() => Promise<void>>() }));

vi.mock('#lib/core/context.js', () => ({ useCoreClient: () => core }));
vi.mock('$app/navigation', () => ({ goto: navigation.goto }));
vi.mock('$app/paths', () => ({
  resolve: (path: string, params: Record<string, string>) =>
    path.replace('[roomId]', params.roomId),
}));
vi.mock('#lib/i18n.js', () => ({
  i18n: {
    subscribe(run: (value: { t: (key: string) => string }) => void) {
      run({ t: (key) => key });
      return () => {};
    },
  },
}));
vi.mock('#lib/rooms/room-list.svelte.js', () => ({
  roomPathParamFromId: (roomId: string) => encodeURIComponent(roomId),
}));

import CreateChatForm from './CreateChatForm.svelte';

async function mountForm() {
  const instance = mount(CreateChatForm, { target: document.body });
  await tick();
  return instance;
}

async function fill(value: string) {
  const input = document.querySelector<HTMLInputElement>('#create-chat-user');
  if (!input) throw new Error('user id input missing');
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await tick();
}

function submit() {
  document.querySelector('.create-chat')?.dispatchEvent(new Event('submit'));
}

beforeEach(() => {
  navigation.goto.mockClear();
  core.createDm.mockReset();
  navigation.goto.mockResolvedValue(undefined);
});

afterEach(() => {
  document.body.replaceChildren();
});

test('creates the chat and navigates to it under the direct section', async () => {
  core.createDm.mockResolvedValue('!dm:example.org');
  const instance = await mountForm();

  await fill('@alice:example.org');
  submit();
  await vi.waitFor(() => {
    expect(core.createDm).toHaveBeenCalledWith('@alice:example.org');
  });

  expect(navigation.goto).toHaveBeenCalledWith('/(app)/direct/!dm%3Aexample.org');
  await unmount(instance);
});

test('rejects an input that is not a user id without calling the core', async () => {
  const instance = await mountForm();

  await fill('alice');
  submit();
  await tick();

  expect(core.createDm).not.toHaveBeenCalled();
  expect(document.querySelector('.error')?.textContent).toBe('direct.invalid');
  await unmount(instance);
});

test('reports a failed creation and stays on the page', async () => {
  core.createDm.mockRejectedValue(new Error('nope'));
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const instance = await mountForm();

  await fill('@alice:example.org');
  submit();
  await vi.waitFor(() => {
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('direct.failed');
  });

  expect(navigation.goto).not.toHaveBeenCalled();
  warn.mockRestore();
  await unmount(instance);
});
