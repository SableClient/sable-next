// @vitest-environment happy-dom

import { mount } from 'svelte';
import ChatCircleDotsIcon from 'phosphor-svelte/lib/ChatCircleDotsIcon';
import { afterEach, expect, test, vi } from 'vitest';

import ActionCard from './ActionCard.svelte';
import SableBrandMark from './SableBrandMark.svelte';

afterEach(() => {
  document.body.replaceChildren();
});

test('action cards use links for navigation', () => {
  mount(ActionCard, {
    target: document.body,
    props: {
      icon: ChatCircleDotsIcon,
      title: 'Explore',
      description: 'Browse public rooms.',
      href: '/explore',
    },
  });

  const card = document.querySelector('a');
  expect(card?.getAttribute('href')).toBe('/explore');
  expect(card?.textContent).toContain('Browse public rooms.');
});

test('action cards use buttons for in-app actions', () => {
  const onclick = vi.fn();
  mount(ActionCard, {
    target: document.body,
    props: {
      icon: ChatCircleDotsIcon,
      title: 'Join a room',
      onclick,
    },
  });

  const card = document.querySelector('button');
  card?.click();

  expect(card?.disabled).toBe(false);
  expect(onclick).toHaveBeenCalledOnce();
});

test('inactive action cards are disabled semantically', () => {
  mount(ActionCard, {
    target: document.body,
    props: {
      icon: ChatCircleDotsIcon,
      title: 'Join a room',
      disabled: true,
    },
  });

  expect(document.querySelector('button')?.disabled).toBe(true);
});

test('the Sable brand mark stays decorative', () => {
  mount(SableBrandMark, { target: document.body });

  const mark = document.querySelector('img');
  expect(mark?.getAttribute('alt')).toBe('');
  expect(mark?.className).toContain('sable-brand-mark');
});
