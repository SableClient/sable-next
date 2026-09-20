// @vitest-environment happy-dom

import { mount, tick, unmount } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';

vi.mock('#lib/core/context.js');

import ProfileCard from './ProfileCard.svelte';

afterEach(() => {
  document.body.replaceChildren();
});

function cover(): HTMLElement | null {
  return document.querySelector('.profile-card-banner');
}

test('uses the avatar as a blurred cover when there is no banner', async () => {
  const instance = mount(ProfileCard, {
    target: document.body,
    props: {
      displayName: 'Ana',
      userId: '@ana:example.org',
      color: '#abcdef',
      avatarUrl: 'mxc://example.org/ana',
    },
  });
  await tick();

  expect(cover()).not.toBeNull();
  expect(cover()?.classList.contains('profile-card-banner-fallback')).toBe(true);
  await unmount(instance);
});

test('keeps a real banner unblurred', async () => {
  const instance = mount(ProfileCard, {
    target: document.body,
    props: {
      displayName: 'Ana',
      userId: '@ana:example.org',
      color: '#abcdef',
      avatarUrl: 'mxc://example.org/ana',
      bannerUrl: 'mxc://example.org/banner',
    },
  });
  await tick();

  expect(cover()?.classList.contains('profile-card-banner-fallback')).toBe(false);
  await unmount(instance);
});

test('paints the flat colour when there is no avatar either', async () => {
  const instance = mount(ProfileCard, {
    target: document.body,
    props: { displayName: 'Ana', userId: '@ana:example.org', color: '#abcdef' },
  });
  await tick();

  expect(cover()).toBeNull();
  await unmount(instance);
});
