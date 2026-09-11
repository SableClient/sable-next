// @vitest-environment happy-dom

import { mount, tick, unmount } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';

import { formatPronouns } from '#lib/personas/pronouns.js';
import { preferences } from '#lib/settings/preferences.svelte.js';

import { senderDisplayColors } from './members.js';
import SenderName from './SenderName.svelte';

afterEach(() => {
  preferences.hidePronounPill = false;
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
  expect(document.querySelector('.sender-identity-pronoun')?.textContent).toBe('they/them');
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

test('SenderName counts the overflow pronouns in one pill', async () => {
  const overflow = [
    { summary: 'she/her', language: null },
    { summary: 'xe/xem', language: null },
  ];
  const instance = mount(SenderName, {
    target: document.body,
    props: {
      displayName: 'Carol',
      colors: senderDisplayColors('@carol:example.org', null),
      pronouns: { visible: [{ summary: 'they/them', language: null }], overflow },
    },
  });
  await tick();

  const pills = document.querySelectorAll('.sender-identity-pronoun');
  expect(pills).toHaveLength(2);
  expect(pills[1]?.getAttribute('title')).toBe(formatPronouns(overflow));
  await unmount(instance);
});

test('SenderName drops the pronoun pills when they are hidden', async () => {
  preferences.hidePronounPill = true;
  const instance = mount(SenderName, {
    target: document.body,
    props: {
      displayName: 'Dave',
      accountName: '@dave:example.org',
      colors: senderDisplayColors('@dave:example.org', null),
      pronouns: {
        visible: [{ summary: 'they/them', language: null }],
        overflow: [{ summary: 'she/her', language: null }],
      },
    },
  });
  await tick();

  expect(document.querySelector('.sender-identity-pronouns')).toBeNull();
  expect(document.querySelector('.sender-identity-pronoun')).toBeNull();
  expect(document.body.textContent).toContain('Dave');
  expect(document.querySelector('.sender-identity-via')?.textContent).toContain(
    '@dave:example.org'
  );
  await unmount(instance);
});

test('SenderName restores the pronoun pills when the preference flips back', async () => {
  preferences.hidePronounPill = true;
  const instance = mount(SenderName, {
    target: document.body,
    props: {
      displayName: 'Erin',
      colors: senderDisplayColors('@erin:example.org', null),
      pronouns: { visible: [{ summary: 'they/them', language: null }], overflow: [] },
    },
  });
  await tick();
  expect(document.querySelector('.sender-identity-pronoun')).toBeNull();

  preferences.hidePronounPill = false;
  await tick();
  expect(document.querySelector('.sender-identity-pronoun')?.textContent).toBe('they/them');
  await unmount(instance);
});
