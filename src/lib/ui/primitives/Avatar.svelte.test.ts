// @vitest-environment happy-dom

import { mount, tick, unmount } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';

const coreStub = vi.hoisted(() => {
  const stub = {
    fetchMedia: vi.fn((): Promise<Uint8Array> => new Promise(() => {})),
    session: null,
  };
  return Object.assign(stub, { commands: stub });
});

vi.mock('#lib/core/context.js', () => ({ useCoreClient: () => coreStub }));

import Avatar from './Avatar.svelte';
import { identityColor } from './identity-color.js';

afterEach(() => {
  document.body.replaceChildren();
});

function root(): HTMLElement | null {
  return document.querySelector('.avatar-root');
}

function fallback(): HTMLElement | null {
  return document.querySelector('.avatar-fallback');
}

test('paints the colour on the fallback, never on the root', () => {
  mount(Avatar, {
    target: document.body,
    props: { name: 'Sable', color: 'rgb(1, 2, 3)' },
  });

  expect(root()?.style.background).toBe('');
  expect(fallback()?.style.background).toBe('rgb(1, 2, 3)');
});

test('derives the fallback colour from the id when the caller names none', () => {
  mount(Avatar, {
    target: document.body,
    props: { name: 'Sable', id: '@sable:example.org' },
  });

  expect(fallback()?.style.background).toBe(identityColor('@sable:example.org'));
});

test('tints the picture box until the picture paints, and never the root', () => {
  mount(Avatar, {
    target: document.body,
    props: { src: 'mxc://example.org/avatar', name: 'Sable', id: '@sable:example.org' },
  });

  const image = document.querySelector<HTMLElement>('.avatar-image');
  expect(image?.style.background).toBe(identityColor('@sable:example.org'));
  expect(root()?.style.background).toBe('');
  expect(fallback()?.style.display).toBe('none');
});

test('a picture the media layer cannot fetch falls back to the initials', async () => {
  coreStub.fetchMedia.mockRejectedValueOnce(new Error('gone'));
  mount(Avatar, {
    target: document.body,
    props: { src: 'mxc://example.org/gone', name: 'Sable', id: '@sable:example.org' },
  });

  for (let index = 0; index < 20; index += 1) await tick();

  expect(fallback()?.style.display).toBe('');
});

test('leaves a picture on a transparent box, so a transparent png keeps its own shape', () => {
  mount(Avatar, {
    target: document.body,
    props: { src: 'https://example.org/avatar.png', name: 'Sable', color: 'rgb(1, 2, 3)' },
  });

  expect(root()?.style.background).toBe('');
});

test('removes the old picture when its reactive source is cleared', async () => {
  const props = $state<{ src: string | null; name: string }>({
    src: 'mxc://example.org/avatar',
    name: 'Sable',
  });
  const instance = mount(Avatar, { target: document.body, props });

  expect(document.querySelector('.avatar-image')).not.toBeNull();

  props.src = null;
  await tick();

  expect(document.querySelector('.avatar-image')).toBeNull();
  expect(fallback()).not.toBeNull();
  await unmount(instance);
});
