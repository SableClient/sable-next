// @vitest-environment happy-dom

import type { ImagePackView } from '#src/generated/ImagePackView';
import type { MemberView } from '#src/generated/MemberView';
import type { CoreClient } from '#lib/core/client.svelte.js';
import { mount, tick, unmount } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';

import type { ComposerContext } from './composer-context';
import Harness from './RoomComposerHarness.test.svelte';

afterEach(() => {
  document.body.replaceChildren();
});

const members: MemberView[] = [
  { user_id: '@one:example.org', display_name: 'Member One', avatar_url: null, power_level: 0 },
];

const packs: ImagePackView[] = [
  {
    id: '',
    origin: 'room',
    room_id: '!room:example.org',
    name: 'Room pack',
    avatar_url: null,
    attribution: null,
    images: [{ shortcode: 'wave', url: 'mxc://example.org/wave', body: null, usage: ['emoticon'] }],
  },
];

function core(): CoreClient {
  return {
    roomMembers: () => Promise.resolve(members),
    imagePacks: () => Promise.resolve(packs),
    fetchMedia: () => Promise.resolve(new Uint8Array()),
  } as unknown as CoreClient;
}

interface ComposerProps {
  roomId: string;
  onSend?: (roomId: string, body: string, formatted?: string | null) => Promise<void>;
  onSendAttachment?: (roomId: string, file: File) => Promise<void>;
  onTyping?: (roomId: string, typing: boolean) => Promise<void>;
  context?: ComposerContext;
}

function render(composer: ComposerProps): ReturnType<typeof mount> {
  return mount(Harness, {
    target: document.body,
    props: {
      core: core(),
      composer: {
        onSend: async () => {},
        onSendAttachment: async () => {},
        onTyping: async () => {},
        ...composer,
      },
    },
  });
}

function fileInput(): HTMLInputElement {
  const element = document.querySelector('input[type="file"]');
  if (!(element instanceof HTMLInputElement)) throw new Error('attachment input not found');
  return element;
}

function submit(): void {
  document.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true }));
}

function editorText(): string {
  return document.querySelector('[role="combobox"]')?.textContent ?? '';
}

function stagedNames(): (string | null)[] {
  return Array.from(document.querySelectorAll('.staged-name')).map((node) => node.textContent);
}

async function pick(...files: File[]): Promise<void> {
  const input = fileInput();
  Object.defineProperty(input, 'files', { configurable: true, value: files });
  input.dispatchEvent(new Event('change', { bubbles: true }));
  await tick();
}

test('the editor mounts as a labelled combobox surface', async () => {
  const instance = render({ roomId: '!room:example.org' });
  await tick();

  const editable = document.querySelector('[role="combobox"]');
  expect(editable?.getAttribute('aria-label')).toBe('Send a message...');
  expect(editable?.getAttribute('contenteditable')).toBe('true');

  void unmount(instance);
});

test('an unmount stops the typing notice for the room it was mounted with', async () => {
  const typing = vi.fn(async () => {});
  const instance = render({ roomId: '!first:example.org', onTyping: typing });
  await tick();

  await unmount(instance);

  expect(typing).toHaveBeenLastCalledWith('!first:example.org', false);
});

test('stages any selected attachment, not only images, and sends it on submit', async () => {
  const attachment = vi.fn(async () => {});
  const instance = render({ roomId: '!room:example.org', onSendAttachment: attachment });
  const file = new File(['report'], 'report.pdf', { type: 'application/pdf' });

  await pick(file);

  expect(stagedNames()).toEqual(['report.pdf']);
  expect(attachment).not.toHaveBeenCalled();

  submit();
  await tick();

  expect(attachment).toHaveBeenCalledWith('!room:example.org', file);
  void unmount(instance);
});

test('stages files dropped on the composer, and drops one on demand', async () => {
  const attachment = vi.fn(async () => {});
  const instance = render({ roomId: '!room:example.org', onSendAttachment: attachment });
  const first = new File(['one'], 'one.png', { type: 'image/png' });
  const second = new File(['two'], 'two.png', { type: 'image/png' });
  const drop = new Event('drop', { bubbles: true, cancelable: true });
  Object.defineProperty(drop, 'dataTransfer', { value: { files: [first, second] } });

  document.querySelector('.composer')?.dispatchEvent(drop);
  await tick();

  expect(drop.defaultPrevented).toBe(true);
  expect(stagedNames()).toEqual(['one.png', 'two.png']);

  const remove = document.querySelector('.staged-item button');
  if (!(remove instanceof HTMLButtonElement)) throw new Error('remove control not found');
  remove.click();
  await tick();

  submit();
  await tick();

  expect(attachment).toHaveBeenCalledTimes(1);
  expect(attachment).toHaveBeenCalledWith('!room:example.org', second);
  void unmount(instance);
});

test('the send verb stays disabled until there is something to send', async () => {
  const instance = render({ roomId: '!room:example.org' });
  const send = document.querySelector('button[type="submit"]');
  if (!(send instanceof HTMLButtonElement)) throw new Error('send control not found');

  expect(send.disabled).toBe(true);

  await pick(new File(['one'], 'one.png', { type: 'image/png' }));

  expect(send.disabled).toBe(false);
  void unmount(instance);
});

test('the editor stays editable after a send', async () => {
  const instance = render({ roomId: '!room:example.org' });
  await tick();

  await pick(new File(['one'], 'one.png', { type: 'image/png' }));
  submit();
  await vi.waitFor(() => {
    expect(document.querySelector('.staged-name')).toBeNull();
  });

  expect(document.querySelector('[role="combobox"]')?.getAttribute('contenteditable')).toBe('true');
  void unmount(instance);
});

test('sending returns focus to the editor', async () => {
  const instance = render({ roomId: '!room:example.org' });
  await pick(new File(['one'], 'one.png', { type: 'image/png' }));

  const editor = document.querySelector('[role="combobox"]');
  if (!(editor instanceof HTMLElement)) throw new Error('editor not found');
  editor.focus();

  const send = document.querySelector('button[type="submit"]');
  if (!(send instanceof HTMLButtonElement)) throw new Error('send control not found');
  const mousedown = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
  send.dispatchEvent(mousedown);
  expect(mousedown.defaultPrevented).toBe(true);
  submit();

  await vi.waitFor(() => {
    expect(document.activeElement).toBe(document.querySelector('[role="combobox"]'));
  });

  void unmount(instance);
});

test('the editor keeps focus while a send is pending', async () => {
  let resolveSend: (() => void) | undefined;
  const instance = render({
    roomId: '!room:example.org',
    onSend: () =>
      new Promise<void>((resolve) => {
        resolveSend = resolve;
      }),
  });
  await tick();

  const editor = document.querySelector('[role="combobox"]');
  if (!(editor instanceof HTMLElement)) throw new Error('editor not found');
  editor.focus();
  await pick(new File(['one'], 'one.png', { type: 'image/png' }));
  submit();
  await tick();

  expect(document.activeElement).toBe(editor);
  expect(editor.getAttribute('contenteditable')).toBe('true');

  resolveSend?.();
  await vi.waitFor(() => {
    expect(document.querySelector('.staged-name')).toBeNull();
  });

  void unmount(instance);
});

test('a failed send puts the message back in the editor', async () => {
  const instance = render({
    roomId: '!room:example.org',
    onSend: () => Promise.reject(new Error('offline')),
    context: { kind: 'edit', eventId: '$one:example.org', body: 'hold on' },
  });
  await tick();

  expect(editorText()).toBe('hold on');

  submit();
  await vi.waitFor(() => {
    expect(document.querySelector('[role="alert"]')).not.toBeNull();
  });

  expect(editorText()).toBe('hold on');
  void unmount(instance);
});

test('a partly sent batch only restages what did not go out', async () => {
  const sent: string[] = [];
  const attachment = vi.fn((_roomId: string, file: File) => {
    sent.push(file.name);
    return file.name === 'two.png' ? Promise.reject(new Error('offline')) : Promise.resolve();
  });
  const instance = render({ roomId: '!room:example.org', onSendAttachment: attachment });

  await pick(
    new File(['one'], 'one.png', { type: 'image/png' }),
    new File(['two'], 'two.png', { type: 'image/png' })
  );
  submit();
  await vi.waitFor(() => {
    expect(document.querySelector('[role="alert"]')).not.toBeNull();
  });

  expect(sent).toEqual(['one.png', 'two.png']);
  expect(stagedNames()).toEqual(['two.png']);
  void unmount(instance);
});

test('a failed attachment keeps the file staged and reports the failure', async () => {
  const instance = render({
    roomId: '!room:example.org',
    onSendAttachment: () => Promise.reject(new Error('offline')),
  });

  await pick(new File(['one'], 'one.png', { type: 'image/png' }));
  submit();
  await vi.waitFor(() => {
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('Failed to send');
  });

  expect(stagedNames()).toEqual(['one.png']);
  void unmount(instance);
});
