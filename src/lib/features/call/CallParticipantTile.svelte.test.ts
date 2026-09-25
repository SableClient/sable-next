// @vitest-environment happy-dom

import { flushSync, mount, unmount } from 'svelte';
import { afterEach, expect, test } from 'vitest';

import CallParticipantTile from './CallParticipantTile.svelte';

afterEach(() => {
  document.body.replaceChildren();
});

function mountTile() {
  return mount(CallParticipantTile, {
    target: document.body,
    props: {
      participant: { identity: '@bob:example.org:DEVICE', microphone: undefined },
      source: 'camera',
      room: undefined,
      name: 'Bob',
      userId: '@bob:example.org',
      avatar: null,
    },
  });
}

function openFromContextMenu(): void {
  document
    .querySelector('li.tile')
    ?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  flushSync();
}

const panel = () => document.querySelector('.volume');

test('closes the volume panel on a pointer down outside it', async () => {
  const instance = mountTile();
  openFromContextMenu();
  expect(panel()).not.toBeNull();

  panel()?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
  flushSync();
  expect(panel()).not.toBeNull();

  document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
  flushSync();
  expect(panel()).toBeNull();

  await unmount(instance);
});

test('closes the volume panel on Escape', async () => {
  const instance = mountTile();
  openFromContextMenu();

  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  flushSync();
  expect(panel()).toBeNull();

  await unmount(instance);
});

test('the volume button still toggles the panel closed', async () => {
  const instance = mountTile();
  openFromContextMenu();

  const toggle = document.querySelector<HTMLButtonElement>('[data-volume-toggle]');
  toggle?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
  toggle?.click();
  flushSync();
  expect(panel()).toBeNull();

  await unmount(instance);
});
