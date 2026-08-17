// @vitest-environment happy-dom

import { mount } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';

import Alert from './Alert.svelte';
import AppPageShell from './AppPageShell.svelte';
import Avatar from './Avatar.svelte';
import Button from './Button.svelte';
import EmptyState from './EmptyState.svelte';
import IconButton from './IconButton.svelte';
import LinkButton from './LinkButton.svelte';
import OptionCards from './OptionCards.svelte';
import Skeleton from './Skeleton.svelte';
import StatusBadge from './StatusBadge.svelte';
import TextArea from './TextArea.svelte';

afterEach(() => {
  document.body.replaceChildren();
});

test('button variants expose loading and disabled state consistently', () => {
  mount(Button, {
    target: document.body,
    props: { variant: 'primary', size: 'large', loading: true, block: true },
  });

  const button = document.querySelector('button');
  expect(button).not.toBeNull();
  expect(button?.className).toContain('sable-button-primary');
  expect(button?.className).toContain('sable-button-large');
  expect(button?.className).toContain('sable-button-loading');
  expect(button?.className).toContain('sable-button-block');
  expect(button?.disabled).toBe(true);
  expect(button?.getAttribute('aria-busy')).toBe('true');
});

test('icon and link buttons retain accessible labels and shared styling', () => {
  mount(IconButton, {
    target: document.body,
    props: { label: 'Close', variant: 'ghost', size: 'small' },
  });
  mount(LinkButton, {
    target: document.body,
    props: { href: '/home', variant: 'primary', block: true },
  });

  expect(document.querySelector('button')?.getAttribute('aria-label')).toBe('Close');
  expect(document.querySelector('button')?.className).toContain('sable-icon-button-small');
  expect(document.querySelector('a')?.getAttribute('href')).toBe('/home');
  expect(document.querySelector('a')?.className).toContain('sable-button-primary');
  expect(document.querySelector('a')?.className).toContain('sable-button-block');
});

test('content primitives expose semantic state and input affordances', () => {
  mount(TextArea, {
    target: document.body,
    props: { value: 'draft', error: true, disabled: true },
  });
  mount(Avatar, {
    target: document.body,
    props: { initials: 'S', alt: 'Sable', size: 'small' },
  });
  mount(Alert, {
    target: document.body,
    props: { variant: 'critical', role: 'alert' },
  });
  mount(StatusBadge, {
    target: document.body,
    props: { label: 'Verified', variant: 'success' },
  });

  expect(document.querySelector('textarea')?.className).toContain('form-control-error');
  expect(document.querySelector('textarea')?.disabled).toBe(true);
  expect(document.querySelector('.sable-avatar')?.getAttribute('role')).toBe('img');
  expect(document.querySelector('.sable-avatar')?.getAttribute('aria-label')).toBe('Sable');
  expect(document.querySelector('[role="alert"]')?.className).toContain('sable-alert-critical');
  expect(document.querySelector('.status-badge')?.className).toContain('status-badge-success');
});

test('decorative avatars stay out of the accessibility tree', () => {
  mount(Avatar, {
    target: document.body,
    props: { initials: 'S', decorative: true },
  });

  expect(document.querySelector('.sable-avatar')?.getAttribute('aria-hidden')).toBe('true');
  expect(document.querySelector('.sable-avatar')?.getAttribute('aria-label')).toBeNull();
});

test('option cards are one native radio group', () => {
  const onSelect = vi.fn();
  mount(OptionCards, {
    target: document.body,
    props: {
      label: 'Visibility',
      value: 'private',
      onSelect,
      options: [
        { value: 'private', label: 'Private', hint: 'Invite only' },
        { value: 'public', label: 'Public' },
        { value: 'space', label: 'Space', disabled: true },
      ],
    },
  });

  const radios = [...document.querySelectorAll<HTMLInputElement>('input[type="radio"]')];

  expect(document.querySelector('[role="radiogroup"]')?.getAttribute('aria-label')).toBe(
    'Visibility'
  );
  expect(new Set(radios.map((radio) => radio.name)).size).toBe(1);
  expect(radios[0].checked).toBe(true);
  expect(radios[2].disabled).toBe(true);

  radios[1].click();

  expect(onSelect).toHaveBeenCalledWith('public');
});

test('skeletons are decorative and forward presentation attributes', () => {
  mount(Skeleton, {
    target: document.body,
    props: { class: 'message-placeholder', style: 'width: 12rem' },
  });

  const skeleton = document.querySelector('.sable-skeleton');
  expect(skeleton?.getAttribute('aria-hidden')).toBe('true');
  expect(skeleton?.className).toContain('message-placeholder');
  expect(skeleton?.getAttribute('style')).toContain('width: 12rem');
});

test('page composition primitives provide labelled layout landmarks', () => {
  mount(EmptyState, {
    target: document.body,
    props: { title: 'Nothing here', description: 'Try another place', titleId: 'empty-heading' },
  });
  mount(AppPageShell, {
    target: document.body,
    props: { title: 'Settings', description: 'Manage your account' },
  });

  expect(document.querySelector('#empty-heading')?.textContent).toContain('Nothing here');
  expect(document.querySelector('main h1')?.textContent).toContain('Settings');
  expect(document.querySelector('main')?.className).toContain('app-page-shell');
});
