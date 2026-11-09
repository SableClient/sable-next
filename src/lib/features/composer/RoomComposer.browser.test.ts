import { afterEach, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';

import type { CoreClient } from '#lib/core/client.svelte.js';
import { setPreference } from '#lib/settings/preferences.svelte.js';
import { isMacPlatform } from '#lib/ui/shortcuts/global-shortcuts.js';
import { CoreError } from '#src/transport';

import en from '../../../locales/en.json' with { type: 'json' };
import Harness from './RoomComposerHarness.test.svelte';

const NEWLINE = '{Shift>}{Enter}{/Shift}';

vi.setConfig({ testTimeout: 30_000 });

function literal(text: string): string {
  return text.replaceAll('{', '{{').replaceAll('[', '[[');
}

afterEach(async () => {
  document.documentElement.style.removeProperty('--keyboard-height');
  document.body.removeAttribute('style');
  await page.viewport(414, 800);
  setPreference('composerForm', 'tall');
  setPreference('formattingToolbar', false);
  setPreference('composerGifButton', true);
  setPreference('composerStickerButton', true);
  setPreference('richTextComposer', true);
  setPreference('enterForNewline', 'adaptive');
});

let frequentReactions: string[] = [];

function client(): CoreClient {
  return {
    subscribeEvents: () => () => {},
    commands: {
      roomMembers: () => Promise.resolve([]),
      fetchMedia: () => Promise.resolve(new Uint8Array()),
    },
    rpc: {
      messages: {
        mediaConfig: () => Promise.resolve({ upload_size: 100 * 1024 * 1024 }),
        frequentReactions: () => Promise.resolve(frequentReactions),
        rememberEmoji: () => Promise.resolve(null),
      },
      room_state: { botCommands: () => Promise.resolve([]) },
      personas: { list: () => Promise.resolve({ personas: [], selections: [] }) },
      packs: { list: () => Promise.resolve({ packs: [], complete: true }) },
    },
  } as unknown as CoreClient;
}

let rooms = 0;

async function mount(
  richText: boolean,
  preferences: Partial<Record<string, unknown>> = {},
  extra: Record<string, unknown> = {}
) {
  rooms += 1;
  setPreference('richTextComposer', richText);
  for (const [key, value] of Object.entries(preferences)) {
    setPreference(key as Parameters<typeof setPreference>[0], value as never);
  }
  const sent: { body: string; formatted: string | null }[] = [];
  const screen = await render(Harness, {
    core: client(),
    rooms: [],
    composer: {
      roomId: `!room${String(rooms)}:example.org`,
      onSend: (_roomId: string, body: string, formatted: string | null) => {
        sent.push({ body, formatted });
        return Promise.resolve();
      },
      onSendAttachment: () => Promise.resolve(),
      onTyping: () => Promise.resolve(),
      ...extra,
    },
  });
  const composer = screen.getByRole('combobox', { name: en.timeline.messagePlaceholder });
  const editor = () => {
    const node = document.querySelector<HTMLElement>('.ProseMirror');
    if (!node) throw new Error('the editor is not rendered');
    return node;
  };
  const firstParagraph = () => {
    const node = editor().querySelector('p');
    if (!node) throw new Error('the editor holds no paragraph');
    return node;
  };
  return { screen, composer, sent, editor, firstParagraph };
}

test.each(['search', 'cell'])(
  'shift+enter keeps focus on the recent emote from %s',
  async (from) => {
    await page.viewport(1280, 900);
    frequentReactions = ['🔥', '👍'];
    try {
      const { screen, composer, editor } = await mount(true);
      await userEvent.click(composer);
      const modifier = isMacPlatform() ? 'Meta' : 'Control';
      await userEvent.keyboard(`{${modifier}>}e{/${modifier}}`);
      const search = screen.getByRole('searchbox', { name: en.composer.searchPacks });
      await expect.element(search).toHaveFocus();
      await userEvent.keyboard('{ArrowRight}');
      const selected = () => document.querySelector('[data-selected]')?.getAttribute('aria-label');
      const label = selected();
      expect(label).toBeTruthy();
      const cell = screen.getByRole('gridcell', { name: label ?? '', exact: true }).first();
      if (from === 'cell') cell.element().focus();

      await userEvent.keyboard(NEWLINE);

      await expect.element(from === 'search' ? search : cell).toHaveFocus();
      if (from === 'search') expect(selected()).toBe(label);
      await expect.poll(() => editor().textContent).toContain('👍');
      await userEvent.keyboard(NEWLINE);
      await expect.poll(() => editor().textContent.split('👍').length).toBe(3);
    } finally {
      frequentReactions = [];
    }
  }
);

test.for([
  ['**', '<strong>test</strong>'],
  ['*', '<em>test</em>'],
  ['__', '<strong>test</strong>'],
  ['_', '<em>test</em>'],
  ['~~', '<del>test</del>'],
  ['||', '<span data-mx-spoiler="">test</span>'],
  ['`', '<code>test</code>'],
  ['``', '<code>test</code>'],
  ['***', '<strong><em>test</em></strong>'],
])('rich text formats text between %s markers', async ([delimiter, html]) => {
  const { composer, sent, firstParagraph } = await mount(true);

  await userEvent.click(composer);
  await userEvent.keyboard(literal(delimiter + delimiter));
  await userEvent.keyboard('{ArrowLeft}'.repeat(delimiter.length));
  await userEvent.keyboard('test');
  await expect.poll(() => firstParagraph().innerHTML).toBe(html);
  await userEvent.keyboard('{Enter}');
  await expect.poll(() => sent.length).toBe(1);
  expect(sent[0]?.formatted).toBe(html);
  await expect.poll(() => firstParagraph().textContent).toBe('');
});

test('Markdown mode sends escaped punctuation as literal text', async () => {
  const { composer, sent, editor } = await mount(false);

  for (const [source, formatted] of [
    ['\\*like so*', '<span>*</span>like so<span>*</span>'],
    ['\\`code\\`', '<span>`</span>code<span>`</span>'],
    ['\\$[unixtime 0]', '<span>$</span>[unixtime 0]'],
    ['**bold** and \\*literal*', '<strong>bold</strong> and <span>*</span>literal<span>*</span>'],
  ]) {
    await userEvent.click(composer);
    await userEvent.keyboard(literal(source));
    await expect.poll(() => editor().textContent).toBe(source);
    const before = sent.length;
    await userEvent.keyboard('{Enter}');
    await expect.poll(() => sent.length).toBe(before + 1);
    expect(sent.at(-1)).toEqual({ body: source, formatted });
    await expect.poll(() => editor().textContent).toBe('');
  }
});

test('typed Markdown handles formatting and literal delimiters', async () => {
  for (const [input, html] of [
    ['say ***both*** now', 'say <strong><em>both</em></strong> now'],
    ['__bold__ next', '<strong>bold</strong> next'],
    ['**a*b** next', '<strong>a*b</strong> next'],
    ['\\*literal\\*', '\\*literal\\*'],
    ['---literal', '---literal'],
    ['[label](https://example.org)', '<a href="https://example.org">label</a>'],
    ['``code ` tick`` next', '<code>code ` tick</code> next'],
    ['`code``', '`code``'],
    ['**a `b` c** next', '<strong>a <code>b</code> c</strong> next'],
  ]) {
    const { screen, composer, firstParagraph } = await mount(true);
    await userEvent.click(composer);
    await userEvent.keyboard(literal(input));
    await expect.poll(() => firstParagraph().innerHTML).toBe(html);
    await screen.unmount();
  }
});

test('code fences preserve newlines and indentation', async () => {
  const { composer, editor } = await mount(true);
  const code = () => editor().querySelector('pre code');

  await userEvent.click(composer);
  await userEvent.keyboard('```rust');
  await expect.poll(() => editor().textContent).toBe('```rust');
  await userEvent.keyboard(NEWLINE);
  await expect.poll(() => editor().querySelector('pre')).not.toBeNull();
  await userEvent.keyboard(literal('fn main() {'));
  await userEvent.keyboard(NEWLINE);
  await expect.poll(() => code()?.textContent).toBe('fn main() {\n');
  await userEvent.keyboard(literal('    let x = 1;'));
  await userEvent.keyboard(NEWLINE);
  await expect.poll(() => code()?.textContent).toBe('fn main() {\n    let x = 1;\n');
  await userEvent.keyboard(literal('}'));
  await userEvent.keyboard(NEWLINE);
  await expect.poll(() => code()?.textContent).toBe('fn main() {\n    let x = 1;\n}\n');
  await userEvent.keyboard('```');
  await userEvent.keyboard(NEWLINE);
  await expect.poll(() => code()?.textContent).toBe('fn main() {\n    let x = 1;\n}');
  await userEvent.keyboard('after');

  expect(code()?.textContent).toBe('fn main() {\n    let x = 1;\n}');
  const paragraphs = editor().querySelectorAll('p');
  expect(paragraphs[paragraphs.length - 1]?.textContent).toBe('after');
});

test('leaving a block sends no blank lines or stray breaks', async () => {
  const { screen, composer, sent, editor } = await mount(true);

  for (const [keys, formatted] of [
    [['> quote', NEWLINE, NEWLINE, 'after'], '<blockquote><p>quote</p></blockquote><p>after</p>'],
    [['> quote', NEWLINE], '<blockquote><p>quote</p></blockquote>'],
    [['> quote', NEWLINE, NEWLINE], '<blockquote><p>quote</p></blockquote>'],
    [
      ['- one', NEWLINE, 'two', NEWLINE, NEWLINE, 'after'],
      '<ul><li>one</li><li>two</li></ul><p>after</p>',
    ],
    [['- one', NEWLINE, NEWLINE, NEWLINE], '<ul><li>one</li></ul>'],
  ] as const) {
    await userEvent.click(composer);
    for (const key of keys) await userEvent.keyboard(key);
    const before = sent.length;
    await userEvent.click(screen.getByRole('button', { name: 'Send message' }));
    await expect.poll(() => sent.length).toBe(before + 1);
    expect(sent.at(-1)?.formatted, keys.join(' ⏎ ')).toBe(formatted);
    await expect.poll(() => editor().textContent).toBe('');
  }
});

test('vertical arrows stop on every blank line', async () => {
  const { composer, firstParagraph } = await mount(true);

  await userEvent.click(composer);
  for (const key of [
    '1',
    NEWLINE,
    NEWLINE,
    '2',
    NEWLINE,
    '3',
    NEWLINE,
    '4',
    NEWLINE,
    NEWLINE,
    '5',
  ]) {
    await userEvent.keyboard(key);
  }
  const marked = async () => {
    await userEvent.keyboard('X');
    const text = [...firstParagraph().childNodes]
      .map((node) =>
        node.nodeName === 'BR' && !(node as Element).classList.contains('ProseMirror-trailingBreak')
          ? '|'
          : (node.textContent ?? '')
      )
      .join('');
    await userEvent.keyboard('{Backspace}');
    return text;
  };
  const up: string[] = [];
  for (let step = 0; step < 6; step += 1) {
    await userEvent.keyboard('{ArrowUp}');
    up.push(await marked());
  }
  expect(up[0]).toBe('1||2|3|4|X|5');
  expect(up[4]).toBe('1|X|2|3|4||5');
  await userEvent.keyboard('{ArrowDown}'.repeat(5));
  expect(await marked()).toBe('1||2|3|4|X|5');
});

vi.setConfig({ testTimeout: 30_000 });

function boxOf(selector: string): DOMRect {
  const node = document.querySelector(selector);
  if (!node) throw new Error(`${selector} is not rendered`);
  return node.getBoundingClientRect();
}

test('formatting uses the footer space', async () => {
  await page.viewport(1920, 1080);
  const { screen, composer } = await mount(true);
  await userEvent.click(composer);
  await userEvent.keyboard('draft words');
  await userEvent.keyboard('{ControlOrMeta>}a{/ControlOrMeta}');
  const before = boxOf('.composer');

  await userEvent.click(screen.getByRole('button', { name: 'Formatting', exact: true }));
  const formatting = boxOf('.formatting');
  const controls = boxOf('.composer-after');
  const field = boxOf('.composer-field');
  const after = boxOf('.composer');

  expect(formatting.y).toBeGreaterThanOrEqual(field.y + field.height);
  expect(Math.abs(formatting.y - controls.y)).toBeLessThanOrEqual(1);
  expect(after.height).toBe(before.height);

  await userEvent.click(screen.getByRole('button', { name: 'Bold', exact: true }));
  await expect
    .poll(() => document.querySelector('.ProseMirror strong')?.textContent)
    .toBe('draft words');
  await expect.element(composer).toHaveFocus();

  await userEvent.click(screen.getByRole('button', { name: 'Underline', exact: true }));
  await expect
    .poll(() => document.querySelector('.ProseMirror u')?.textContent)
    .toBe('draft words');
  await expect.element(composer).toHaveFocus();
  const composerBox = boxOf('.composer');
  expect(formatting.x).toBeGreaterThanOrEqual(composerBox.x);
  expect(formatting.x + formatting.width).toBeLessThanOrEqual(composerBox.x + composerBox.width);

  await userEvent.click(screen.getByRole('button', { name: 'Formatting', exact: true }));
  await expect.poll(() => document.querySelector('.formatting')).toBeNull();
});

for (const width of [320, 412, 520, 768]) {
  test(`formatting controls stay visible in a narrow ${String(width)}px composer`, async () => {
    await page.viewport(width, 812);
    const { screen } = await mount(true, {
      composerGifButton: false,
      composerStickerButton: false,
    });
    await userEvent.click(screen.getByRole('button', { name: 'Formatting', exact: true }));
    await expect.poll(() => document.querySelector('.formatting')).not.toBeNull();
    const rail = document.querySelector<HTMLElement>('.formatting');
    if (!rail) throw new Error('the formatting rail is not rendered');
    const strip = rail.getBoundingClientRect();
    const field = boxOf('.composer-field');
    const plus = boxOf('.composer-before');
    const actions = boxOf('.composer-after');
    expect(strip.y).toBeGreaterThanOrEqual(field.y + field.height);
    if (width < 640) {
      expect(strip.y + strip.height).toBeLessThanOrEqual(actions.y);
      expect(strip.height).toBeLessThanOrEqual(3 * actions.height + 4);
    } else {
      expect(strip.x).toBeGreaterThanOrEqual(plus.x + plus.width);
      expect(strip.x + strip.width).toBeLessThanOrEqual(actions.x);
    }
    const composer = boxOf('.composer');
    for (const button of rail.querySelectorAll('button')) {
      await expect.element(button).toBeVisible();
      const box = button.getBoundingClientRect();
      expect(box.left).toBeGreaterThanOrEqual(Math.max(composer.left, 0));
      expect(box.right).toBeLessThanOrEqual(Math.min(composer.right, window.innerWidth));
      expect(box.top).toBeGreaterThanOrEqual(Math.max(composer.top, 0));
      expect(box.bottom).toBeLessThanOrEqual(Math.min(composer.bottom, window.innerHeight));
    }
    const highlight = screen.getByRole('button', { name: 'Highlight colour', exact: true });
    highlight.element().focus();
    await expect.element(highlight).toBeInViewport();
  });
}

async function measure(editable: HTMLElement) {
  await new Promise<void>((resolve) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        resolve();
      });
    });
  });
  const row = editable.closest('.composer-row');
  const before = row?.querySelector('.composer-before');
  const after = row?.querySelector('.composer-after');
  if (!row || !before || !after) throw new Error('Missing composer layout');
  const walker = document.createTreeWalker(editable, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  const lines = new Set<number>();
  while (walker.nextNode()) {
    const node = walker.currentNode;
    range.selectNodeContents(node);
    for (const rect of range.getClientRects()) {
      if (rect.width > 0) lines.add(Math.round(rect.top));
    }
  }
  return {
    lines: lines.size,
    editorBottom: editable.getBoundingClientRect().bottom,
    controlsTop: Math.min(before.getBoundingClientRect().top, after.getBoundingClientRect().top),
  };
}

test('short composer gives text a full row on narrow screens', async () => {
  await page.viewport(320, 800);
  const { composer, editor } = await mount(true, { composerForm: 'short' });
  await userEvent.fill(composer, 'Will this be fixed, and when?');
  const layout = await measure(editor());
  const row = editor().closest('.composer-row');
  if (!row) throw new Error('Missing composer');
  expect(editor().getBoundingClientRect().width).toBeGreaterThan(
    row.getBoundingClientRect().width * 0.8
  );
  expect(layout.controlsTop).toBeGreaterThanOrEqual(layout.editorBottom);
});

test('an empty short composer stays on one row on narrow screens', async () => {
  await page.viewport(360, 800);
  const { editor } = await mount(true, { composerForm: 'short' });
  const layout = await measure(editor());
  expect(layout.controlsTop).toBeLessThan(layout.editorBottom);
});

for (const width of [320, 414, 1280]) {
  test(`long messages do not overlap the expand button at ${String(width)}px`, async () => {
    await page.viewport(width, 800);
    const { composer, editor, screen } = await mount(true, { composerForm: 'tall' });
    await userEvent.fill(composer, 'A long message with wrapping words. '.repeat(40));
    await document.fonts.ready;

    const button = screen.getByRole('button', { name: en.composer.expand }).element();
    const assertClearance = () => {
      const editable = editor();
      const editorBox = editable.getBoundingClientRect();
      const buttonBox = button.getBoundingClientRect();
      const hitStyle = getComputedStyle(button, '::after');
      const hitLeft = buttonBox.left + Number.parseFloat(hitStyle.left);
      expect(editorBox.right).toBeLessThanOrEqual(hitLeft);
      expect(editable.scrollWidth).toBeLessThanOrEqual(editable.clientWidth);

      const range = document.createRange();
      range.selectNodeContents(editable);
      for (const rect of range.getClientRects()) {
        expect(rect.right).toBeLessThanOrEqual(hitLeft);
      }
    };

    assertClearance();
    await userEvent.click(button);
    await expect.poll(() => button.getAttribute('aria-pressed')).toBe('true');
    assertClearance();
    await expect.element(composer).toHaveFocus();
  });
}

for (const [richText, form] of [
  [false, 'tall'],
  [true, 'tall'],
  [true, 'short'],
] as const) {
  test(`composer keeps controls below the text in ${richText ? 'rich' : 'plain'} ${form} mode`, async () => {
    await page.viewport(1900, 900);
    const { composer, editor } = await mount(richText, { composerForm: form });
    await document.fonts.ready;
    const row = document.querySelector<HTMLElement>('.composer-row');
    if (!row) throw new Error('Missing composer');
    row.style.width = '800px';

    const text =
      "yo why'd you close my #617? is there an unpublished solution or did you not like my repro steps? it's a real issue i had to use my phone to sync the theme to the";
    const start = 125;
    await userEvent.click(composer);
    await userEvent.keyboard(literal(text.slice(0, start)));
    let wrapped = false;
    for (const char of text.slice(start)) {
      await userEvent.keyboard(literal(char));
      const layout = await measure(editor());
      expect(layout.controlsTop).toBeGreaterThanOrEqual(layout.editorBottom);
      wrapped ||= layout.lines > 1;
    }
    expect(wrapped).toBe(true);

    for (let index = start; index < text.length; index += 1) {
      await userEvent.keyboard('{Backspace}');
      const layout = await measure(editor());
      expect(layout.controlsTop).toBeGreaterThanOrEqual(layout.editorBottom);
    }
  });
}

async function colourSelection(
  screen: Awaited<ReturnType<typeof mount>>['screen'],
  composer: Awaited<ReturnType<typeof mount>>['composer'],
  editor: () => HTMLElement
) {
  await userEvent.click(screen.getByRole('button', { name: 'Formatting', exact: true }));
  await userEvent.click(composer);
  await userEvent.keyboard('red words');
  await userEvent.keyboard('{ControlOrMeta>}a{/ControlOrMeta}');
  await userEvent.click(screen.getByRole('button', { name: 'Text colour' }));
  await userEvent.click(screen.getByRole('button', { name: 'Red', exact: true }));
  await expect.poll(() => editor().textContent).toBe('$[fg.color=e5484d red words]');
}

test('the text colour picker colours the selection', async () => {
  const { screen, composer, editor } = await mount(false);
  await colourSelection(screen, composer, editor);

  await userEvent.click(screen.getByRole('button', { name: 'Highlight colour' }));
  await userEvent.fill(screen.getByRole('textbox', { name: 'Hex colour' }).element(), '#12a594');
  await userEvent.click(screen.getByRole('button', { name: 'Apply' }));
  await expect
    .poll(() => editor().textContent)
    .toBe('$[fg.color=e5484d $[bg.color=12a594 red words]]');
});

test('the text colour picker opens as a sheet on a phone', async () => {
  await page.viewport(375, 812);
  const { screen, composer, editor } = await mount(false);
  await colourSelection(screen, composer, editor);
});

test('quick reaction autocomplete selects with Enter or Tab', async () => {
  const onQuickReact = vi.fn(() => Promise.resolve());
  const { screen, composer, sent, editor } = await mount(
    true,
    {},
    { onQuickReact, canReact: true }
  );

  for (const key of ['{Enter}', '{Tab}']) {
    await userEvent.click(composer);
    await userEvent.keyboard('+:joy');
    await expect.element(screen.getByRole('option', { name: ':joy:', exact: true })).toBeVisible();
    await userEvent.keyboard(key);
    await expect.poll(() => editor().textContent).toBe('');
    expect(screen.getByRole('listbox').elements()).toHaveLength(0);
  }
  await expect.poll(() => onQuickReact.mock.calls.length).toBe(2);
  expect(sent).toHaveLength(0);
});

test('quick reaction autocomplete selects by pointer', async () => {
  Object.assign(document.body.style, {
    display: 'flex',
    flexDirection: 'column',
    justifyContent: 'flex-end',
    minHeight: '100vh',
  });
  const onQuickReact = vi.fn(() => Promise.resolve());
  const { screen, composer, sent, editor } = await mount(
    true,
    {},
    { onQuickReact, canReact: true }
  );
  await userEvent.click(composer);
  await userEvent.keyboard('+:joy');
  await userEvent.click(screen.getByRole('option', { name: ':joy:', exact: true }));

  await expect.poll(() => editor().textContent).toBe('');
  await expect.poll(() => onQuickReact.mock.calls.length).toBe(1);
  expect(sent).toHaveLength(0);
});

test('the arrow keys move a visible highlight through emote suggestions', async () => {
  const { screen, composer, editor } = await mount(true);
  await userEvent.click(composer);
  await userEvent.keyboard(':sm');
  const options = screen.getByRole('option');
  await expect.poll(() => options.elements().length).toBeGreaterThan(1);

  await userEvent.keyboard('{ArrowDown}');
  const second = options.nth(1);
  await expect.element(second).toHaveAttribute('aria-selected', 'true');
  const node = second.element();
  const row = getComputedStyle(node).backgroundColor;
  const panel = getComputedStyle(node.closest('.autocomplete') ?? node).backgroundColor;
  expect(row).not.toBe(panel);

  const picked = node.querySelector('.unicode-emoji')?.textContent ?? '';
  await userEvent.keyboard('{Enter}');
  await expect.poll(() => editor().textContent).toContain(picked);
});

test('code pasted from an editor keeps its lines and indentation in plain mode', async () => {
  const { composer, editor } = await mount(false);
  await userEvent.click(composer);
  await userEvent.keyboard('```');
  await userEvent.keyboard(NEWLINE);
  const data = new DataTransfer();
  data.setData('text/plain', 'fn main() {\n    let x = 1;\n}');
  data.setData(
    'text/html',
    '<div><div><span>fn main() {</span></div><div><span>    let x = 1;</span></div><div><span>}</span></div></div>'
  );
  composer
    .element()
    .dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true })
    );

  await expect.poll(() => editor().innerText).toBe('```\nfn main() {\n    let x = 1;\n}');
});

test('a failed send keeps the draft and retries from inside the composer', async () => {
  let fail = true;
  const onSend = vi.fn((_roomId: string, _body: string, _formatted: string | null) =>
    fail ? Promise.reject(new CoreError({ code: 'unavailable' })) : Promise.resolve()
  );
  const { screen, composer, editor } = await mount(true, {}, { onSend });

  await userEvent.click(composer);
  await userEvent.keyboard('still here');
  await userEvent.keyboard('{Enter}');

  const alert = screen.getByRole('alert');
  await expect.poll(() => alert.element().textContent).toContain(en.composer.sendUnavailable);
  expect(editor().textContent).toBe('still here');

  fail = false;
  await userEvent.click(alert.getByRole('button', { name: 'Retry' }));

  await expect.poll(() => screen.getByRole('alert').elements()).toHaveLength(0);
  await expect.poll(() => editor().textContent).toBe('');
  expect(onSend).toHaveBeenCalledTimes(2);
});

const SCHEDULE_PRESS_MS = 800;

async function scheduleHarness() {
  const onSchedule = vi.fn(() => Promise.resolve());
  const mounted = await mount(true, {}, { onSchedule });
  const send = () => {
    const node = document.querySelector<HTMLElement>('.composer-send');
    if (!node) throw new Error('the send button is not rendered');
    return node;
  };
  const dialog = () => mounted.screen.getByText('Schedule this message', { exact: true });
  return { ...mounted, onSchedule, send, dialog };
}

test('touch taps and mouse clicks send without scheduling', async () => {
  const { composer, sent, send, dialog, editor } = await scheduleHarness();

  for (let index = 0; index < 3; index += 1) {
    await userEvent.click(composer);
    await userEvent.keyboard(`Message ${String(index)}`);
    await userEvent.click(send());
    await expect.poll(() => editor().textContent).toBe('');
    expect(dialog().elements()).toHaveLength(0);
  }
  expect(sent).toHaveLength(3);
});

test('an untyped touch contextmenu cannot bypass the schedule delay', async () => {
  const { composer, send, dialog, editor } = await scheduleHarness();
  await userEvent.click(composer);
  await userEvent.keyboard('Later');
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  try {
    send().dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch', isPrimary: true })
    );
    await vi.advanceTimersByTimeAsync(100);
    send().dispatchEvent(
      new PointerEvent('pointerup', { bubbles: true, pointerType: 'touch', isPrimary: true })
    );
    await vi.advanceTimersByTimeAsync(500);
    send().dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    send().dispatchEvent(
      new PointerEvent('contextmenu', { bubbles: true, cancelable: true, pointerType: '' })
    );
    await vi.advanceTimersByTimeAsync(SCHEDULE_PRESS_MS);
  } finally {
    vi.useRealTimers();
  }

  expect(dialog().elements()).toHaveLength(0);
  expect(editor().textContent).toBe('Later');
});

test('a touch hold schedules only after the full delay and swallows its click', async () => {
  const { composer, sent, send, dialog } = await scheduleHarness();
  await userEvent.click(composer);
  await userEvent.keyboard('Later');
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  try {
    send().dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch', isPrimary: true })
    );
    await vi.advanceTimersByTimeAsync(SCHEDULE_PRESS_MS - 1);
    expect(dialog().elements()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
  } finally {
    vi.useRealTimers();
  }
  await expect.element(dialog()).toBeVisible();
  send().dispatchEvent(
    new PointerEvent('pointerup', { bubbles: true, pointerType: 'touch', isPrimary: true })
  );
  send().dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  expect(sent).toHaveLength(0);
});
