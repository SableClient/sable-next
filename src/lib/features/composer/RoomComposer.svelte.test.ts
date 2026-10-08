// @vitest-environment happy-dom

import type {
  BotCommandDescriptionView,
  ImagePackView,
  ImageSourcePackView,
  MemberView,
  RoomSummary,
} from '#src/generated/protocol';
import { SCHEDULE_PRESS_MS } from '#lib/ui/long-press.svelte.js';
import { guardTouchClicks } from '#lib/ui/trailing-click.js';
import type { CoreClient } from '#lib/core/client.svelte.js';
import type { SendAttachmentOptions, SendGalleryOptions } from '#lib/core/commands.svelte.js';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
  type RenderResult,
} from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { tick } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';

import type { BotCommandInvocation } from './bot-commands';
import type { ComposerContext } from './composer-context';
import { invalidatePacks } from '#lib/emoji/load-packs.js';
import { setPreference } from '#lib/settings/preferences.svelte.js';
import { REORDER_DRAG_TYPE } from '#lib/ui/drag-list.js';
import {
  adoptDraftDocuments,
  clearDraft,
  clearDrafts,
  readDraft,
  writeDraft,
} from './composer-drafts.svelte';
import { ComposerEditor } from './editor/composer-editor';
import { composerSchema } from './editor/schema';
import { textDoc } from './editor/serialize';
import Harness from './RoomComposerHarness.test.svelte';

afterEach(() => {
  cleanup();
  mediaConfig.mockReset();
  mediaConfig.mockResolvedValue({ upload_size: 100 * 1024 * 1024 });
  clearDrafts();
  setPreference('formattingToolbar', false);
  setPreference('composerFormatButton', true);
  setPreference('composerButtonOrder', ['gif', 'sticker', 'emoticon', 'persona', 'format']);
  setPreference('richTextComposer', true);
  setPreference('sendAttachmentAsCaption', true);
  setPreference('sendAttachmentsAsGallery', true);
  setPreference('enterForNewline', 'send');
});

const members: MemberView[] = [
  {
    user_id: '@one:example.org',
    display_name: 'Member One',
    avatar_url: null,
    power_level: 0,
    membership: 'join' as const,
    member_ts: null,
    kicked: false,
    service: false,
  },
];

const packs: ImagePackView[] = [
  {
    id: '',
    origin: 'room',
    room_id: '!room:example.org',
    name: 'Room pack',
    avatar_url: null,
    declared_name: null,
    declared_avatar_url: null,
    stable_event: false,
    legacy_event: false,
    attribution: null,
    usage: ['emoticon', 'sticker'],
    images: [
      {
        shortcode: 'wave',
        url: 'mxc://example.org/wave',
        body: null,
        usage: ['emoticon'],
        info: null,
        source_pack: null,
      },
    ],
  },
];

const mediaConfig = vi.fn(() => Promise.resolve({ upload_size: 100 * 1024 * 1024 }));

const scheduleAttachment = vi.fn(() => Promise.resolve('delayed'));

const botCommands: BotCommandDescriptionView[] = [
  {
    sender: '@bot:example.org',
    sender_name: 'Bot',
    sender_avatar: null,
    content: {
      command: 'warn',
      parameters: [
        { key: 'user', schema: { schema_type: 'primitive', type: 'user_id' } },
        { key: 'days', schema: { schema_type: 'primitive', type: 'integer' } },
      ],
    },
  },
  {
    sender: '@bot:example.org',
    sender_name: 'Bot',
    sender_avatar: null,
    content: { command: 'register' },
  },
];

function core(): CoreClient {
  return {
    subscribeEvents: () => () => {},
    commands: {
      scheduleAttachment,
      mediaConfig,
      botCommands: () => Promise.resolve(botCommands),
      personas: () => Promise.resolve({ personas: [], selections: [] }),
      roomMembers: () => Promise.resolve(members),
      imagePackListing: () => Promise.resolve({ packs, complete: true }),
      fetchMedia: () => Promise.resolve(new Uint8Array()),
    },
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
  onSendBotCommand?: (
    roomId: string,
    bot: string,
    body: string,
    invocation: BotCommandInvocation
  ) => Promise<void>;
  onSendAttachment?: (roomId: string, file: File, options: SendAttachmentOptions) => Promise<void>;
  onSendGallery?: (
    roomId: string,
    files: readonly File[],
    options: SendGalleryOptions
  ) => Promise<void>;
  onSchedule?: (
    roomId: string,
    body: string,
    formatted: string | null,
    dueTs: number
  ) => Promise<void>;
  onTyping?: (roomId: string, typing: boolean) => Promise<void>;
  onQuickReact?: (
    roomId: string,
    key: string,
    sourcePack: ImageSourcePackView | null
  ) => Promise<void>;
  canReact?: boolean;
  context?: ComposerContext;
  onCancelContext?: () => void;
  onDeleteEdited?: (eventId: string, reason: string | null) => void;
  onReplyStep?: (direction: 'older' | 'newer') => void;
  onEditLast?: (before?: string) => void;
  onEditNext?: (after: string) => void;
  threadRoot?: string | null;
  readOnly?: boolean;
  encrypted?: boolean | null;
  roomName?: string;
  registerReply?: (reply: () => void) => void;
  registerContext?: (set: (next: ComposerContext | null) => void) => void;
  registerRoom?: (set: (roomId: string) => void) => void;
}

function setup(
  { registerReply, registerContext, registerRoom, ...composer }: ComposerProps,
  client: CoreClient = core(),
  rooms: RoomSummary[] = []
): RenderResult<typeof Harness> {
  return render(Harness, {
    props: {
      core: client,
      rooms,
      registerReply,
      registerContext,
      registerRoom,
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

const user = userEvent.setup({ applyAccept: false, delay: null });

function submit(): void {
  const form = document.querySelector('form');
  if (!form) throw new Error('composer form not found');
  void fireEvent.submit(form);
}

async function press(element: Element | null): Promise<void> {
  if (!element) throw new Error('nothing to press');
  await user.click(element);
}

function editorText(): string {
  return document.querySelector('[role="combobox"]')?.textContent ?? '';
}

function stagedNames(): (string | null)[] {
  return Array.from(document.querySelectorAll('.staged-name')).map((node) => node.textContent);
}

async function pick(...files: File[]): Promise<void> {
  await user.upload(fileInput(), files);
  await tick();
}

test('the editor mounts as a labelled combobox surface', async () => {
  setup({ roomId: '!room:example.org' });
  await tick();

  const editable = document.querySelector('[role="combobox"]');
  expect(editable?.getAttribute('aria-label')).toBe('Send a message…');
  expect(editable?.getAttribute('contenteditable')).toBe('true');
});

test.each(['send', 'newline'] as const)(
  'the visible keyboard hint follows enterForNewline=%s',
  async (newline) => {
    setPreference('enterForNewline', newline);
    setup({ roomId: '!room:example.org' });
    await tick();

    expect(document.querySelector('.screen-reader-only[id^="composer-hint"]')).toHaveTextContent(
      newline === 'newline'
        ? 'Shift+Enter to send · Enter for a new line'
        : 'Enter to send · Shift+Enter for a new line'
    );
  }
);

test('editing names the save action and its keyboard hint', async () => {
  setup({
    roomId: '!room:example.org',
    context: { kind: 'edit', eventId: '$one:example.org', body: 'original' },
  });
  await tick();

  expect(screen.getByRole('button', { name: 'Save changes' })).toBeInTheDocument();
  expect(document.querySelector('.screen-reader-only[id^="composer-hint"]')).toHaveTextContent(
    'Enter to save'
  );
});

test('a staged attachment names caption mode and changes its placeholder with the toggle', async () => {
  setup({ roomId: '!room:example.org' });
  await tick();
  await pick(new File(['one'], 'one.txt', { type: 'text/plain' }));

  const toggle = screen.getByRole('button', { name: 'Caption' });
  expect(document.querySelector('.editor')).toHaveAttribute(
    'data-placeholder',
    'Add a caption, or send as-is'
  );

  await press(toggle);
  expect(toggle).toHaveTextContent('Separate message');
  expect(document.querySelector('.editor')).toHaveAttribute(
    'data-placeholder',
    'Add a message, or send as-is'
  );
});

test.each([
  ['\\*like so*', '<span>*</span>like so<span>*</span>'],
  ['\\`code\\`', '<span>`</span>code<span>`</span>'],
  ['\\$[unixtime 0]', '<span>$</span>[unixtime 0]'],
])('Markdown mode renders escapes in %j', async (source, formatted) => {
  setPreference('richTextComposer', false);
  writeDraft('!room:example.org', {
    doc: textDoc(source).toJSON(),
    staged: [],
    nextStagedId: 0,
  });
  const send = vi.fn(async () => {});
  setup({ roomId: '!room:example.org', onSend: send });
  await tick();
  expect(editorText()).toBe(source);

  submit();

  await vi.waitFor(() => {
    expect(send).toHaveBeenCalledWith('!room:example.org', source, formatted, {
      userIds: [],
      room: false,
    });
  });
});

test('an unmount stops the typing notice for the room it was mounted with', async () => {
  const typing = vi.fn(async () => {});
  const instance = setup({ roomId: '!first:example.org', onTyping: typing });
  await tick();

  instance.unmount();

  expect(typing).toHaveBeenLastCalledWith('!first:example.org', false);
});

test('stages any selected attachment, not only images, and sends it on submit', async () => {
  const attachment = vi.fn(async () => {});
  setup({ roomId: '!room:example.org', onSendAttachment: attachment });
  const file = new File(['report'], 'report.pdf', { type: 'application/pdf' });

  await pick(file);

  expect(stagedNames()).toEqual(['report.pdf']);
  expect(attachment).not.toHaveBeenCalled();

  submit();

  await vi.waitFor(() => {
    expect(attachment).toHaveBeenCalledWith('!room:example.org', file, { spoiler: false });
  });
});

test('sends multiple staged files as one gallery', async () => {
  const gallery = vi.fn(async () => {});
  const attachment = vi.fn(async () => {});
  setup({
    roomId: '!room:example.org',
    onSendAttachment: attachment,
    onSendGallery: gallery,
  });
  const first = new File(['one'], 'one.png', { type: 'image/png' });
  const second = new File(['two'], 'two.pdf', { type: 'application/pdf' });

  await pick(first, second);
  submit();
  await tick();

  await vi.waitFor(() => {
    expect(gallery).toHaveBeenCalledTimes(1);
  });
  expect(gallery).toHaveBeenCalledWith('!room:example.org', [first, second], {
    caption: null,
    formattedCaption: null,
    mentions: { userIds: [], room: false },
  });
  expect(attachment).not.toHaveBeenCalled();
});

test('sends each staged file on its own when galleries are off', async () => {
  setPreference('sendAttachmentsAsGallery', false);
  const gallery = vi.fn(async () => {});
  const attachment = vi.fn(async () => {});
  setup({
    roomId: '!room:example.org',
    onSendAttachment: attachment,
    onSendGallery: gallery,
  });
  const first = new File(['one'], 'one.png', { type: 'image/png' });
  const second = new File(['two'], 'two.pdf', { type: 'application/pdf' });

  await pick(first, second);
  submit();
  await tick();

  expect(gallery).not.toHaveBeenCalled();
  await vi.waitFor(() => {
    expect(attachment).toHaveBeenCalledTimes(2);
  });
  expect(attachment).toHaveBeenNthCalledWith(1, '!room:example.org', first, { spoiler: false });
  expect(attachment).toHaveBeenNthCalledWith(2, '!room:example.org', second, { spoiler: false });
});

function dragEvent(type: string, types: string[] = ['Files']): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', { value: { files: [], types } });
  return event;
}

test('a file dragged anywhere over the window opens the drop overlay', async () => {
  setup({ roomId: '!room:example.org', roomName: 'Design' });

  window.dispatchEvent(dragEvent('dragover'));
  await tick();

  const overlay = document.querySelector('.drop-overlay');
  expect(overlay?.textContent).toContain('Design');

  const leave = new Event('dragleave', { bubbles: true });
  Object.defineProperty(leave, 'relatedTarget', { value: null });
  window.dispatchEvent(leave);
  await tick();

  expect(document.querySelector('.drop-overlay')).toBeNull();
});

test('dragging something that is not a file does not open the overlay', async () => {
  setup({ roomId: '!room:example.org' });

  window.dispatchEvent(dragEvent('dragover', ['text/plain']));
  await tick();

  expect(document.querySelector('.drop-overlay')).toBeNull();
});

test('a read-only room shows no overlay and stages nothing', async () => {
  const attachment = vi.fn(async () => {});
  setup({
    roomId: '!room:example.org',
    readOnly: true,
    onSendAttachment: attachment,
  });

  window.dispatchEvent(dragEvent('dragover'));
  await tick();
  expect(document.querySelector('.drop-overlay')).toBeNull();

  const drop = new Event('drop', { bubbles: true, cancelable: true });
  const file = new File(['one'], 'one.png', { type: 'image/png' });
  Object.defineProperty(drop, 'dataTransfer', { value: { files: [file], types: ['Files'] } });
  window.dispatchEvent(drop);
  await tick();

  expect(drop.defaultPrevented).toBe(false);
  expect(stagedNames()).toEqual([]);
});

test('a sidebar reorder drag opens no drop overlay and stages nothing', async () => {
  setup({ roomId: '!room:example.org', roomName: 'Design' });

  window.dispatchEvent(dragEvent('dragover', ['Files', REORDER_DRAG_TYPE]));
  await tick();
  expect(document.querySelector('.drop-overlay')).toBeNull();

  const file = new File(['one'], 'one.png', { type: 'image/png' });
  const drop = new Event('drop', { bubbles: true, cancelable: true });
  Object.defineProperty(drop, 'dataTransfer', {
    value: { files: [file], types: ['Files', REORDER_DRAG_TYPE] },
  });
  window.dispatchEvent(drop);
  await tick();

  expect(drop.defaultPrevented).toBe(false);
  expect(stagedNames()).toEqual([]);
});

test('a drag started inside the page is stamped so the composer refuses it', () => {
  setup({ roomId: '!room:example.org' });
  const setData = vi.fn();
  const start = new Event('dragstart', { bubbles: true });
  Object.defineProperty(start, 'dataTransfer', { value: { setData } });

  document.body.dispatchEvent(start);

  expect(setData).toHaveBeenCalledWith(REORDER_DRAG_TYPE, '');
});

test('a file dropped outside the composer is staged', async () => {
  setup({ roomId: '!room:example.org' });
  const file = new File(['one'], 'one.png', { type: 'image/png' });
  const drop = new Event('drop', { bubbles: true, cancelable: true });
  Object.defineProperty(drop, 'dataTransfer', { value: { files: [file], types: ['Files'] } });

  window.dispatchEvent(drop);
  await tick();

  expect(drop.defaultPrevented).toBe(true);
  expect(stagedNames()).toEqual(['one.png']);
});

test('stages files dropped on the composer, and drops one on demand', async () => {
  const attachment = vi.fn(async () => {});
  setup({ roomId: '!room:example.org', onSendAttachment: attachment });
  const first = new File(['one'], 'one.png', { type: 'image/png' });
  const second = new File(['two'], 'two.png', { type: 'image/png' });
  const drop = new Event('drop', { bubbles: true, cancelable: true });
  Object.defineProperty(drop, 'dataTransfer', {
    value: { files: [first, second], types: ['Files'] },
  });

  document.querySelector('.composer')?.dispatchEvent(drop);
  await tick();

  expect(drop.defaultPrevented).toBe(true);
  expect(stagedNames()).toEqual(['one.png', 'two.png']);

  const remove = document.querySelector('.staged-remove');
  if (!(remove instanceof HTMLButtonElement)) throw new Error('remove control not found');
  await press(remove);
  await tick();

  submit();
  await tick();

  await vi.waitFor(() => {
    expect(attachment).toHaveBeenCalledTimes(1);
  });
  expect(attachment).toHaveBeenCalledWith('!room:example.org', second, { spoiler: false });
});

test.each([true, false])(
  'editing preserves mentions and custom emotes with richTextComposer=%s',
  async (richTextComposer) => {
    setPreference('richTextComposer', richTextComposer);
    const message = vi.fn(async () => {});
    const body = 'hey @_one:example.org :wave:';
    const html =
      'hey <a href="https://matrix.to/#/@one:example.org">@_one:example.org</a> <img data-mx-emoticon="" src="mxc://example.org/wave" alt=":wave:" title=":wave:" height="32">';
    setup({
      roomId: '!room:example.org',
      onSend: message,
      context: { kind: 'edit', eventId: '$one:example.org', body, html },
    });
    await tick();

    submit();

    await vi.waitFor(() => {
      expect(message).toHaveBeenCalledWith('!room:example.org', body, html, {
        userIds: ['@one:example.org'],
        room: false,
      });
    });
  }
);

test('text rides a lone attachment as its caption', async () => {
  const attachment = vi.fn(async () => {});
  const message = vi.fn(async () => {});
  setup({
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

  await vi.waitFor(() => {
    expect(attachment).toHaveBeenCalledTimes(1);
  });
  expect(attachment).toHaveBeenCalledWith('!room:example.org', file, {
    caption: 'look at this',
    formattedCaption: null,
    mentions: { userIds: [], room: false },
    spoiler: false,
  });
  expect(message).not.toHaveBeenCalled();
});

test.each([true, false])(
  'a lone attachment preserves rich caption details in %s composer mode',
  async (richTextComposer) => {
    setPreference('richTextComposer', richTextComposer);
    const attachment = vi.fn(async () => {});
    const file = new File(['image'], 'caption.png', { type: 'image/png' });
    const caption = composerSchema.node('doc', null, [
      composerSchema.nodes.paragraph.create(null, [
        composerSchema.text('hey '),
        composerSchema.nodes.mention.create({ userId: '@one:example.org', name: 'Member One' }),
        composerSchema.text(' '),
        composerSchema.nodes.emoticon.create({ url: 'mxc://example.org/wave', shortcode: 'wave' }),
      ]),
    ]);
    writeDraft('!room:example.org', { doc: caption.toJSON(), staged: [], nextStagedId: 0 });
    setup({
      roomId: '!room:example.org',
      onSendAttachment: attachment,
    });

    await tick();
    await pick(file);
    submit();

    await vi.waitFor(() => {
      expect(attachment).toHaveBeenCalled();
    });
    expect(attachment).toHaveBeenCalledWith('!room:example.org', file, {
      caption: 'hey Member One :wave:',
      formattedCaption:
        'hey <a href="https://matrix.to/#/@one:example.org">Member One</a> <img data-mx-emoticon="" src="mxc://example.org/wave" alt=":wave:" title=":wave:" height="32">',
      mentions: { userIds: ['@one:example.org'], room: false },
      spoiler: false,
    });
  }
);

test('the caption toggle sends text beside a lone attachment', async () => {
  const attachment = vi.fn(async () => {});
  const message = vi.fn(async () => {});
  setup({
    roomId: '!room:example.org',
    onSendAttachment: attachment,
    onSend: message,
    context: { kind: 'edit', eventId: '$one:example.org', body: 'look at this' },
  });
  await tick();
  const file = new File(['one'], 'one.png', { type: 'image/png' });

  await pick(file);
  const toggle = document.querySelector('.staged-caption');
  if (!(toggle instanceof HTMLButtonElement)) throw new Error('caption toggle not found');
  expect(toggle).toHaveTextContent('Caption');
  await press(toggle);
  await tick();
  expect(toggle).toHaveTextContent('Separate message');

  submit();
  await vi.waitFor(() => {
    expect(message).toHaveBeenCalled();
  });

  expect(attachment).toHaveBeenCalledWith('!room:example.org', file, { spoiler: false });
  expect(message).toHaveBeenCalledWith('!room:example.org', 'look at this', null, {
    userIds: [],
    room: false,
  });
});

test('the caption toggle only offers itself for a lone attachment', async () => {
  setup({ roomId: '!room:example.org' });
  await tick();

  await pick(new File(['one'], 'one.png', { type: 'image/png' }));
  expect(document.querySelector('.staged-caption')).not.toBeNull();

  await pick(new File(['two'], 'two.png', { type: 'image/png' }));
  expect(document.querySelector('.staged-caption')).toBeNull();
});

test('text follows two attachments as its own message', async () => {
  const attachment = vi.fn(async () => {});
  const message = vi.fn(async () => {});
  setup({
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
  expect(attachment).toHaveBeenNthCalledWith(1, '!room:example.org', expect.anything(), {
    spoiler: false,
  });
  expect(attachment).toHaveBeenNthCalledWith(2, '!room:example.org', expect.anything(), {
    spoiler: false,
  });
  expect(message).toHaveBeenCalledWith('!room:example.org', 'both of these', null, {
    userIds: [],
    room: false,
  });
});

test('a drop the editor already took is not staged a second time', async () => {
  setup({ roomId: '!room:example.org' });
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
});

test('the send verb stays disabled until there is something to send', async () => {
  setup({ roomId: '!room:example.org' });
  const send = document.querySelector('button[type="submit"]');
  if (!(send instanceof HTMLButtonElement)) throw new Error('send control not found');

  expect(send.disabled).toBe(true);

  await pick(new File(['one'], 'one.png', { type: 'image/png' }));

  expect(send.disabled).toBe(false);
});

test('the editor stays editable after a send', async () => {
  setup({ roomId: '!room:example.org' });
  await tick();

  await pick(new File(['one'], 'one.png', { type: 'image/png' }));
  submit();
  await vi.waitFor(() => {
    expect(document.querySelector('.staged-name')).toBeNull();
  });

  expect(document.querySelector('[role="combobox"]')?.getAttribute('contenteditable')).toBe('true');
});

test('sending returns focus to the editor', async () => {
  setup({ roomId: '!room:example.org' });
  await pick(new File(['one'], 'one.png', { type: 'image/png' }));

  const editor = document.querySelector('[role="combobox"]');
  if (!(editor instanceof HTMLElement)) throw new Error('editor not found');
  editor.focus();

  const send = document.querySelector('button[type="submit"]');
  if (!(send instanceof HTMLButtonElement)) throw new Error('send control not found');
  expect(await fireEvent.mouseDown(send)).toBe(false);
  submit();

  await vi.waitFor(() => {
    expect(document.activeElement).toBe(document.querySelector('[role="combobox"]'));
  });
});

test('replying to the same event restores focus to the editor', async () => {
  let reply: (() => void) | undefined;
  setup({
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
});

test('finishing an edit keeps focus in the editor', async () => {
  let setContext: ((next: ComposerContext | null) => void) | undefined;
  setup({
    roomId: '!room:example.org',
    context: { kind: 'edit', eventId: '$one:example.org', body: 'original' },
    registerContext: (set) => {
      setContext = set;
    },
  });
  await tick();

  const editor = document.querySelector('[role="combobox"]');
  if (!(editor instanceof HTMLElement)) throw new Error('editor not found');
  await vi.waitFor(() => {
    expect(document.activeElement).toBe(editor);
  });

  setContext?.(null);
  await tick();
  await new Promise((resolve) => requestAnimationFrame(resolve));

  expect(document.activeElement).toBe(editor);
});

test('staging files returns focus to the editor', async () => {
  setup({ roomId: '!room:example.org' });
  await tick();

  const editor = document.querySelector('[role="combobox"]');
  if (!(editor instanceof HTMLElement)) throw new Error('editor not found');
  expect(document.activeElement).not.toBe(editor);

  await pick(new File(['one'], 'one.png', { type: 'image/png' }));

  expect(document.activeElement).toBe(editor);
});

test('a long reply sender keeps both context actions in the composer', async () => {
  setup({
    roomId: '!room:example.org',
    context: {
      kind: 'reply',
      eventId: '$one:example.org',
      sender: '@a-user-name-that-is-long-enough-to-push-the-actions-off-screen:example.org',
      body: 'Hello',
    },
  });
  await tick();

  const contextKind = document.querySelector('.context-kind');
  expect(contextKind).not.toBeNull();
  expect(document.querySelectorAll('.context button')).toHaveLength(2);
});

test('the editor keeps focus while a send is pending', async () => {
  let resolveSend: (() => void) | undefined;
  setup({
    roomId: '!room:example.org',
    onSend: () =>
      new Promise<void>((resolve) => {
        resolveSend = resolve;
      }),
  });
  await tick();

  const editor = document.querySelector('[role="combobox"]');
  if (!(editor instanceof HTMLElement)) throw new Error('editor not found');
  await pick(new File(['one'], 'one.png', { type: 'image/png' }));
  editor.focus();
  submit();
  await tick();

  expect(document.activeElement).toBe(editor);
  expect(editor.getAttribute('contenteditable')).toBe('true');

  resolveSend?.();
  await vi.waitFor(() => {
    expect(document.querySelector('.staged-name')).toBeNull();
  });
});

test.each([
  ['successful', async () => {}, 1],
  ['failed', async () => Promise.reject(new Error('offline')), 0],
])(
  'a %s send resets editor history only after it succeeds',
  async (_outcome, onSend, expectedCalls) => {
    const clearHistory = vi.spyOn(ComposerEditor.prototype, 'clearHistory');
    try {
      const instance = setup({
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
      instance.unmount();
    } finally {
      clearHistory.mockRestore();
    }
  }
);

test('recording a voice message keeps the typed draft', async () => {
  vi.stubGlobal('AudioContext', vi.fn());
  vi.stubGlobal('Worker', vi.fn());
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia: () => Promise.reject(new DOMException('', 'NotAllowedError')) },
  });
  try {
    writeDraft('!room:example.org', {
      doc: textDoc('hold on').toJSON(),
      staged: [],
      nextStagedId: 0,
    });
    setup({ roomId: '!room:example.org' });
    await tick();

    await press(screen.getByRole('button', { name: 'Record a voice message' }));
    await vi.waitFor(() => {
      expect(document.querySelector('.voice-close')).not.toBeNull();
    });
    await press(document.querySelector('.voice-close'));

    await vi.waitFor(() => {
      expect(editorText()).toBe('hold on');
    });
    expect(screen.getByRole('button', { name: 'Record a voice message' })).toBeInTheDocument();
  } finally {
    vi.unstubAllGlobals();
    Reflect.deleteProperty(navigator, 'mediaDevices');
  }
});

test('a failed send puts the message back in the editor', async () => {
  setup({
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
});

test('a failed send offers a retry that sends the restored message', async () => {
  const send = vi
    .fn<() => Promise<void>>()
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValueOnce();
  writeDraft('!room:example.org', {
    doc: textDoc('hold on').toJSON(),
    staged: [],
    nextStagedId: 0,
  });
  setup({ roomId: '!room:example.org', onSend: send });
  await tick();

  submit();
  await press(await screen.findByRole('button', { name: 'Retry' }));

  await vi.waitFor(() => {
    expect(send).toHaveBeenCalledTimes(2);
  });
  expect(send).toHaveBeenLastCalledWith('!room:example.org', 'hold on', null, {
    room: false,
    userIds: [],
  });
  expect(screen.queryByRole('alert')).toBeNull();
});

test('a refused send can be dismissed but not retried', async () => {
  const refused = Object.assign(new Error('denied'), { detail: { code: 'denied' } });
  writeDraft('!room:example.org', {
    doc: textDoc('hold on').toJSON(),
    staged: [],
    nextStagedId: 0,
  });
  setup({ roomId: '!room:example.org', onSend: () => Promise.reject(refused) });
  await tick();

  submit();
  const alert = await screen.findByRole('alert');
  expect(alert).toHaveTextContent('You do not have permission to send that here');
  expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();

  await press(screen.getByRole('button', { name: 'Dismiss' }));
  expect(screen.queryByRole('alert')).toBeNull();
});

test('a partly sent batch only restages what did not go out', async () => {
  const sent: string[] = [];
  const attachment = vi.fn((_roomId: string, file: File) => {
    sent.push(file.name);
    return file.name === 'two.png' ? Promise.reject(new Error('offline')) : Promise.resolve();
  });
  setup({ roomId: '!room:example.org', onSendAttachment: attachment });

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
});

test('a failed attachment keeps the file staged and reports the failure', async () => {
  setup({
    roomId: '!room:example.org',
    onSendAttachment: () => Promise.reject(new Error('offline')),
  });

  await pick(new File(['one'], 'one.png', { type: 'image/png' }));
  submit();
  await vi.waitFor(() => {
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('Could not send.');
  });

  expect(stagedNames()).toEqual(['one.png']);
});

test('a read-only room offers an empty box in place of the composer', async () => {
  setup({ roomId: '!room:example.org', readOnly: true });
  await tick();

  expect(document.querySelector('p.locked')?.textContent).toBe(
    'You do not have permission to post in this room'
  );
  expect(document.querySelector('[role="combobox"]')).toBeNull();
  expect(document.querySelectorAll('.composer button')).toHaveLength(0);
});

test('a staged file survives leaving the room and coming back', async () => {
  const first = setup({ roomId: '!room:example.org' });
  await tick();
  await pick(new File(['one'], 'one.png', { type: 'image/png' }));

  first.unmount();
  setup({ roomId: '!room:example.org' });
  await tick();

  expect(stagedNames()).toEqual(['one.png']);
});

test('another room does not inherit the draft', async () => {
  const first = setup({ roomId: '!room:example.org' });
  await tick();
  await pick(new File(['one'], 'one.png', { type: 'image/png' }));

  first.unmount();
  setup({ roomId: '!other:example.org' });
  await tick();

  expect(stagedNames()).toEqual([]);
});

test('switching rooms saves the active draft under its original room', async () => {
  const draft = composerSchema.node('doc', null, [
    composerSchema.node('paragraph', null, [composerSchema.text('half a thought')]),
  ]);
  writeDraft('!first:example.org', { doc: draft.toJSON(), staged: [], nextStagedId: 0 });
  let switchRoom: ((roomId: string) => void) | undefined;
  const first = setup({
    roomId: '!first:example.org',
    registerRoom: (set) => {
      switchRoom = set;
    },
  });
  await tick();
  clearDraft('!first:example.org');

  switchRoom?.('!second:example.org');
  await tick();
  first.unmount();

  setup({ roomId: '!first:example.org' });
  await tick();

  expect(editorText()).toBe('half a thought');
});

test('an unmount keeps the typed draft for the next mount', async () => {
  const draft = composerSchema.node('doc', null, [
    composerSchema.node('paragraph', null, [composerSchema.text('half a thought')]),
  ]);
  writeDraft('!room:example.org', { doc: draft.toJSON(), staged: [], nextStagedId: 0 });
  const first = setup({ roomId: '!room:example.org' });
  await tick();

  first.unmount();
  setup({ roomId: '!room:example.org' });
  await tick();

  expect(editorText()).toBe('half a thought');
});

test('typing saves the draft without leaving the room', async () => {
  vi.useFakeTimers();
  const draft = composerSchema.node('doc', null, [
    composerSchema.node('paragraph', null, [composerSchema.text('half a thought')]),
  ]);
  writeDraft('!room:example.org', { doc: draft.toJSON(), staged: [], nextStagedId: 0 });
  setup({ roomId: '!room:example.org' });
  await tick();

  clearEditor();
  await vi.advanceTimersByTimeAsync(1000);

  expect(readDraft('!room:example.org')).toBeUndefined();
  vi.useRealTimers();
});

test('a draft from another device appears in the open composer', async () => {
  setup({ roomId: '!room:example.org' });
  await tick();

  const draft = composerSchema.node('doc', null, [
    composerSchema.node('paragraph', null, [composerSchema.text('from the desktop')]),
  ]);
  adoptDraftDocuments({ '!room:example.org': draft.toJSON() as unknown });
  await tick();

  expect(editorText()).toBe('from the desktop');
});

test('a thread keeps its draft out of the room it hangs off', async () => {
  const thread = setup({ roomId: '!room:example.org', threadRoot: '$root:example.org' });
  await tick();
  await pick(new File(['one'], 'thread.png', { type: 'image/png' }));

  thread.unmount();
  const room = setup({ roomId: '!room:example.org' });
  await tick();

  expect(stagedNames()).toEqual([]);
  room.unmount();
  setup({ roomId: '!room:example.org', threadRoot: '$root:example.org' });
  await tick();

  expect(stagedNames()).toEqual(['thread.png']);
});

test('an edit hands back the draft it interrupted', async () => {
  const draft = composerSchema.node('doc', null, [
    composerSchema.node('paragraph', null, [composerSchema.text('half a thought')]),
  ]);
  writeDraft('!room:example.org', { doc: draft.toJSON(), staged: [], nextStagedId: 0 });
  let setContext: ((next: ComposerContext | null) => void) | undefined;
  setup({
    roomId: '!room:example.org',
    registerContext: (set) => {
      setContext = set;
    },
  });
  await tick();
  setContext?.({ kind: 'edit', eventId: '$one:example.org', body: 'the older message' });
  await tick();

  expect(editorText()).toBe('the older message');

  setContext?.(null);
  await tick();

  expect(editorText()).toBe('half a thought');
});

test('cancelling an edit clears the message being edited', async () => {
  let setContext: ((next: ComposerContext | null) => void) | undefined;
  setup({
    roomId: '!room:example.org',
    registerContext: (set) => {
      setContext = set;
    },
  });
  await tick();
  setContext?.({ kind: 'edit', eventId: '$one:example.org', body: 'never mind' });
  await tick();

  setContext?.(null);
  await tick();

  expect(editorText()).toBe('');
});

function clearEditor(): void {
  const editor = document.querySelector('[role="combobox"]');
  if (!editor) throw new Error('editor not found');
  for (const init of [{ key: 'a', ctrlKey: true }, { key: 'Backspace' }]) {
    editor.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, ...init }));
  }
}

function deleteDialogButton(): HTMLButtonElement {
  const button = Array.from(document.querySelectorAll('button')).find(
    (candidate) => candidate.textContent.trim() === 'Delete message'
  );
  if (!button) throw new Error('delete confirmation not found');
  return button;
}

test('emptying an edit offers to delete the message instead of sending nothing', async () => {
  const message = vi.fn(async () => {});
  const deleted = vi.fn();
  setup({
    roomId: '!room:example.org',
    onSend: message,
    onDeleteEdited: deleted,
    context: { kind: 'edit', eventId: '$one:example.org', body: 'never mind' },
  });
  await tick();

  clearEditor();
  await tick();
  expect(editorText()).toBe('');

  submit();
  await tick();

  await press(deleteDialogButton());
  await tick();

  expect(deleted).toHaveBeenCalledWith('$one:example.org', null);
  expect(message).not.toHaveBeenCalled();
});

test('an empty composer only offers to delete while an edit is in flight', async () => {
  const deleted = vi.fn();
  setup({ roomId: '!room:example.org', onDeleteEdited: deleted });
  await tick();

  submit();
  await tick();

  expect(document.body.textContent).not.toContain('Delete message');
  expect(deleted).not.toHaveBeenCalled();
});

test('an oversized file is refused before it is staged', async () => {
  setup({ roomId: '!room:example.org' });
  await tick();
  const huge = new File(['x'], 'huge.bin', { type: 'application/octet-stream' });
  Object.defineProperty(huge, 'size', { value: 101 * 1024 * 1024 });

  await pick(huge);

  expect(stagedNames()).toEqual([]);
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('huge.bin');
});

test('stages a file above 100 MiB when the server allows it', async () => {
  mediaConfig.mockResolvedValue({ upload_size: 500 * 1024 * 1024 });
  setup({ roomId: '!room:example.org' });
  const file = new File(['x'], 'large.bin', { type: 'application/octet-stream' });
  Object.defineProperty(file, 'size', { value: 200 * 1024 * 1024 });

  await pick(file);

  expect(stagedNames()).toEqual(['large.bin']);
});

test('shows the server limit when refusing an oversized file', async () => {
  mediaConfig.mockResolvedValue({ upload_size: 10_000_000 });
  setup({ roomId: '!room:example.org' });
  const file = new File(['x'], 'large.bin', { type: 'application/octet-stream' });
  Object.defineProperty(file, 'size', { value: 20_000_000 });

  await pick(file);

  expect(stagedNames()).toEqual([]);
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('10 MB');
});

test('stages files whose combined size exceeds the per-upload limit', async () => {
  setup({ roomId: '!room:example.org' });
  const half = (): File => {
    const file = new File(['x'], 'half.bin', { type: 'application/octet-stream' });
    Object.defineProperty(file, 'size', { value: 60 * 1024 * 1024 });
    return file;
  };

  await pick(half());
  await pick(half());

  expect(stagedNames()).toEqual(['half.bin', 'half.bin']);
  expect(document.querySelector('[role="alert"]')).toBeNull();
});

test('a failed media config lookup can be retried', async () => {
  mediaConfig.mockRejectedValueOnce(new Error('offline'));
  mediaConfig.mockResolvedValue({ upload_size: 500 * 1024 * 1024 });
  setup({ roomId: '!room:example.org' });
  const file = new File(['x'], 'large.bin', { type: 'application/octet-stream' });
  Object.defineProperty(file, 'size', { value: 200 * 1024 * 1024 });

  await pick(file);
  expect(stagedNames()).toEqual([]);
  expect(document.querySelector('[role="alert"]')).not.toBeNull();

  await pick(file);
  expect(stagedNames()).toEqual(['large.bin']);
  expect(document.querySelector('[role="alert"]')).toBeNull();
});

test('files awaiting the server limit do not move into another room', async () => {
  let resolveConfig: ((config: { upload_size: number }) => void) | undefined;
  mediaConfig.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveConfig = resolve;
      })
  );
  let switchRoom: ((roomId: string) => void) | undefined;
  setup({
    roomId: '!first:example.org',
    registerRoom: (set) => {
      switchRoom = set;
    },
  });

  await pick(new File(['x'], 'private.bin'));
  switchRoom?.('!second:example.org');
  await tick();
  resolveConfig?.({ upload_size: 500 * 1024 * 1024 });
  await tick();

  expect(stagedNames()).toEqual([]);
});

test('files awaiting the server limit do not move into another account', async () => {
  let resolveConfig: ((config: { upload_size: number }) => void) | undefined;
  mediaConfig.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveConfig = resolve;
      })
  );
  const session = $state({ account_id: 'a' });
  const client = Object.assign(core(), { session }) as unknown as CoreClient;
  render(Harness, {
    props: {
      core: client,
      composer: {
        roomId: '!room:example.org',
        onSend: async () => {},
        onSendAttachment: async () => {},
        onTyping: async () => {},
      },
    },
  });

  await pick(new File(['x'], 'private.bin'));
  session.account_id = 'b';
  await tick();
  resolveConfig?.({ upload_size: 500 * 1024 * 1024 });
  await tick();

  expect(stagedNames()).toEqual([]);
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
  setup({ roomId: '!room:example.org' });
  await tick();
  expect(formattingBar()).toBeNull();

  setPreference('formattingToolbar', true);
  await tick();
  expect(formattingBar()).not.toBeNull();
});

test('the toolbar toggle writes the setting back, so it survives a remount', async () => {
  const first = setup({ roomId: '!room:example.org' });
  await tick();
  await press(formattingToggle());
  await tick();

  expect(formattingToggle().getAttribute('aria-pressed')).toBe('true');
  first.unmount();

  setup({ roomId: '!room:example.org' });
  await tick();
  expect(formattingBar()).not.toBeNull();
});

test('without rich text the toolbar offers only what markdown can write', async () => {
  setPreference('formattingToolbar', true);
  setPreference('richTextComposer', false);
  setup({ roomId: '!room:example.org' });
  await tick();

  expect(document.querySelector('.composer-format')).not.toBeNull();
  const labels = [...(formattingBar()?.querySelectorAll('button') ?? [])].map((button) =>
    button.getAttribute('aria-label')
  );
  expect(labels).toContain('Bold');
  expect(labels).not.toContain('Underline');
  expect(labels).not.toContain('Edit as Markdown');
});

test('the formatting button can be hidden on its own', async () => {
  setPreference('composerFormatButton', false);
  setup({ roomId: '!room:example.org' });
  await tick();

  expect(document.querySelector('.composer-format')).toBeNull();
});

test('a staged picture marked as a spoiler is sent as one', async () => {
  const attachment = vi.fn(async () => {});
  setup({ roomId: '!room:example.org', onSendAttachment: attachment });
  const file = new File(['one'], 'one.png', { type: 'image/png' });

  await pick(file);

  const toggle = document.querySelector('.staged-spoiler');
  if (!(toggle instanceof HTMLButtonElement)) throw new Error('spoiler control not found');
  expect(toggle.getAttribute('aria-pressed')).toBe('false');
  await press(toggle);
  await tick();
  expect(document.querySelector('.staged-spoiler')?.getAttribute('aria-pressed')).toBe('true');

  submit();
  await tick();

  await vi.waitFor(() => {
    expect(attachment).toHaveBeenCalledTimes(1);
  });
  expect(attachment).toHaveBeenCalledWith('!room:example.org', file, { spoiler: true });
});

test('a document carries no spoiler control', async () => {
  setup({ roomId: '!room:example.org' });

  await pick(new File(['report'], 'report.pdf', { type: 'application/pdf' }));

  expect(document.querySelector('.staged-spoiler')).toBeNull();
});

test('a staged picture offers a metadata choice per file', async () => {
  setup({ roomId: '!room:example.org' });

  await pick(new File(['x'], 'cat.png', { type: 'image/png' }));
  await press(document.querySelector('.staged-options'));

  await press(await screen.findByRole('menuitem', { name: 'Metadata' }));
  const rows = await screen.findAllByRole('menuitem', { name: /location|metadata|Keep/ });
  expect(rows.map((row) => row.textContent.trim())).toEqual([
    '✓ Remove location',
    'Remove all metadata',
    'Keep all metadata',
  ]);
  await press(rows[2]);
  await vi.waitFor(() => {
    expect(document.querySelector('.staged-options')?.className).toContain('staged-spoiler-on');
  });
});

test('on a narrow screen the metadata choice is made in a bottom sheet', async () => {
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
  setup({ roomId: '!room:example.org' });

  await pick(new File(['x'], 'cat.png', { type: 'image/png' }));
  await press(document.querySelector('.staged-options'));
  await press(await screen.findByRole('menuitem', { name: 'Metadata' }));
  await press(await screen.findByRole('menuitemradio', { name: 'Keep all metadata' }));

  await vi.waitFor(() => {
    expect(document.querySelector('.staged-options')?.className).toContain('staged-spoiler-on');
  });
  vi.unstubAllGlobals();
});

test('the staged viewer offers the same metadata choice', async () => {
  setup({ roomId: '!room:example.org' });

  await pick(new File(['x'], 'cat.png', { type: 'image/png' }));
  await press(document.querySelector('.thumb'));
  const viewer = await screen.findByRole('dialog');
  await press(within(viewer).getByRole('button', { name: /Options for cat.png/ }));
  await press(await screen.findByRole('menuitem', { name: 'Metadata' }));
  await press(await screen.findByRole('menuitem', { name: 'Remove all metadata' }));

  await vi.waitFor(() => {
    expect(document.querySelector('.staged-options')?.className).toContain('staged-spoiler-on');
  });
});

test('a document carries no metadata control', async () => {
  setup({ roomId: '!room:example.org' });

  await pick(new File(['report'], 'report.pdf', { type: 'application/pdf' }));

  expect(document.querySelector('.staged-options')).toBeNull();
});

test('a send tap sends immediately', async () => {
  vi.useFakeTimers();
  const stopGuard = guardTouchClicks();
  const send = vi.fn(async () => {});
  const draft = composerSchema.node('doc', null, [
    composerSchema.node('paragraph', null, [composerSchema.text('now')]),
  ]);
  writeDraft('!room:example.org', { doc: draft.toJSON(), staged: [], nextStagedId: 0 });
  const instance = setup({
    roomId: '!room:example.org',
    onSend: send,
    onSchedule: async () => {},
  });

  try {
    await tick();
    const button = sendButton();
    const down = new PointerEvent('pointerdown', {
      bubbles: true,
      cancelable: true,
      pointerType: 'touch',
      isPrimary: true,
    });
    button.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(false);
    await vi.advanceTimersByTimeAsync(100);
    await fireEvent.pointerUp(button, { pointerType: 'touch', isPrimary: true });
    await fireEvent.click(button);

    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0]).toEqual([
      '!room:example.org',
      'now',
      null,
      { userIds: [], room: false },
    ]);
    await vi.advanceTimersByTimeAsync(SCHEDULE_PRESS_MS);
    expect(document.body.textContent).not.toContain('Schedule this message');
  } finally {
    instance.unmount();
    stopGuard();
    vi.useRealTimers();
  }
});

test('a send hold schedules after 800ms', async () => {
  vi.useFakeTimers();
  const send = vi.fn(async () => {});
  const draft = composerSchema.node('doc', null, [
    composerSchema.node('paragraph', null, [composerSchema.text('later')]),
  ]);
  writeDraft('!room:example.org', { doc: draft.toJSON(), staged: [], nextStagedId: 0 });
  const instance = setup({
    roomId: '!room:example.org',
    onSend: send,
    onSchedule: async () => {},
  });
  await tick();

  const button = document.querySelector('.composer-send');
  if (!(button instanceof HTMLButtonElement)) throw new Error('send button not found');
  await fireEvent.pointerDown(button, { pointerType: 'touch', isPrimary: true });
  await vi.advanceTimersByTimeAsync(SCHEDULE_PRESS_MS - 1);
  expect(document.body.textContent).not.toContain('Schedule this message');
  await vi.advanceTimersByTimeAsync(1);
  await tick();

  expect(document.body.textContent).toContain('Schedule this message');
  expect(send).not.toHaveBeenCalled();

  await fireEvent.pointerUp(button, { pointerType: 'touch', isPrimary: true });
  await vi.advanceTimersByTimeAsync(500);
  instance.unmount();
  vi.useRealTimers();
});

test('a touch contextmenu leaves the schedule dialog to the long press', async () => {
  const draft = composerSchema.node('doc', null, [
    composerSchema.node('paragraph', null, [composerSchema.text('later')]),
  ]);
  writeDraft('!room:example.org', { doc: draft.toJSON(), staged: [], nextStagedId: 0 });
  setup({ roomId: '!room:example.org', onSchedule: async () => {} });
  await tick();

  const button = document.querySelector('.composer-send');
  if (!(button instanceof HTMLButtonElement)) throw new Error('send button not found');
  const menu = new PointerEvent('contextmenu', {
    bubbles: true,
    cancelable: true,
    pointerType: 'touch',
  });
  button.dispatchEvent(menu);
  await tick();

  expect(menu.defaultPrevented).toBe(true);
  expect(document.body.textContent).not.toContain('Schedule this message');
});

for (const [pointerType, afterReleaseMs] of [
  ['', 0],
  [undefined, 500],
] as const) {
  test(`an untyped touch contextmenu cannot schedule (${afterReleaseMs}ms after release)`, async () => {
    vi.useFakeTimers();
    const stopGuard = guardTouchClicks();
    const draft = composerSchema.node('doc', null, [
      composerSchema.node('paragraph', null, [composerSchema.text('later')]),
    ]);
    writeDraft('!room:example.org', { doc: draft.toJSON(), staged: [], nextStagedId: 0 });
    const instance = setup({ roomId: '!room:example.org', onSchedule: async () => {} });

    try {
      await tick();
      const button = sendButton();
      await fireEvent.pointerDown(button, { pointerType: 'touch', isPrimary: true });
      await vi.advanceTimersByTimeAsync(100);
      await fireEvent.pointerUp(button, { pointerType: 'touch', isPrimary: true });
      await vi.advanceTimersByTimeAsync(afterReleaseMs);

      const init = { bubbles: true, cancelable: true };
      const menu =
        pointerType === undefined
          ? new MouseEvent('contextmenu', init)
          : new PointerEvent('contextmenu', { ...init, pointerType });
      button.dispatchEvent(menu);
      await tick();

      expect(menu.defaultPrevented).toBe(true);
      expect(document.body.textContent).not.toContain('Schedule this message');
      await vi.advanceTimersByTimeAsync(SCHEDULE_PRESS_MS);
      expect(document.body.textContent).not.toContain('Schedule this message');
    } finally {
      instance.unmount();
      stopGuard();
      vi.useRealTimers();
    }
  });
}

test.each([false, true])(
  'a send right-click schedules (previous touch: %s)',
  async (previousTouch) => {
    const send = vi.fn(async () => {});
    const draft = composerSchema.node('doc', null, [
      composerSchema.node('paragraph', null, [composerSchema.text('later')]),
    ]);
    writeDraft('!room:example.org', { doc: draft.toJSON(), staged: [], nextStagedId: 0 });
    setup({
      roomId: '!room:example.org',
      onSend: send,
      onSchedule: async () => {},
    });
    await tick();

    const button = document.querySelector('.composer-send');
    if (!(button instanceof HTMLButtonElement)) throw new Error('send button not found');
    if (previousTouch) {
      await fireEvent.pointerDown(button, { pointerType: 'touch', isPrimary: true });
      await fireEvent.pointerUp(button, { pointerType: 'touch', isPrimary: true });
      await fireEvent.pointerDown(button, { pointerType: 'mouse', button: 2, isPrimary: true });
    }
    expect(await fireEvent.contextMenu(button)).toBe(false);
    expect(document.body).toHaveTextContent('Schedule this message');
    expect(send).not.toHaveBeenCalled();
  }
);

test.each(['ContextMenu', 'F10'])('the %s key opens scheduling after a touch', async (key) => {
  const draft = composerSchema.node('doc', null, [
    composerSchema.node('paragraph', null, [composerSchema.text('later')]),
  ]);
  writeDraft('!room:example.org', { doc: draft.toJSON(), staged: [], nextStagedId: 0 });
  setup({ roomId: '!room:example.org', onSchedule: async () => {} });
  await tick();

  const button = sendButton();
  await fireEvent.pointerDown(button, { pointerType: 'touch', isPrimary: true });
  await fireEvent.pointerUp(button, { pointerType: 'touch', isPrimary: true });
  await fireEvent.keyDown(button, { key, shiftKey: key === 'F10' });
  await fireEvent.contextMenu(button);

  expect(document.body).toHaveTextContent('Schedule this message');
});

function sendButton(): HTMLButtonElement {
  const button = document.querySelector('.composer-send');
  if (!(button instanceof HTMLButtonElement)) throw new Error('send button not found');
  return button;
}

for (const encrypted of [true, null]) {
  test(`an attachment is not scheduled, or uploaded, when the room is encrypted (${String(encrypted)})`, async () => {
    scheduleAttachment.mockClear();
    const schedule = vi.fn(async () => {});
    setup({ roomId: '!room:example.org', onSchedule: schedule, encrypted });
    await pick(new File(['image'], 'later.png', { type: 'image/png' }));

    await fireEvent.contextMenu(sendButton());

    expect(screen.getByRole('button', { name: 'In an hour' })).toBeDisabled();
    const scheduleForm = screen.getByRole('button', { name: 'Schedule' }).closest('form');
    if (!scheduleForm) throw new Error('schedule form not found');
    await fireEvent.submit(scheduleForm);
    await tick();

    expect(scheduleAttachment).not.toHaveBeenCalled();
    expect(schedule).not.toHaveBeenCalled();
    expect(stagedNames()).toEqual(['later.png']);
    expect(document.body).toHaveTextContent(
      'Attachments cannot be scheduled in an encrypted room yet.'
    );
  });
}

test('an attachment is scheduled in an unencrypted room', async () => {
  scheduleAttachment.mockClear();
  setup({ roomId: '!room:example.org', onSchedule: async () => {}, encrypted: false });
  await pick(new File(['image'], 'later.png', { type: 'image/png' }));

  await fireEvent.contextMenu(sendButton());
  await press(screen.getByRole('button', { name: 'In an hour' }));
  await tick();

  expect(scheduleAttachment).toHaveBeenCalledOnce();
  expect(stagedNames()).toEqual([]);
});

test('an edited scheduled message loads its text and saves through its own time', async () => {
  const send = vi.fn(async () => {});
  const schedule = vi.fn(async () => {});
  const dueTs = new Date('2099-09-20T14:30:00').getTime();
  setup({
    roomId: '!room:example.org',
    onSend: send,
    onSchedule: schedule,
    context: {
      kind: 'schedule',
      eventId: 'delay',
      body: 'see you tomorow',
      scheduled: { source: 'server', dueTs },
    },
  });
  await tick();

  expect(editorText()).toBe('see you tomorow');

  submit();
  await tick();

  expect(send).not.toHaveBeenCalled();
  const segment = (part: string) =>
    document.querySelector(`.schedule [data-segment="${part}"]`)?.textContent;
  expect([segment('hour'), segment('minute'), segment('dayPeriod')]).toEqual(['02', '30', 'PM']);

  const scheduleForm = document.querySelector('.schedule')?.closest('form');
  if (!scheduleForm) throw new Error('schedule form not found');
  await fireEvent.submit(scheduleForm);

  expect(schedule).toHaveBeenCalledWith('!room:example.org', 'see you tomorow', null, dueTs);
});

test('a press beside the text focuses the editor, and one on a button does not', async () => {
  setup({ roomId: '!room:example.org' });
  await tick();

  const row = document.querySelector('form');
  const editable = document.querySelector('[role="combobox"]');
  const button = document.querySelector('form button');
  if (!row || !button) throw new Error('composer row not found');
  void fireEvent.mouseDown(row);

  expect(editable).toHaveFocus();

  (document.activeElement as HTMLElement | null)?.blur();
  void fireEvent.mouseDown(button);

  expect(editable).not.toHaveFocus();
});

test('the format button follows the configured button order', async () => {
  setPreference('composerButtonOrder', ['format', 'emoticon', 'gif', 'sticker', 'persona']);
  setup({ roomId: '!room:example.org' });
  await tick();

  const after = document.querySelector('.composer-after');
  const first = after?.firstElementChild;
  expect(
    Boolean(
      first?.classList.contains('composer-format') || first?.querySelector('.composer-format')
    )
  ).toBe(true);
});

function pressInEditor(init: KeyboardEventInit): void {
  const editor = document.querySelector('[role="combobox"]');
  if (!editor) throw new Error('editor not found');
  void fireEvent.keyDown(editor, init);
}

test('the expand button makes the editor taller and keeps focus in it', async () => {
  setup({ roomId: '!room:example.org' });
  await tick();
  const toggle = screen.getByRole('button', { name: 'Expand composer' });

  await press(toggle);

  expect(toggle).toHaveAttribute('aria-pressed', 'true');
  expect(document.querySelector('.editor')).toHaveClass('expanded');
  expect(document.querySelector('[contenteditable="true"]')).toHaveFocus();
});

test('the insert menu offers scheduling once there is something to send', async () => {
  writeDraft('!room:example.org', {
    doc: textDoc('later').toJSON(),
    staged: [],
    nextStagedId: 0,
  });
  setup({ roomId: '!room:example.org', onSchedule: vi.fn(async () => {}) });
  await tick();

  await press(screen.getByRole('button', { name: 'Insert' }));
  await press(await screen.findByRole('menuitem', { name: 'Schedule message' }));

  expect(await screen.findByText('Schedule this message')).toBeInTheDocument();
});

test('the placeholder names the room', async () => {
  setup({ roomId: '!room:example.org', roomName: 'General' });
  await tick();

  expect(document.querySelector('.editor')).toHaveAttribute('data-placeholder', 'Message General…');
});

test('a reply names its target in the placeholder and announces itself', async () => {
  setup({
    roomId: '!room:example.org',
    roomName: 'General',
    context: { kind: 'reply', eventId: '$one:example.org', sender: 'Alice', body: 'Hello' },
  });
  await tick();

  expect(document.querySelector('.editor')).toHaveAttribute('data-placeholder', 'Reply to Alice…');
  expect(document.querySelector('[aria-live="polite"]')).toHaveTextContent('Replying to Alice');
});

test('Escape cancels a reply context', async () => {
  const cancel = vi.fn();
  setup({
    roomId: '!room:example.org',
    context: { kind: 'reply', eventId: '$one:example.org', sender: 'Alice', body: 'Hello' },
    onCancelContext: cancel,
  });
  await tick();

  pressInEditor({ key: 'Escape' });

  expect(cancel).toHaveBeenCalledOnce();
});

test('Ctrl+Up and Ctrl+Down step the reply unless an edit is in flight', async () => {
  const step = vi.fn();
  let setContext: ((next: ComposerContext | null) => void) | undefined;
  setup({
    roomId: '!room:example.org',
    onReplyStep: step,
    registerContext: (set) => {
      setContext = set;
    },
  });
  await tick();

  pressInEditor({ key: 'ArrowUp', ctrlKey: true });
  pressInEditor({ key: 'ArrowDown', ctrlKey: true });
  expect(step.mock.calls).toEqual([['older'], ['newer']]);

  setContext?.({ kind: 'edit', eventId: '$one:example.org', body: 'never mind' });
  await tick();
  pressInEditor({ key: 'ArrowUp', ctrlKey: true });
  expect(step).toHaveBeenCalledTimes(2);
});

test('Up in an untouched edit moves to the previous message, a changed one stays', async () => {
  const editLast = vi.fn();
  let setContext: ((next: ComposerContext | null) => void) | undefined;
  setup({
    roomId: '!room:example.org',
    onEditLast: editLast,
    registerContext: (set) => {
      setContext = set;
    },
  });
  await tick();

  setContext?.({ kind: 'edit', eventId: '$two:example.org', body: 'second' });
  await tick();
  pressInEditor({ key: 'ArrowUp' });
  expect(editLast).toHaveBeenCalledWith('$two:example.org');

  editLast.mockClear();
  const editable = document.querySelector<HTMLElement>('[role="combobox"]');
  if (editable) editable.textContent = 'second changed';
  await tick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  pressInEditor({ key: 'ArrowUp' });
  expect(editLast).not.toHaveBeenCalled();
});

test('Down in an untouched edit moves to the next message, a changed one stays', async () => {
  const editNext = vi.fn();
  let setContext: ((next: ComposerContext | null) => void) | undefined;
  setup({
    roomId: '!room:example.org',
    onEditNext: editNext,
    registerContext: (set) => {
      setContext = set;
    },
  });
  await tick();

  setContext?.({ kind: 'edit', eventId: '$one:example.org', body: 'first' });
  await tick();
  pressInEditor({ key: 'ArrowDown' });
  expect(editNext).toHaveBeenCalledWith('$one:example.org');

  editNext.mockClear();
  const editable = document.querySelector<HTMLElement>('[role="combobox"]');
  if (editable) editable.textContent = 'first changed';
  await tick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  pressInEditor({ key: 'ArrowDown' });
  expect(editNext).not.toHaveBeenCalled();
});

test('switching accounts in the same room restores only that account draft', async () => {
  const session = $state({ account_id: 'a' });
  const client = Object.assign(core(), { session }) as unknown as CoreClient;
  const doc = composerSchema.node('doc', null, [
    composerSchema.node('paragraph', null, [composerSchema.text('A private draft')]),
  ]);
  writeDraft('!room:example.org', { doc: doc.toJSON(), staged: [], nextStagedId: 0 }, 'a');
  render(Harness, {
    props: {
      core: client,
      composer: {
        roomId: '!room:example.org',
        onSend: async () => {},
        onSendAttachment: async () => {},
        onTyping: async () => {},
      },
    },
  });
  await tick();
  expect(editorText()).toBe('A private draft');
  session.account_id = 'b';
  await tick();
  expect(editorText()).toBe('');
  expect(readDraft('!room:example.org', 'b')).toBeUndefined();
  session.account_id = 'a';
  await tick();
  expect(editorText()).toBe('A private draft');
});

function draftText(text: string): void {
  const doc = composerSchema.node('doc', null, [
    composerSchema.nodes.paragraph.create(null, [composerSchema.text(text)]),
  ]);
  writeDraft('!room:example.org', { doc: doc.toJSON(), staged: [], nextStagedId: 0 });
}

test('clearing an attachment caption sends an edit without asking to delete', async () => {
  const onSend = vi.fn(async () => {});
  const onDeleteEdited = vi.fn();
  setup({
    roomId: '!room:example.org',
    context: { kind: 'edit', eventId: '$image', body: '', mediaCaption: true },
    onSend,
    onDeleteEdited,
  });
  await tick();
  submit();
  await vi.waitFor(() => {
    expect(onSend).toHaveBeenCalledWith('!room:example.org', '', null, {
      userIds: [],
      room: false,
    });
  });
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(onDeleteEdited).not.toHaveBeenCalled();
});

test.each(['rich text', 'plain text'])(
  'selecting a quick reaction clears the %s composer',
  async (mode) => {
    setPreference('richTextComposer', mode === 'rich text');
    const onQuickReact = vi.fn(async () => {});
    const onSend = vi.fn(async () => {});
    const onTyping = vi.fn(async () => {});
    draftText('+:joy');
    setup({ roomId: '!room:example.org', onQuickReact, onSend, onTyping });

    await screen.findByRole('option', { name: ':joy:' });
    pressInEditor({ key: 'Enter' });
    await vi.waitFor(() => {
      expect(onQuickReact).toHaveBeenCalledWith('!room:example.org', '😂', null);
    });
    expect(onSend).not.toHaveBeenCalled();
    expect(editorText()).toBe('');
    expect(onTyping).toHaveBeenLastCalledWith('!room:example.org', false);
  }
);

test('clicking a custom quick reaction sends its media URL and source pack', async () => {
  const onQuickReact = vi.fn(async () => {});
  const sourcePack = {
    room_id: '!room:example.org',
    state_key: '',
    shortcode: 'wave',
    via: ['example.org'],
  };
  const client = core();
  Object.assign(client.commands, {
    imagePackListing: () =>
      Promise.resolve({
        packs: [{ ...packs[0], images: [{ ...packs[0].images[0], source_pack: sourcePack }] }],
        complete: true,
      }),
  });
  draftText('+:wa');
  setup({ roomId: '!room:example.org', onQuickReact }, client);

  await vi.waitFor(() => {
    expect(document.querySelector('[role="option"] .emote')).not.toBeNull();
  });
  await press(document.querySelector('[role="option"]:has(.emote)'));
  expect(onQuickReact).toHaveBeenCalledWith(
    '!room:example.org',
    'mxc://example.org/wave',
    sourcePack
  );
  expect(editorText()).toBe('');
});

test('Tab selects an emoji from a bare quick reaction prefix', async () => {
  const onQuickReact = vi.fn(async () => {});
  draftText('+:');
  setup({ roomId: '!room:example.org', onQuickReact });
  await screen.findAllByRole('option');
  pressInEditor({ key: 'Tab' });
  await vi.waitFor(() => {
    expect(onQuickReact).toHaveBeenCalledTimes(1);
  });
  expect(editorText()).toBe('');
});

test.each([
  { name: 'reaction permissions', canReact: false, readOnly: false },
  { name: 'a read-only room', canReact: true, readOnly: true },
])('quick reactions are disabled by $name', async ({ canReact, readOnly }) => {
  const onQuickReact = vi.fn(async () => {});
  draftText('+:joy');
  setup({ roomId: '!room:example.org', onQuickReact, canReact, readOnly });
  await tick();
  expect(screen.queryByRole('listbox')).toBeNull();
  expect(onQuickReact).not.toHaveBeenCalled();
  if (!readOnly) expect(editorText()).toBe('+:joy');
  else expect(readDraft('!room:example.org')).toBeDefined();
});

test('a failed quick reaction restores the draft', async () => {
  const onQuickReact = vi.fn(() => Promise.reject(new Error('offline')));
  draftText('+:joy');
  setup({ roomId: '!room:example.org', onQuickReact });
  await press(await screen.findByRole('option', { name: ':joy:' }));
  await vi.waitFor(() => {
    expect(editorText()).toBe('+:joy');
  });
});

test('a complete bot command typed in the composer is sent as a structured command', async () => {
  const onSend = vi.fn(async () => {});
  const onSendBotCommand = vi.fn(async () => {});
  draftText('/warn @spam:example.org 7');
  setup({ roomId: '!room:example.org', onSend, onSendBotCommand });
  await tick();

  submit();

  await vi.waitFor(() => {
    expect(onSendBotCommand).toHaveBeenCalledWith(
      '!room:example.org',
      '@bot:example.org',
      '/warn @spam:example.org 7',
      { command: 'warn', arguments: { user: '@spam:example.org', days: 7 } }
    );
  });
  expect(onSend).not.toHaveBeenCalled();
  expect(editorText()).toBe('');
});

test('choosing a bot command suggestion opens its argument form', async () => {
  draftText('/wa');
  setup({ roomId: '!room:example.org', onSendBotCommand: async () => {} });

  await press(await screen.findByRole('option', { name: /\/warn/ }));

  expect(await screen.findByRole('form', { name: 'Arguments for /warn' })).toBeTruthy();
  expect(screen.getByLabelText('user')).toBeTruthy();
  expect(screen.getByLabelText('days')).toBeTruthy();
});

test.each(['command', 'argument'])('formatting a bot %s keeps its invocation', async (part) => {
  const onSendBotCommand = vi.fn(async () => {});
  const draft = composerSchema.node('doc', null, [
    composerSchema.node('paragraph', null, [
      composerSchema.text(
        '/warn',
        part === 'command' ? [composerSchema.marks.strong.create()] : []
      ),
      composerSchema.text(' @spam:example.org '),
      composerSchema.text('7', part === 'argument' ? [composerSchema.marks.code.create()] : []),
    ]),
  ]);
  writeDraft('!room:example.org', { doc: draft.toJSON(), staged: [], nextStagedId: 0 });
  setup({ roomId: '!room:example.org', onSendBotCommand });
  await tick();

  submit();

  await vi.waitFor(() => {
    expect(onSendBotCommand).toHaveBeenCalledWith(
      '!room:example.org',
      '@bot:example.org',
      '/warn @spam:example.org 7',
      { command: 'warn', arguments: { user: '@spam:example.org', days: 7 } }
    );
  });
});

test('a failed bot command restores its code block', async () => {
  const draft = composerSchema.node('doc', null, [
    composerSchema.node('paragraph', null, composerSchema.text('/register')),
    composerSchema.node('code_block', { language: 'yaml' }, composerSchema.text('id: bridge')),
  ]);
  writeDraft('!room:example.org', { doc: draft.toJSON(), staged: [], nextStagedId: 0 });
  setup({
    roomId: '!room:example.org',
    onSendBotCommand: () => Promise.reject(new Error('offline')),
  });
  await tick();

  submit();

  await vi.waitFor(() => {
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });
  expect(document.querySelector('[role="combobox"] pre code')?.textContent).toBe('id: bridge');
  expect(editorText()).toBe('/registerid: bridge');
});

test.each(['/register payload', '/warn @spam:example.org 7'])(
  'a failed %s keeps text entered while sending',
  async (command) => {
    let rejectSend: ((error: Error) => void) | undefined;
    const onSendBotCommand = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectSend = reject;
        })
    );
    draftText(command);
    setup({ roomId: '!room:example.org', onSendBotCommand });
    await tick();

    submit();
    await vi.waitFor(() => {
      expect(onSendBotCommand).toHaveBeenCalledOnce();
    });
    const editable = screen.getByRole('combobox');
    editable.focus();
    await user.paste('next message');
    expect(editorText()).toBe('next message');
    rejectSend?.(new Error('offline'));

    await vi.waitFor(() => {
      expect(screen.getByRole('alert')).toBeInTheDocument();
    });
    expect(editorText()).toBe('next message');
  }
);

test('a failed bot command does not restore into another room', async () => {
  let rejectSend: ((error: Error) => void) | undefined;
  let setRoom: ((roomId: string) => void) | undefined;
  const onSendBotCommand = vi.fn(
    () =>
      new Promise<void>((_resolve, reject) => {
        rejectSend = reject;
      })
  );
  draftText('/register payload');
  setup({
    roomId: '!room:example.org',
    onSendBotCommand,
    registerRoom: (set) => {
      setRoom = set;
    },
  });
  await tick();

  submit();
  await vi.waitFor(() => {
    expect(onSendBotCommand).toHaveBeenCalledOnce();
  });
  setRoom?.('!other:example.org');
  await tick();
  rejectSend?.(new Error('offline'));

  await vi.waitFor(() => {
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });
  expect(editorText()).toBe('');
});

test('a bot command lookup does not clear a newer draft', async () => {
  let resolveCommands: ((commands: BotCommandDescriptionView[]) => void) | undefined;
  const client = core();
  const lookup = vi.fn(
    () =>
      new Promise<BotCommandDescriptionView[]>((resolve) => {
        resolveCommands = resolve;
      })
  );
  Object.assign(client.commands, { botCommands: lookup });
  const onSendBotCommand = vi.fn(async () => {});
  draftText('/register payload');
  setup({ roomId: '!room:example.org', onSendBotCommand }, client);
  await tick();

  submit();
  await vi.waitFor(() => {
    expect(lookup).toHaveBeenCalledOnce();
  });
  screen.getByRole('combobox').focus();
  await user.paste(' updated');
  const updated = editorText();
  expect(updated).toContain('updated');
  resolveCommands?.(botCommands);
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(editorText()).toBe(updated);
  expect(onSendBotCommand).not.toHaveBeenCalled();
});

test('a queued bot command keeps its room', async () => {
  let resolveSend: (() => void) | undefined;
  let setRoom: ((roomId: string) => void) | undefined;
  const onSendBotCommand = vi.fn(async () => {});
  onSendBotCommand.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        resolveSend = resolve;
      })
  );
  draftText('/register first');
  setup({
    roomId: '!room:example.org',
    onSendBotCommand,
    registerRoom: (set) => {
      setRoom = set;
    },
  });
  await tick();

  submit();
  await vi.waitFor(() => {
    expect(onSendBotCommand).toHaveBeenCalledOnce();
  });
  screen.getByRole('combobox').focus();
  await user.paste('/register second');
  submit();
  await vi.waitFor(() => {
    expect(editorText()).toBe('');
  });
  setRoom?.('!other:example.org');
  await tick();
  resolveSend?.();

  await vi.waitFor(() => {
    expect(onSendBotCommand).toHaveBeenNthCalledWith(
      2,
      '!room:example.org',
      '@bot:example.org',
      '/register second',
      { command: 'register', arguments: {} }
    );
  });
});

test('a bot command fences code containing backticks', async () => {
  const onSendBotCommand = vi.fn(async () => {});
  const draft = composerSchema.node('doc', null, [
    composerSchema.node('paragraph', null, composerSchema.text('/register')),
    composerSchema.node('code_block', { language: '' }, composerSchema.text('a\n```\nb')),
  ]);
  writeDraft('!room:example.org', { doc: draft.toJSON(), staged: [], nextStagedId: 0 });
  setup({ roomId: '!room:example.org', onSendBotCommand });
  await tick();

  submit();

  await vi.waitFor(() => {
    expect(onSendBotCommand).toHaveBeenCalledWith(
      '!room:example.org',
      '@bot:example.org',
      '/register\n\n````\na\n```\nb\n````',
      { command: 'register', arguments: {} }
    );
  });
});

test('a bot command change clears stale suggestions', async () => {
  const listeners: Array<(event: { type: string; room_id?: string }) => void> = [];
  const client = Object.assign(core(), {
    subscribeEvents: (listener: (event: { type: string; room_id?: string }) => void) => {
      listeners.push(listener);
      return () => {};
    },
  });
  draftText('/wa');
  render(Harness, {
    props: {
      core: client,
      composer: {
        roomId: '!room:example.org',
        onSend: async () => {},
        onSendAttachment: async () => {},
        onTyping: async () => {},
        onSendBotCommand: async () => {},
      },
    },
  });

  expect(await screen.findByRole('option', { name: /\/warn/ })).toBeTruthy();
  for (const listener of listeners)
    listener({ type: 'bot_commands_changed', room_id: '!room:example.org' });

  await vi.waitFor(() => {
    expect(screen.queryByRole('option', { name: /\/warn/ })).toBeNull();
  });
});

test('a pack change refreshes open emote suggestions', async () => {
  const listeners: Array<(event: { type: string; room_id?: string }) => void> = [];
  let listed = packs;
  const client = core();
  Object.assign(client, {
    subscribeEvents: (listener: (event: { type: string; room_id?: string }) => void) => {
      listeners.push(listener);
      return () => {};
    },
  });
  Object.assign(client.commands, {
    imagePackListing: () => Promise.resolve({ packs: listed, complete: true }),
  });
  draftText(':wa');
  render(Harness, {
    props: {
      core: client,
      composer: {
        roomId: '!room:example.org',
        onSend: async () => {},
        onSendAttachment: async () => {},
        onTyping: async () => {},
      },
    },
  });

  expect(await screen.findByRole('option', { name: /:wave:/ })).toBeTruthy();
  listed = [
    {
      ...packs[0],
      images: [...packs[0].images, { ...packs[0].images[0], shortcode: 'wave2' }],
    },
  ];
  invalidatePacks(client.commands);
  for (const listener of listeners)
    listener({ type: 'image_packs_changed', room_id: '!space:example.org' });

  expect(await screen.findByRole('option', { name: /:wave2:/ })).toBeTruthy();
});

test.each([
  { command: '/register', richText: true, language: 'yaml' },
  { command: '/register', richText: false, language: 'yaml' },
  { command: '!admin appservices register', richText: true, language: '' },
  { command: '!admin appservices register', richText: false, language: '' },
])(
  '$command preserves code fences with rich text $richText',
  async ({ command, richText, language }) => {
    setPreference('richTextComposer', richText);
    const onSendBotCommand = vi.fn(async () => {});
    const body = `${command}\n\n\`\`\`${language}\nid: bridge\n\`\`\``;
    const draft = richText
      ? composerSchema.node('doc', null, [
          composerSchema.node('paragraph', null, composerSchema.text(command)),
          composerSchema.node('code_block', { language }, composerSchema.text('id: bridge')),
        ])
      : textDoc(body);
    writeDraft('!room:example.org', { doc: draft.toJSON(), staged: [], nextStagedId: 0 });
    const client = core();
    const admin = command.startsWith('!admin');
    if (admin) {
      Object.defineProperty(client, 'session', { value: { user_id: '@me:example.org' } });
    }
    setup(
      { roomId: '!room:example.org', onSendBotCommand },
      client,
      admin
        ? [{ room_id: '!room:example.org', canonical_alias: '#admins:example.org' } as RoomSummary]
        : []
    );
    await tick();

    submit();

    await vi.waitFor(() => {
      expect(onSendBotCommand).toHaveBeenCalledWith(
        '!room:example.org',
        admin ? '@conduit:example.org' : '@bot:example.org',
        body,
        { command: admin ? 'appservices register' : 'register', arguments: {} }
      );
    });
  }
);

test('a zero-parameter bot command preserves raw trailing input', async () => {
  const onSendBotCommand = vi.fn(async () => {});
  draftText('/register ```yaml\nid: bridge\n```');
  setup({ roomId: '!room:example.org', onSendBotCommand });
  await tick();

  submit();

  await vi.waitFor(() => {
    expect(onSendBotCommand).toHaveBeenCalledWith(
      '!room:example.org',
      '@bot:example.org',
      '/register ```yaml\nid: bridge\n```',
      { command: 'register', arguments: {} }
    );
  });
});

test('an incomplete bot command opens its form, which sends once it is filled in', async () => {
  const onSend = vi.fn(async () => {});
  const onSendBotCommand = vi.fn(async () => {});
  draftText('/warn @spam:example.org');
  setup({ roomId: '!room:example.org', onSend, onSendBotCommand });
  await tick();

  submit();

  const form = await screen.findByRole('form', { name: 'Arguments for /warn' });
  expect(screen.getByLabelText('user')).toHaveProperty('value', '@spam:example.org');
  await user.click(screen.getByRole('button', { name: 'Send command' }));
  expect(await screen.findByText('Required')).toBeTruthy();
  expect(onSendBotCommand).not.toHaveBeenCalled();

  await user.type(screen.getByLabelText('days'), '3');
  await user.click(screen.getByRole('button', { name: 'Send command' }));

  await vi.waitFor(() => {
    expect(onSendBotCommand).toHaveBeenCalledWith(
      '!room:example.org',
      '@bot:example.org',
      '/warn @spam:example.org 3',
      { command: 'warn', arguments: { user: '@spam:example.org', days: 3 } }
    );
  });
  await vi.waitFor(() => {
    expect(form.isConnected).toBe(false);
  });
  expect(onSend).not.toHaveBeenCalled();
});

test('without bot command support an unknown command still goes to the slash handler', async () => {
  const onSend = vi.fn(async () => {});
  draftText('/warn @spam:example.org 7');
  setup({ roomId: '!room:example.org', onSend });
  await tick();

  submit();

  await vi.waitFor(() => {
    expect(onSend).toHaveBeenCalledWith('!room:example.org', '/warn @spam:example.org 7', null, {
      userIds: [],
      room: false,
    });
  });
});
