// @vitest-environment happy-dom
// @vitest-environment-options { "settings": { "disableIframePageLoading": true } }

import { mount, tick, unmount } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';

const core = {
  session: { account_id: 'a', user_id: '@erwan:example.org', device_id: 'DEV' },
  commands: {},
};

vi.mock('#lib/core/context.js', () => ({
  useCoreClient: () => core,
}));

import WidgetsPanel from './WidgetsPanel.svelte';
import type { RoomWidget } from './widget-content.js';

afterEach(() => {
  document.body.replaceChildren();
});

const widgets: RoomWidget[] = [
  {
    id: 'widget-1',
    type: 'm.custom',
    url: 'https://widget.example/app?user=$matrix_user_id&wid=$matrix_widget_id',
    name: 'Jitsi',
    data: {},
  },
  {
    id: 'widget-2',
    type: 'm.custom',
    url: 'https://other.example/app',
    name: 'Other',
    data: {},
  },
];

const commonProps = {
  roomId: '!room:example.org',
  userId: '@erwan:example.org',
  displayName: 'Erwan',
  avatarUrl: 'mxc://example.org/avatar',
};

test('shows an empty message when there are no widgets', async () => {
  const instance = mount(WidgetsPanel, {
    target: document.body,
    props: { ...commonProps, widgets: [], onClose: vi.fn() },
  });
  await tick();

  expect(document.querySelector('.widgets-empty')).not.toBeNull();
  expect(document.querySelector('iframe')).toBeNull();
  await unmount(instance);
});

test('renders a sandboxed iframe for the first widget, templated', async () => {
  const instance = mount(WidgetsPanel, {
    target: document.body,
    props: { ...commonProps, widgets, onClose: vi.fn() },
  });
  await tick();

  const iframe = document.querySelector<HTMLIFrameElement>('iframe');
  expect(iframe?.title).toBe('Jitsi');
  expect(iframe?.getAttribute('sandbox')).toContain('allow-scripts');
  expect(iframe?.getAttribute('allow')).toContain('camera');
  const src = new URL(iframe?.src ?? '');
  expect(src.searchParams.get('user')).toBe(commonProps.userId);
  expect(src.searchParams.get('wid')).toBe('widget-1');
  await unmount(instance);
});

test('switches the active widget on tab click', async () => {
  const instance = mount(WidgetsPanel, {
    target: document.body,
    props: { ...commonProps, widgets, onClose: vi.fn() },
  });
  await tick();

  const tabs = [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
  expect(tabs.map((tab) => tab.textContent.trim())).toEqual(['Jitsi', 'Other']);
  tabs[1].click();
  await tick();

  expect(document.querySelector('iframe')?.title).toBe('Other');
  await unmount(instance);
});

test('shows a remove action only when the caller can manage widgets', async () => {
  const onRemove = vi.fn();
  const instance = mount(WidgetsPanel, {
    target: document.body,
    props: { ...commonProps, widgets, canManage: true, onClose: vi.fn(), onRemove },
  });
  await tick();

  document.querySelectorAll('.widgets-tab')[0].querySelectorAll('button')[1].click();
  expect(onRemove).toHaveBeenCalledWith('widget-1');
  await unmount(instance);
});

test('omits the remove action when the caller cannot manage widgets', async () => {
  const instance = mount(WidgetsPanel, {
    target: document.body,
    props: { ...commonProps, widgets, canManage: false, onClose: vi.fn() },
  });
  await tick();

  const tab = document.querySelectorAll('.widgets-tab')[0];
  expect(tab.querySelectorAll('button').length).toBe(1);
  await unmount(instance);
});

test('calls onClose from the close button', async () => {
  const onClose = vi.fn();
  const instance = mount(WidgetsPanel, {
    target: document.body,
    props: { ...commonProps, widgets, onClose },
  });
  await tick();

  document.querySelector<HTMLButtonElement>('.widgets-header button')?.click();
  expect(onClose).toHaveBeenCalled();
  await unmount(instance);
});
