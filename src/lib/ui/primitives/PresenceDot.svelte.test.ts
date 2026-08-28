// @vitest-environment happy-dom

import { mount } from 'svelte';
import { afterEach, expect, test } from 'vitest';

import PresenceDot from './PresenceDot.svelte';

afterEach(() => {
  document.body.replaceChildren();
});

test('exposes the presence as an accessible name, not just colour', () => {
  mount(PresenceDot, {
    target: document.body,
    props: { presence: 'online', label: 'Online' },
  });

  const dot = document.querySelector('[data-presence]');
  expect(dot?.getAttribute('role')).toBe('img');
  expect(dot?.getAttribute('aria-label')).toBe('Online');
  expect(dot?.getAttribute('data-presence')).toBe('online');
});

test('applies the caller class alongside its own', () => {
  mount(PresenceDot, {
    target: document.body,
    props: { presence: 'unavailable', label: 'Away', class: 'custom' },
  });

  const dot = document.querySelector('[data-presence]');
  expect(dot?.className).toContain('sable-presence-dot');
  expect(dot?.className).toContain('custom');
});
