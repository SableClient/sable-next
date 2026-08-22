// @vitest-environment happy-dom

import type { ImagePackView } from '#src/generated/ImagePackView';
import type { MemberView } from '#src/generated/MemberView';
import type { CoreClient } from '#lib/core/client.svelte.js';
import { mount, tick, unmount } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';

import type { ComposerContext } from './composer-context';
import { setPreference } from '#lib/settings/preferences.svelte.js';
import { clearDrafts } from './composer-drafts';
import { ComposerEditor } from './editor/composer-editor';
import Harness from './RoomComposerHarness.test.svelte';

afterEach(() => {
  document.body.replaceChildren();
  clearDrafts();
  setPreference('formattingToolbar', false);
  setPreference('richTextComposer', true);
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
  onSend?: (
    roomId: string,
    body: string,
    formatted: string | null,
    mentions: { userIds: string[]; room: boolean }
  ) => Promise<void>;
  onSendAttachment?: (roomId: string, file: File, options: { caption?: string }) => Promise<void>;
  onTyping?: (roomId: string, typing: boolean) => Promise<void>;
  context?: ComposerContext;
  readOnly?: boolean;
  registerReply?: (reply: () => void) => void;
  registerContext?: (set: (next: ComposerContext | null) => void) => void;
}

function render({
  registerReply,
  registerContext,
  ...composer
}: ComposerProps): ReturnType<typeof mount> {
  return mount(Harness, {
    target: document.body,
    props: {
      core: core(),
      registerReply,
      registerContext,
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

  expect(attachment).toHaveBeenCalledWith('!room:example.org', file, {});
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
  expect(attachment).toHaveBeenCalledWith('!room:example.org', second, {});
  void unmount(instance);
});

test('text rides a lone attachment as its caption', async () => {
  const attachment = vi.fn(async () => {});
  const message = vi.fn(async () => {});
  const instance = render({
    roomId: '!room:example.org',
    onSendAttachment: attachment,
    onSend: message,
    context: { kind: 'edit', eventId: '$one:example.org', body: 'look at this' },
  });
  await tick();
  const file = new File(['one'], 'one.png', { type: 'image/png' });

  await pick(file);
  submit();
  await tick();

  expect(attachment).toHaveBeenCalledWith('!room:example.org', file, { caption: 'look at this' });
  expect(message).not.toHaveBeenCalled();
  void unmount(instance);
});

test('text follows two attachments as its own message', async () => {
  const attachment = vi.fn(async () => {});
  const message = vi.fn(async () => {});
  const instance = render({
    roomId: '!room:example.org',
    onSendAttachment: attachment,
    onSend: message,
    context: { kind: 'edit', eventId: '$one:example.org', body: 'both of these' },
  });
  await tick();

  await pick(
    new File(['one'], 'one.png', { type: 'image/png' }),
    new File(['two'], 'two.png', { type: 'image/png' })
  );
  submit();
  await vi.waitFor(() => {
    expect(message).toHaveBeenCalled();
  });

  expect(attachment).toHaveBeenCalledTimes(2);
  expect(attachment).toHaveBeenNthCalledWith(1, '!room:example.org', expect.anything(), {});
  expect(attachment).toHaveBeenNthCalledWith(2, '!room:example.org', expect.anything(), {});
  expect(message).toHaveBeenCalledWith('!room:example.org', 'both of these', null, {
    userIds: [],
    room: false,
  });
  void unmount(instance);
});

test('a drop the editor already took is not staged a second time', async () => {
  const instance = render({ roomId: '!room:example.org' });
  await tick();

  const editable = document.querySelector('[role="combobox"]');
  if (!editable) throw new Error('editor surface not found');
  const drop = new Event('drop', { bubbles: true, cancelable: true });
  Object.defineProperty(drop, 'dataTransfer', {
    value: { files: [new File(['one'], 'one.png', { type: 'image/png' })] },
  });
  editable.addEventListener('drop', (event) => {
    event.preventDefault();
  });

  editable.dispatchEvent(drop);
  await tick();

  expect(stagedNames()).toEqual([]);
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

test('replying to the same event restores focus to the editor', async () => {
  let reply: (() => void) | undefined;
  const instance = render({
    roomId: '!room:example.org',
    context: { kind: 'reply', eventId: '$one:example.org', sender: 'Alice', body: 'Hello' },
    registerReply: (next) => {
      reply = next;
    },
  });
  await tick();

  const editor = document.querySelector('[role="combobox"]');
  if (!(editor instanceof HTMLElement)) throw new Error('editor not found');
  await vi.waitFor(() => {
    expect(document.activeElement).toBe(editor);
  });

  editor.blur();
  reply?.();

  await vi.waitFor(() => {
    expect(document.activeElement).toBe(editor);
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

test.each([
  ['successful', async () => {}, 1],
  ['failed', async () => Promise.reject(new Error('offline')), 0],
])(
  'a %s send resets editor history only after it succeeds',
  async (_outcome, onSend, expectedCalls) => {
    const clearHistory = vi.spyOn(ComposerEditor.prototype, 'clearHistory');
    try {
      const instance = render({
        roomId: '!room:example.org',
        onSend,
        context: { kind: 'edit', eventId: '$one:example.org', body: 'hold on' },
      });
      await tick();
      submit();

      if (expectedCalls === 0) {
        await vi.waitFor(() => {
          expect(document.querySelector('[role="alert"]')).not.toBeNull();
        });
      } else {
        await vi.waitFor(() => {
          expect(clearHistory).toHaveBeenCalledTimes(expectedCalls);
        });
      }
      expect(clearHistory).toHaveBeenCalledTimes(expectedCalls);
      void unmount(instance);
    } finally {
      clearHistory.mockRestore();
    }
  }
);

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

test('a read-only room offers an empty box in place of the composer', async () => {
  const instance = render({ roomId: '!room:example.org', readOnly: true });
  await tick();

  expect(document.querySelector('p.locked')?.textContent).toBe(
    'You do not have permission to post in this room'
  );
  expect(document.querySelector('[role="combobox"]')).toBeNull();
  expect(document.querySelectorAll('.composer button')).toHaveLength(0);
  void unmount(instance);
});

test('a staged file survives leaving the room and coming back', async () => {
  const first = render({ roomId: '!room:example.org' });
  await tick();
  await pick(new File(['one'], 'one.png', { type: 'image/png' }));

  await unmount(first);
  document.body.replaceChildren();
  const second = render({ roomId: '!room:example.org' });
  await tick();

  expect(stagedNames()).toEqual(['one.png']);
  void unmount(second);
});

test('another room does not inherit the draft', async () => {
  const first = render({ roomId: '!room:example.org' });
  await tick();
  await pick(new File(['one'], 'one.png', { type: 'image/png' }));

  await unmount(first);
  document.body.replaceChildren();
  const second = render({ roomId: '!other:example.org' });
  await tick();

  expect(stagedNames()).toEqual([]);
  void unmount(second);
});

test('an edit hands back the draft it interrupted', async () => {
  let setContext: ((next: ComposerContext | null) => void) | undefined;
  const instance = render({
    roomId: '!room:example.org',
    registerContext: (set) => {
      setContext = set;
    },
  });
  await tick();
  setContext?.({ kind: 'edit', eventId: '$draft:example.org', body: 'half a thought' });
  await tick();
  setContext?.(null);
  await tick();
  setContext?.({ kind: 'edit', eventId: '$one:example.org', body: 'the older message' });
  await tick();

  expect(editorText()).toBe('the older message');

  setContext?.(null);
  await tick();

  expect(editorText()).toBe('half a thought');
  void unmount(instance);
});

test('an oversized file is refused before it is staged', async () => {
  const instance = render({ roomId: '!room:example.org' });
  await tick();
  const huge = new File(['x'], 'huge.bin', { type: 'application/octet-stream' });
  Object.defineProperty(huge, 'size', { value: 101 * 1024 * 1024 });

  await pick(huge);

  expect(stagedNames()).toEqual([]);
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('huge.bin');
  void unmount(instance);
});

test('a batch over the limit is refused as a batch', async () => {
  const instance = render({ roomId: '!room:example.org' });
  await tick();
  const half = (): File => {
    const file = new File(['x'], 'half.bin', { type: 'application/octet-stream' });
    Object.defineProperty(file, 'size', { value: 60 * 1024 * 1024 });
    return file;
  };

  await pick(half());
  expect(stagedNames()).toEqual(['half.bin']);

  await pick(half());

  expect(stagedNames()).toEqual(['half.bin']);
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('more than');
  void unmount(instance);
});

function formattingToggle(): HTMLElement {
  const element = document.querySelector('.composer-format');
  if (!(element instanceof HTMLElement)) throw new Error('formatting toggle not found');
  return element;
}

function formattingBar(): Element | null {
  return document.querySelector('.formatting');
}

test('the formatting toolbar follows its setting', async () => {
  const app = render({ roomId: '!room:example.org' });
  await tick();
  expect(formattingBar()).toBeNull();

  setPreference('formattingToolbar', true);
  await tick();
  expect(formattingBar()).not.toBeNull();

  void unmount(app);
});

test('the toolbar toggle writes the setting back, so it survives a remount', async () => {
  const first = render({ roomId: '!room:example.org' });
  await tick();
  formattingToggle().click();
  await tick();

  expect(formattingToggle().getAttribute('aria-pressed')).toBe('true');
  void unmount(first);

  const second = render({ roomId: '!room:example.org' });
  await tick();
  expect(formattingBar()).not.toBeNull();
  void unmount(second);
});

test('neither the toolbar nor its toggle appear without rich text', async () => {
  setPreference('formattingToolbar', true);
  setPreference('richTextComposer', false);
  const app = render({ roomId: '!room:example.org' });
  await tick();

  expect(document.querySelector('.composer-format')).toBeNull();
  expect(formattingBar()).toBeNull();
  void unmount(app);
});
