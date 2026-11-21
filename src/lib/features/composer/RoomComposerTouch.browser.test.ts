import { afterEach, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';

import type { CoreClient } from '#lib/core/client.svelte.js';
import { createCoreStub } from '#lib/core/__mocks__/context.js';
import { setPreference } from '#lib/settings/preferences.svelte.js';

import Harness from './RoomComposerHarness.test.svelte';

const platform = vi.hoisted(() => ({ android: false }));
vi.mock('#lib/platform/os.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('#lib/platform/os.js')>()),
  isAndroid: () => platform.android,
}));

afterEach(() => {
  platform.android = false;
  document.documentElement.style.removeProperty('--keyboard-height');
  setPreference('composerForm', 'tall');
  setPreference('richTextComposer', true);
});

async function mountComposer() {
  const core = createCoreStub({
    commands: {
      roomMembers: () => Promise.resolve([]),
      fetchMedia: () => Promise.resolve(new Uint8Array()),
    },
    rpc: {
      messages: { mediaConfig: () => Promise.resolve({ upload_size: 100 * 1024 * 1024 }) },
      room_state: { botCommands: () => Promise.resolve([]) },
      personas: { list: () => Promise.resolve({ personas: [], selections: [] }) },
      packs: { list: () => Promise.resolve({ packs: [], complete: true }) },
    },
  }) as unknown as CoreClient;
  return render(Harness, {
    core,
    rooms: [],
    composer: {
      roomId: '!touch:example.org',
      onSend: () => Promise.resolve(),
      onSendAttachment: () => Promise.resolve(),
      onTyping: () => Promise.resolve(),
    },
  });
}

test('a multiline expanded composer fits above the landscape phone keyboard', async () => {
  await page.viewport(390, 844);
  setPreference('richTextComposer', true);
  setPreference('composerForm', 'tall');
  const screen = await mountComposer();
  const composer = screen.getByRole('combobox');
  const expand = document.querySelector<HTMLElement>('.composer-expand');
  if (!expand) throw new Error('the expand button is not rendered');
  await userEvent.click(expand);
  await expect.poll(() => document.querySelector('.editor.expanded')).not.toBeNull();
  await page.viewport(844, 390);
  document.documentElement.style.setProperty('--keyboard-height', '190px');
  await userEvent.click(composer);
  const data = new DataTransfer();
  data.setData('text/plain', 'a line\n'.repeat(20));
  const editor = document.querySelector<HTMLElement>('.ProseMirror');
  if (!editor) throw new Error('the editor is not rendered');
  editor.dispatchEvent(
    new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true })
  );
  await expect.poll(() => document.querySelector('.composer-row.short')).not.toBeNull();
  await expect.poll(() => editor.textContent).toContain('a line');
  const row = document.querySelector('.composer-row') as HTMLElement;
  expect(row.getBoundingClientRect().height).toBeLessThan(100);
  const editorBox = editor.getBoundingClientRect();
  const send = document.querySelector<HTMLElement>('.composer-send');
  if (!send) throw new Error('the send button is not rendered');
  const sendBox = send.getBoundingClientRect();
  expect(sendBox.height).toBeGreaterThanOrEqual(40);
  expect(sendBox.top).toBeLessThan(editorBox.bottom);
  expect(sendBox.bottom).toBeGreaterThan(editorBox.top);
});

test('opening the keyboard keeps the portrait composer readable', async () => {
  await page.viewport(412, 844);
  setPreference('composerForm', 'tall');
  const screen = await mountComposer();
  await userEvent.click(screen.getByRole('combobox'));
  await page.viewport(412, 400);
  await expect.poll(() => window.innerHeight).toBe(400);
  await new Promise(requestAnimationFrame);
  await new Promise(requestAnimationFrame);
  const row = document.querySelector<HTMLElement>('.composer-row');
  expect(row?.classList.contains('short')).toBe(false);
  const editor = row?.querySelector<HTMLElement>('.editor');
  const controls = row?.querySelector<HTMLElement>('.composer-after');
  if (!row || !editor || !controls) throw new Error('Missing composer elements');
  expect(editor.getBoundingClientRect().width).toBeGreaterThan(
    row.getBoundingClientRect().width * 0.8
  );
  expect(controls.getBoundingClientRect().top).toBeGreaterThanOrEqual(
    editor.getBoundingClientRect().bottom
  );
});

test('the android keyboard keeps a wide portrait composer tall', async () => {
  platform.android = true;
  await page.viewport(540, 1000);
  setPreference('composerForm', 'tall');
  const screen = await mountComposer();
  await userEvent.click(screen.getByRole('combobox'));
  await page.viewport(540, 400);
  await expect.poll(() => window.innerHeight).toBe(400);
  await new Promise(requestAnimationFrame);
  await new Promise(requestAnimationFrame);
  expect(document.querySelector('.composer-row')?.classList.contains('short')).toBe(false);
  expect(document.querySelector('.composer-expand')).not.toBeNull();
});
