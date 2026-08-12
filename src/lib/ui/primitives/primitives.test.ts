// @vitest-environment happy-dom

import { mount } from 'svelte';
import { afterEach, expect, test } from 'vitest';

import Alert from './Alert.svelte';
import AppPageShell from './AppPageShell.svelte';
import Avatar from './Avatar.svelte';
import Button from './Button.svelte';
import EmptyState from './EmptyState.svelte';
import IconButton from './IconButton.svelte';
import LinkButton from './LinkButton.svelte';
import StatusBadge from './StatusBadge.svelte';
import TextArea from './TextArea.svelte';

afterEach(() => {
  document.body.replaceChildren();
});

test('button variants expose loading and disabled state consistently', () => {
  mount(Button, {
    target: document.body,
    props: { variant: 'primary', size: 'large', loading: true },
  });

  const button = document.querySelector('button');
  expect(button).not.toBeNull();
  expect(button?.className).toContain('sable-button-primary');
  expect(button?.className).toContain('sable-button-large');
  expect(button?.className).toContain('sable-button-loading');
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
    props: { href: '/home', variant: 'primary' },
  });

  expect(document.querySelector('button')?.getAttribute('aria-label')).toBe('Close');
  expect(document.querySelector('button')?.className).toContain('sable-icon-button-small');
  expect(document.querySelector('a')?.getAttribute('href')).toBe('/home');
  expect(document.querySelector('a')?.className).toContain('sable-button-primary');
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
