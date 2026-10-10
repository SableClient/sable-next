import { afterEach, expect, test, vi } from 'vitest';
import { userEvent } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';

import type { CoreClient } from '#lib/core/client.svelte.js';
import { setPreference } from '#lib/settings/preferences.svelte.js';

import en from '../../../locales/en.json' with { type: 'json' };
import Harness from './RoomComposerHarness.test.svelte';

const NEWLINE = '{Shift>}{Enter}{/Shift}';

function literal(text: string): string {
  return text.replaceAll('{', '{{').replaceAll('[', '[[');
}

afterEach(() => {
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

async function mount(richText: boolean) {
  rooms += 1;
  setPreference('richTextComposer', richText);
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
