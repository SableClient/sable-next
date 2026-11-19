// @vitest-environment happy-dom

import { render, screen } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';

import type { RecentMedia, RecentMediaList } from '#lib/platform/recent-media.js';

const platform = vi.hoisted(() => ({
  recentMedia: vi.fn<(limit?: number, request?: boolean) => Promise<RecentMediaList>>(),
}));
const os = vi.hoisted(() => ({ android: true }));
vi.mock('#lib/platform/os.js', async (original) => ({
  ...(await original<typeof import('#lib/platform/os.js')>()),
  isAndroid: () => os.android,
}));
vi.mock('#lib/platform/recent-media.js', () => ({
  recentMedia: platform.recentMedia,
  recentMediaThumbnail: () => Promise.resolve(null),
  recentMediaFile: vi.fn(),
}));

import RecentMediaStrip from './RecentMediaStrip.svelte';

const photo: RecentMedia = { id: 'content://1', kind: 'image', name: 'cat.jpg', duration: 0 };

const unasked: RecentMediaList = { access: 'unasked', items: [] };

afterEach(() => {
  platform.recentMedia.mockReset();
  localStorage.clear();
});

test('photo access is offered with its reason and asked for only on Continue', async () => {
  const user = userEvent.setup();
  platform.recentMedia.mockImplementation((_limit, request) =>
    Promise.resolve(request ? { access: 'granted', items: [photo] } : unasked)
  );
  render(RecentMediaStrip, { onFile: vi.fn() });

  const allow = await screen.findByRole('button', { name: 'Continue' });
  expect(screen.getByText(/Photos button works without/)).toBeInTheDocument();
  expect(platform.recentMedia).toHaveBeenCalledExactlyOnceWith(24, false);

  await user.click(allow);

  expect(platform.recentMedia).toHaveBeenLastCalledWith(24, true);
  expect(await screen.findByRole('button', { name: 'cat.jpg' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Continue' })).toBeNull();
});

test('turning the offer down hides it for good', async () => {
  const user = userEvent.setup();
  platform.recentMedia.mockResolvedValue(unasked);
  const first = render(RecentMediaStrip, { onFile: vi.fn() });
  await user.click(await screen.findByRole('button', { name: 'Not now' }));
  expect(screen.queryByRole('button', { name: 'Continue' })).toBeNull();
  first.unmount();

  render(RecentMediaStrip, { onFile: vi.fn() });
  await vi.waitFor(() => {
    expect(platform.recentMedia).toHaveBeenCalledTimes(2);
  });
  expect(screen.queryByRole('button', { name: 'Continue' })).toBeNull();
  expect(platform.recentMedia).not.toHaveBeenCalledWith(24, true);
});

test('refusing the system prompt stops the offer', async () => {
  const user = userEvent.setup();
  platform.recentMedia.mockResolvedValue(unasked);
  render(RecentMediaStrip, { onFile: vi.fn() });

  await user.click(await screen.findByRole('button', { name: 'Continue' }));

  await vi.waitFor(() => {
    expect(screen.queryByRole('button', { name: 'Continue' })).toBeNull();
  });
});

test('with access already given the row lists without asking', async () => {
  platform.recentMedia.mockResolvedValue({ access: 'granted', items: [photo] });
  render(RecentMediaStrip, { onFile: vi.fn() });

  expect(await screen.findByRole('button', { name: 'cat.jpg' })).toBeInTheDocument();
  expect(platform.recentMedia).toHaveBeenCalledExactlyOnceWith(24, false);
  expect(screen.queryByText(/only the photos you allowed/i)).toBeNull();
});

test('partial access says the row is not the whole library and lets Android change it', async () => {
  const user = userEvent.setup();
  platform.recentMedia.mockResolvedValue({ access: 'limited', items: [photo] });
  render(RecentMediaStrip, { onFile: vi.fn() });

  expect(await screen.findByText(/only the photos you allowed/i)).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Change' }));
  expect(platform.recentMedia).toHaveBeenLastCalledWith(24, true);
});

test('iOS has no change button, since its own prompt offers that', async () => {
  os.android = false;
  platform.recentMedia.mockResolvedValue({ access: 'limited', items: [photo] });
  render(RecentMediaStrip, { onFile: vi.fn() });

  expect(await screen.findByText(/only the photos you allowed/i)).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Change' })).toBeNull();
  os.android = true;
});

test('refused access shows nothing', async () => {
  platform.recentMedia.mockResolvedValue({ access: 'denied', items: [] });
  render(RecentMediaStrip, { onFile: vi.fn() });
  await vi.waitFor(() => {
    expect(platform.recentMedia).toHaveBeenCalledOnce();
  });

  expect(screen.queryByRole('button')).toBeNull();
});
