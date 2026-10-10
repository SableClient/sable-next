import { afterEach, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';

import type { CoreClient } from '#lib/core/client.svelte.js';
import { setPreference } from '#lib/settings/preferences.svelte.js';

import en from '../../../locales/en.json' with { type: 'json' };
import Harness from './RoomComposerHarness.test.svelte';

const NEWLINE = '{Shift>}{Enter}{/Shift}';

function literal(text: string): string {
  return text.replaceAll('{', '{{').replaceAll('[', '[[');
}

afterEach(async () => {
  await page.viewport(414, 800);
  setPreference('composerForm', 'tall');
  setPreference('formattingToolbar', false);
  setPreference('composerGifButton', true);
  setPreference('composerStickerButton', true);
  setPreference('richTextComposer', true);
  setPreference('enterForNewline', 'adaptive');
});

function client(): CoreClient {
  return {
    subscribeEvents: () => () => {},
    commands: {
      mediaConfig: () => Promise.resolve({ upload_size: 100 * 1024 * 1024 }),
      botCommands: () => Promise.resolve([]),
      personas: () => Promise.resolve({ personas: [], selections: [] }),
      roomMembers: () => Promise.resolve([]),
      imagePackListing: () => Promise.resolve({ packs: [], complete: true }),
      fetchMedia: () => Promise.resolve(new Uint8Array()),
    },
  } as unknown as CoreClient;
}

let rooms = 0;

async function mount(richText: boolean, preferences: Partial<Record<string, unknown>> = {}) {
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

test('rich text formats text between markers', async () => {
  const { composer, sent, firstParagraph } = await mount(true);

  for (const [delimiter, html] of [
    ['**', '<strong>test</strong>'],
    ['*', '<em>test</em>'],
    ['__', '<strong>test</strong>'],
    ['_', '<em>test</em>'],
    ['~~', '<del>test</del>'],
    ['||', '<span data-mx-spoiler="">test</span>'],
    ['`', '<code>test</code>'],
    ['``', '<code>test</code>'],
    ['***', '<strong><em>test</em></strong>'],
  ]) {
    await userEvent.click(composer);
    await userEvent.keyboard(literal(delimiter + delimiter));
    await userEvent.keyboard('{ArrowLeft}'.repeat(delimiter.length));
    await userEvent.keyboard('test');
    await expect.poll(() => firstParagraph().innerHTML).toBe(html);
    const before = sent.length;
    await userEvent.keyboard('{Enter}');
    await expect.poll(() => sent.length).toBe(before + 1);
    expect(sent.at(-1)?.formatted).toBe(html);
    await expect.poll(() => firstParagraph().textContent).toBe('');
  }
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
    ['**a `b` c** next', '<strong>a </strong><code>b</code><strong> c</strong> next'],
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
  await userEvent.keyboard('{Control>}a{/Control}');
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

for (const width of [320, 520]) {
  test(`formatting scrolls in a narrow ${String(width)}px composer`, async () => {
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
    if (width < 400) {
      expect(strip.y + strip.height).toBeLessThanOrEqual(actions.y);
    } else {
      expect(strip.x).toBeGreaterThanOrEqual(plus.x + plus.width);
      expect(strip.x + strip.width).toBeLessThanOrEqual(actions.x);
      expect(Math.abs(strip.y - actions.y)).toBeLessThanOrEqual(1);
    }
    expect(rail.scrollWidth > rail.clientWidth).toBe(true);
    rail.dispatchEvent(new WheelEvent('wheel', { deltaY: 200, bubbles: true, cancelable: true }));
    expect(rail.scrollLeft).toBeGreaterThan(0);
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
