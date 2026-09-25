// @vitest-environment happy-dom

import { mount, tick, unmount } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';

vi.mock('#lib/core/context.js');

import { core } from '#lib/core/__mocks__/context.js';

import Avatar from './Avatar.svelte';
import { identityColor } from './identity-color.js';

afterEach(() => {
  core.fetchMedia.mockReset();
  vi.useRealTimers();
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
  expect(fallback()?.style.color).toBe('var(--avatar-identity-on-plate)');
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

test('a picture the media layer cannot fetch falls back to the initials at once', async () => {
  vi.useFakeTimers();
  core.fetchMedia.mockRejectedValue(new Error('gone'));
  mount(Avatar, {
    target: document.body,
    props: { src: 'mxc://example.org/gone', name: 'Sable', id: '@sable:example.org' },
  });

  await vi.advanceTimersByTimeAsync(0);

  expect(fallback()?.style.display).toBe('');
});

test('shows the initials while a transient failure retries, then the picture', async () => {
  vi.useFakeTimers();
  core.fetchMedia
    .mockRejectedValueOnce(new Error('temporary failure'))
    .mockResolvedValueOnce(new Uint8Array([1]));
  mount(Avatar, {
    target: document.body,
    props: { src: 'mxc://example.org/retrying', name: 'Sable', id: '@sable:example.org' },
  });

  await vi.advanceTimersByTimeAsync(0);
  expect(fallback()?.style.display).toBe('');

  await vi.advanceTimersByTimeAsync(2_000);
  document.querySelector('.avatar-image img')?.dispatchEvent(new Event('load'));
  await tick();

  expect(fallback()?.style.display).toBe('none');
});

test('an undecodable picture falls back to the initials', async () => {
  vi.useFakeTimers();
  core.fetchMedia.mockResolvedValue(new Uint8Array([1]));
  mount(Avatar, {
    target: document.body,
    props: { src: 'mxc://example.org/undecodable-avatar', name: 'Sable' },
  });

  for (let step = 0; step < 2; step += 1) {
    await vi.advanceTimersByTimeAsync(0);
    document.querySelector('.avatar-image img')?.dispatchEvent(new Event('error'));
  }
  await vi.advanceTimersByTimeAsync(0);

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
