// @vitest-environment happy-dom

import { expect, test, vi } from 'vitest';

import { composerMarkViews, composerNodeViews, type EmoteMedia } from './node-views';
import { composerSchema } from './schema';

const { mention, emoticon } = composerSchema.nodes;

function views(media: Partial<EmoteMedia> = {}): ReturnType<typeof composerNodeViews> {
  return composerNodeViews({
    cached: () => undefined,
    load: () => Promise.resolve('blob:emote'),
    hold: () => () => {},
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

  expect(view.dom.textContent).toBe('Member One×');
  expect(view.dom.contentEditable).toBe('false');
  expect(view.dom.title).toBe('@one:example.org');
  expect(view.dom.querySelector('button')).toHaveAttribute('aria-label', 'Remove mention link');
});

test('a mention can be unlinked', () => {
  const unlink = vi.fn();
  const node = mention.create({ userId: '@one:example.org', name: 'Member One' });
  const view = composerNodeViews(
    {
      cached: () => undefined,
      load: () => Promise.resolve('blob:emote'),
      hold: () => () => {},
    },
    unlink
  )['mention'](node, null as never, () => 4, [], null as never);

  view.dom.querySelector('button')?.click();

  expect(unlink).toHaveBeenCalledWith(4);
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

const { image } = composerSchema.nodes;

test('an inline image shows its alt text until the bytes arrive, then paints', async () => {
  const release = vi.fn();
  const view = views({ hold: () => release })['image'](
    image.create({ src: 'mxc://example.org/pic', alt: 'a cat' }),
    null as never,
    () => 0,
    [],
    null as never
  );

  expect(view.dom.textContent).toBe('a cat');
  await vi.waitFor(() => {
    expect(view.dom.querySelector('img')?.getAttribute('src')).toBe('blob:emote');
  });
  expect(view.dom.querySelector('img')?.alt).toBe('a cat');

  view.destroy?.();
  expect(release).toHaveBeenCalledOnce();
});

test('an inline image without alt text names itself by its address, and paints at once when cached', () => {
  const cachedImage = views({ cached: () => 'blob:ready' })['image'](
    image.create({ src: 'mxc://example.org/pic' }),
    null as never,
    () => 0,
    [],
    null as never
  );
  expect(cachedImage.dom.querySelector('img')?.alt).toBe('mxc://example.org/pic');
  expect(cachedImage.dom.querySelector('img')?.getAttribute('src')).toBe('blob:ready');
});

test('an image whose bytes never arrive keeps its label and does not throw', async () => {
  const view = views({ load: () => Promise.reject(new Error('gone')) })['image'](
    image.create({ src: 'mxc://example.org/pic', alt: 'lost' }),
    null as never,
    () => 0,
    [],
    null as never
  );
  await Promise.resolve();
  await Promise.resolve();
  expect(view.dom.textContent).toBe('lost');
});

test('a colour mark paints its colour in the editor', () => {
  const { color, bg_color } = composerSchema.marks;

  const fg = composerMarkViews.color(color.create({ value: '#ff0000' }), null as never, true);
  const bg = composerMarkViews.bg_color(bg_color.create({ value: '#00ff00' }), null as never, true);

  expect(fg.dom).toHaveAttribute('data-mx-color', '#ff0000');
  expect(fg.dom.style.color).not.toBe('');
  expect(bg.dom).toHaveAttribute('data-mx-bg-color', '#00ff00');
  expect(bg.dom.style.backgroundColor).not.toBe('');
});
