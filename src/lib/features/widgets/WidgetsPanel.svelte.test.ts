// @vitest-environment happy-dom
// @vitest-environment-options { "settings": { "disableIframePageLoading": true } }

import { render, screen, within } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';

vi.mock('#lib/core/context.js');

import { core } from '#lib/core/__mocks__/context.js';

core.session = { account_id: 'a', user_id: '@erwan:example.org', device_id: 'DEV' };

import WidgetsPanel from './WidgetsPanel.svelte';
import type { RoomWidget } from './widget-content.js';

afterEach(() => {
  localStorage.clear();
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

const panel = () => screen.getByRole('complementary', { name: 'Widgets' });

test('shows an empty message when there are no widgets', () => {
  const { container } = render(WidgetsPanel, { ...commonProps, widgets: [], onClose: vi.fn() });

  expect(screen.getByText('This room has no widgets.')).toBeInTheDocument();
  expect(container.querySelector('iframe')).not.toBeInTheDocument();
});

test('renders a sandboxed iframe for the first widget, templated', () => {
  render(WidgetsPanel, { ...commonProps, widgets, onClose: vi.fn() });

  const iframe = screen.getByTitle<HTMLIFrameElement>('Jitsi');
  expect(iframe.tagName).toBe('IFRAME');
  expect(iframe).toHaveAttribute('sandbox', expect.stringContaining('allow-scripts'));
  expect(iframe).toHaveAttribute('allow', expect.stringContaining('camera'));
  const src = new URL(iframe.src);
  expect(src.searchParams.get('user')).toBe(commonProps.userId);
  expect(src.searchParams.get('wid')).toBe('widget-1');
});

test('switches the active widget on tab click', async () => {
  const user = userEvent.setup();
  render(WidgetsPanel, { ...commonProps, widgets, onClose: vi.fn() });

  const tabs = screen.getAllByRole('tab');
  expect(tabs.map((tab) => tab.textContent.trim())).toEqual(['Jitsi', 'Other']);
  await user.click(screen.getByRole('tab', { name: 'Other' }));

  expect(screen.getByTitle('Other').tagName).toBe('IFRAME');
});

test('shows a remove action only when the caller can manage widgets', async () => {
  const user = userEvent.setup();
  const onRemove = vi.fn();
  render(WidgetsPanel, { ...commonProps, widgets, canManage: true, onClose: vi.fn(), onRemove });

  await user.click(within(panel()).getByRole('button', { name: 'Remove Jitsi' }));
  expect(onRemove).not.toHaveBeenCalled();

  const dialog = await screen.findByRole('dialog');
  await user.click(within(dialog).getByRole('button', { name: 'Remove Jitsi' }));

  expect(onRemove).toHaveBeenCalledWith('widget-1');
});

test('omits the remove action when the caller cannot manage widgets', () => {
  render(WidgetsPanel, { ...commonProps, widgets, canManage: false, onClose: vi.fn() });

  expect(screen.queryByRole('button', { name: /^Remove / })).not.toBeInTheDocument();
});

test('calls onClose from the close button', async () => {
  const user = userEvent.setup();
  const onClose = vi.fn();
  render(WidgetsPanel, { ...commonProps, widgets, onClose });

  await user.click(screen.getByRole('button', { name: 'Close widgets' }));
  expect(onClose).toHaveBeenCalled();
});

test('resizes the side panel and reopens at that width', async () => {
  const user = userEvent.setup();
  const props = { ...commonProps, widgets: [], onClose: vi.fn() };
  const first = render(WidgetsPanel, props);

  screen.getByRole('slider', { name: 'Resize widgets' }).focus();
  await user.keyboard('{ArrowLeft}');
  expect(panel().style.width).toBe('23rem');
  first.unmount();

  render(WidgetsPanel, props);
  expect(panel().style.width).toBe('23rem');
});

test('leaves the drawer variant unresizable', () => {
  render(WidgetsPanel, { ...commonProps, widgets: [], modal: true, onClose: vi.fn() });

  expect(screen.queryByRole('slider')).not.toBeInTheDocument();
});
