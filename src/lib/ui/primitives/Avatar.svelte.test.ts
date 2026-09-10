// @vitest-environment happy-dom

import { mount, tick, unmount } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';

const coreStub = vi.hoisted(() => {
  const stub = { fetchMedia: vi.fn(() => new Promise<never>(() => {})), session: null };
  return Object.assign(stub, { commands: stub });
});

vi.mock('#lib/core/context.js', () => ({ useCoreClient: () => coreStub }));

import Avatar from './Avatar.svelte';

afterEach(() => {
  document.body.replaceChildren();
});

function root(): HTMLElement | null {
  return document.querySelector('.avatar-root');
}

test('paints the colour behind the initials when there is no picture', () => {
  mount(Avatar, {
    target: document.body,
    props: { name: 'Sable', color: 'rgb(1, 2, 3)' },
  });

  expect(root()?.style.background).toBe('rgb(1, 2, 3)');
  expect(document.querySelector('.avatar-fallback')).not.toBeNull();
});

test('leaves a picture on a transparent box, so a transparent png keeps its own shape', () => {
  mount(Avatar, {
    target: document.body,
    props: { src: 'mxc://example.org/avatar', name: 'Sable', color: 'rgb(1, 2, 3)' },
  });

  expect(root()?.style.background).toBe('');
  const fallback = document.querySelector<HTMLElement>('.avatar-fallback');
  expect(fallback?.dataset.status).toBe('loaded');
  expect(fallback?.style.display).toBe('none');
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
  expect(document.querySelector('.avatar-fallback')).not.toBeNull();
  await unmount(instance);
});
