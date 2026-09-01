// @vitest-environment happy-dom

import { mount, tick, unmount } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';

import { senderDisplayColors } from './members.js';
import SenderName from './SenderName.svelte';

afterEach(() => {
  document.body.replaceChildren();
});

test('SenderName mentions and shows pronoun pills', async () => {
  const onMention = vi.fn();
  const instance = mount(SenderName, {
    target: document.body,
    props: {
      displayName: 'Alice',
      colors: senderDisplayColors('@alice:example.org', null),
      pronouns: {
        visible: [{ summary: 'they/them', language: null }],
        overflow: [],
      },
      onMention,
    },
  });
  await tick();

  const button = document.querySelector<HTMLButtonElement>('.name-button');
  expect(button?.textContent).toBe('Alice');
  expect(document.querySelector('.sable-pronoun-pill')?.textContent).toBe('they/them');
  button?.click();
  expect(onMention).toHaveBeenCalledTimes(1);
  await unmount(instance);
});

test('SenderName opens a profile when mention is unavailable', async () => {
  const onProfile = vi.fn();
  const instance = mount(SenderName, {
    target: document.body,
    props: {
      displayName: 'Bob',
      colors: senderDisplayColors('@bob:example.org', null),
      onProfile,
    },
  });
  await tick();

  const button = document.querySelector<HTMLButtonElement>('.name-button');
  button?.click();
  expect(onProfile).toHaveBeenCalledWith(button);
  await unmount(instance);
});
