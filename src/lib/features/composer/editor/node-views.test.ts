// @vitest-environment happy-dom

import { expect, test, vi } from 'vitest';

import { composerNodeViews, type EmoteMedia } from './node-views';
import { composerSchema } from './schema';

const { mention, emoticon } = composerSchema.nodes;

function views(media: Partial<EmoteMedia> = {}): ReturnType<typeof composerNodeViews> {
  return composerNodeViews({
    cached: () => undefined,
    load: () => Promise.resolve('blob:emote'),
    ...media,
  });
}

function build(
  name: 'mention' | 'emoticon',
  node: Parameters<ReturnType<typeof composerNodeViews>[string]>[0],
  media?: Partial<EmoteMedia>
): ReturnType<ReturnType<typeof composerNodeViews>[string]> {
  return views(media)[name](node, null as never, () => 0, [], null as never);
}

test('a mention renders its name and keeps the caret out of the atom', () => {
  const view = build('mention', mention.create({ userId: '@one:example.org', name: 'Member One' }));

  expect(view.dom.textContent).toBe('Member One');
  expect(view.dom.contentEditable).toBe('false');
  expect(view.dom.title).toBe('@one:example.org');
});

test('selecting a mention marks it, and deselecting clears the mark', () => {
  const view = build('mention', mention.create({ userId: '@one:example.org', name: 'Member One' }));

  view.selectNode?.();
  expect(view.dom.classList.contains('selected')).toBe(true);

  view.deselectNode?.();
  expect(view.dom.classList.contains('selected')).toBe(false);
});

test('a cached emote paints its image without waiting', () => {
  const load = vi.fn(() => Promise.resolve('blob:late'));
  const view = build(
    'emoticon',
    emoticon.create({ url: 'mxc://example.org/wave', shortcode: 'wave' }),
    { cached: () => 'blob:ready', load }
  );

  const image = view.dom.querySelector('img');
  expect(image?.getAttribute('src')).toBe('blob:ready');
  expect(image?.alt).toBe(':wave:');
  expect(load).not.toHaveBeenCalled();
});

test('an uncached emote shows its shortcode until the bytes arrive', async () => {
  const view = build(
    'emoticon',
    emoticon.create({ url: 'mxc://example.org/wave', shortcode: 'wave' })
  );

  expect(view.dom.textContent).toBe(':wave:');

  await vi.waitFor(() => {
    expect(view.dom.querySelector('img')?.getAttribute('src')).toBe('blob:emote');
  });
});

test('an emote destroyed before its bytes arrive does not paint', async () => {
  let settle: (src: string) => void = () => undefined;
  const view = build(
    'emoticon',
    emoticon.create({ url: 'mxc://example.org/wave', shortcode: 'wave' }),
    {
      load: () =>
        new Promise<string>((resolve) => {
          settle = resolve;
        }),
    }
  );

  view.destroy?.();
  settle('blob:emote');
  await Promise.resolve();

  expect(view.dom.querySelector('img')).toBeNull();
  expect(view.dom.textContent).toBe(':wave:');
});
