// @vitest-environment happy-dom

import { afterEach, expect, test, vi } from 'vitest';

import { activeQuery } from '../autocomplete';
import { ComposerEditor } from './composer-editor';
import { composerSchema } from './schema';
import { serializeComposer } from './serialize';

let dispose: (() => void) | undefined;

afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.replaceChildren();
});

function open(): ComposerEditor {
  const host = document.createElement('div');
  document.body.append(host);
  const editor = new ComposerEditor({
    media: { cached: () => undefined, load: () => Promise.resolve('blob:x') },
    label: () => 'Send a message',
    listboxId: 'suggestions',
    activeOptionId: () => null,
    editable: () => true,
    onSubmit: () => {},
    onChange: () => {},
    onQuery: () => {},
    onNavigate: () => false,
    onFiles: () => {},
  });
  dispose = editor.mount(host);
  return editor;
}

function query(editor: ComposerEditor): { start: number; end: number; sigil: string } {
  const doc = editor.doc();
  if (!doc) throw new Error('no doc');
  const text = doc.textBetween(1, doc.content.size - 1, ' ', ' ');
  const found = activeQuery(text, text.length);
  if (!found) throw new Error(`no query in ${text}`);
  return { ...found, start: found.start + 1, end: text.length + 1 };
}

test('committing an emote keeps the text that came before it', () => {
  const editor = open();
  editor.setText('hey :v');

  const found = query(editor);
  editor.replaceQuery(
    { sigil: ':', query: 'v', start: found.start, end: found.end },
    composerSchema.nodes.emoticon.create({ url: 'mxc://example.org/vv', shortcode: 'vv' })
  );

  const doc = editor.doc();
  if (!doc) throw new Error('no doc');
  expect(serializeComposer(doc).body).toBe('hey :vv:');
});

test('committing a mention keeps the text that came before it', () => {
  const editor = open();
  editor.setText('hi @me');

  const found = query(editor);
  editor.replaceQuery(
    { sigil: '@', query: 'me', start: found.start, end: found.end },
    composerSchema.nodes.mention.create({ userId: '@me:example.org', name: 'Me' })
  );

  const doc = editor.doc();
  if (!doc) throw new Error('no doc');
  expect(serializeComposer(doc).body).toBe('hi Me');
});

test('a mention-only document is not empty', () => {
  const editor = open();
  editor.insert(composerSchema.nodes.mention.create({ userId: '@me:example.org', name: 'Me' }));

  expect(editor.isEmpty()).toBe(false);
});

test('clear empties the document and setText refills it', () => {
  const editor = open();
  editor.setText('one\ntwo');
  expect(editor.doc()?.childCount).toBe(2);

  editor.clear();
  expect(editor.isEmpty()).toBe(true);
});

test('the active option is written straight onto the editor node', () => {
  const host = document.createElement('div');
  document.body.append(host);
  let activeId: string | null = null;
  const editor = new ComposerEditor({
    media: { cached: () => undefined, load: () => Promise.resolve('blob:x') },
    label: () => 'Send a message',
    listboxId: 'suggestions',
    activeOptionId: () => activeId,
    editable: () => true,
    onSubmit: () => {},
    onChange: () => {},
    onQuery: () => {},
    onNavigate: () => false,
    onFiles: vi.fn(),
  });
  dispose = editor.mount(host);
  const surface = host.querySelector('[contenteditable]');

  activeId = 'suggestions-2';
  editor.syncActiveOption();
  expect(surface?.getAttribute('aria-activedescendant')).toBe('suggestions-2');
  expect(surface?.getAttribute('aria-expanded')).toBe('true');

  activeId = null;
  editor.syncActiveOption();
  expect(surface?.getAttribute('aria-activedescendant')).toBeNull();
  expect(surface?.getAttribute('aria-expanded')).toBe('false');
});
