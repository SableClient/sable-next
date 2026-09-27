// @vitest-environment happy-dom

import { render, screen } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';

vi.mock('#lib/core/context.js');

import ProfileCard from './ProfileCard.svelte';

afterEach(() => {
  vi.restoreAllMocks();
});

function cover(container: HTMLElement): HTMLElement | null {
  return container.querySelector('.profile-card-banner');
}

test('uses the avatar as a blurred cover when there is no banner', () => {
  const { container } = render(ProfileCard, {
    displayName: 'Ana',
    userId: '@ana:example.org',
    color: '#abcdef',
    avatarUrl: 'mxc://example.org/ana',
  });

  expect(cover(container)).toHaveClass('profile-card-banner-fallback');
});

test('keeps a real banner unblurred', () => {
  const { container } = render(ProfileCard, {
    displayName: 'Ana',
    userId: '@ana:example.org',
    color: '#abcdef',
    avatarUrl: 'mxc://example.org/ana',
    bannerUrl: 'mxc://example.org/banner',
  });

  expect(cover(container)).toBeInTheDocument();
  expect(cover(container)).not.toHaveClass('profile-card-banner-fallback');
});

test('opens the banner in the viewer, as the avatar does', async () => {
  const onAvatarClick = vi.fn();
  render(ProfileCard, {
    displayName: 'Ana',
    userId: '@ana:example.org',
    color: '#abcdef',
    avatarUrl: 'mxc://example.org/ana',
    bannerUrl: 'mxc://example.org/banner',
    onAvatarClick,
  });

  await userEvent.setup().click(screen.getByRole('button', { name: "View Ana's banner" }));

  expect(onAvatarClick).toHaveBeenCalledWith('mxc://example.org/banner', 'Ana');
});

test('leaves the avatar fallback cover inert', () => {
  render(ProfileCard, {
    displayName: 'Ana',
    userId: '@ana:example.org',
    color: '#abcdef',
    avatarUrl: 'mxc://example.org/ana',
    onAvatarClick: vi.fn(),
  });

  expect(screen.queryByRole('button', { name: /banner/ })).not.toBeInTheDocument();
});

test('paints the flat colour when there is no avatar either', () => {
  const { container } = render(ProfileCard, {
    displayName: 'Ana',
    userId: '@ana:example.org',
    color: '#abcdef',
  });

  expect(cover(container)).not.toBeInTheDocument();
});

test('copies the user id when it is clicked', async () => {
  const user = userEvent.setup();
  const writeText = vi.fn(() => Promise.resolve());
  vi.spyOn(navigator, 'clipboard', 'get').mockReturnValue({ writeText } as unknown as Clipboard);
  render(ProfileCard, { displayName: 'Ana', userId: '@ana:example.org', color: '#abcdef' });

  await user.click(screen.getByRole('button', { name: '@ana:example.org' }));

  expect(writeText).toHaveBeenCalledWith('@ana:example.org');
});
