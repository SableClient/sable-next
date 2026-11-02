// @vitest-environment happy-dom

import { render, screen, within } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { afterEach, expect, test, vi, type Mock } from 'vitest';

const presence = vi.hoisted(() => ({
  entry: null as {
    presence: 'online' | 'unavailable' | 'offline';
    statusMessage: string | null;
  } | null,
}));

vi.mock('#lib/core/context.js');

import { core } from '#lib/core/__mocks__/context.js';

vi.mock('#lib/rooms/presence.svelte.js', async () => {
  const actual = await vi.importActual<typeof import('#lib/rooms/presence.svelte.js')>(
    '#lib/rooms/presence.svelte.js'
  );
  return {
    ...actual,
    usePresenceStore: () => ({ get: () => presence.entry, peek: () => presence.entry }),
  };
});

import MemberIdentityRow from './MemberIdentityRow.svelte';

const members = [
  {
    user_id: '@bob:example.org',
    display_name: 'Bob',
    real_name: 'Bob',
    real_avatar_url: null,
    avatar_url: null,
    power_level: 0,
    membership: 'join' as const,
    member_ts: null,
    kicked: false,
    service: false,
  },
];

function profileFor(userId: string) {
  return {
    user_id: userId,
    display_name: 'Bob',
    real_name: 'Bob',
    real_avatar_url: null,
    avatar_url: null,
    bio: null,
    hero_color: null,
    hero_brightness: null,
    banner_url: null,
    status: null,
    pronouns: [],
    timezone: null,
    name_color_light: null,
    name_color_dark: null,
    animal: null,
    extra: [],
  };
}

afterEach(() => {
  core.userProfile.mockReset();
  core.userProfile.mockRejectedValue(new Error('profile unavailable'));
  core.onProfileChanged.mockImplementation(() => () => {});
  presence.entry = null;
});

test('tints the name from the profile and opens the profile card from the row', async () => {
  core.userProfile.mockResolvedValue({
    user_id: '@bob:example.org',
    display_name: 'Bob',
    avatar_url: null,
    bio: null,
    hero_color: null,
    hero_brightness: null,
    banner_url: null,
    status: null,
    pronouns: [{ summary: 'he/him', language: null }],
    timezone: null,
    name_color_light: '#4f7a3a',
    name_color_dark: '#9fd07c',
    animal: null,
    extra: [],
  });
  const user = userEvent.setup();
  const onProfile = vi.fn();
  render(MemberIdentityRow, { userId: '@bob:example.org', members, onProfile });

  const row = screen.getByRole('button', { name: 'Bob' });
  await vi.waitFor(() => {
    expect(within(row).getByText('Bob')).toHaveClass('tinted');
  });
  expect(within(row).queryByText('he/him')).toBeNull();
  await user.click(row);
  expect(onProfile).toHaveBeenCalledWith('@bob:example.org', row);
});

async function mountRow(props: Record<string, unknown>) {
  const instance = render(MemberIdentityRow, {
    props: { userId: '@bob:example.org', members, ...props },
  });
  await vi.waitFor(() => {
    expect(core.userProfile).toHaveBeenCalled();
  });
  await Promise.resolve();
  return instance;
}

test('shows the profile status, emoji first', async () => {
  core.userProfile.mockResolvedValue({
    ...profileFor('@bob:example.org'),
    status: { text: 'Shipping', emoji: '\u{1F680}' },
  });
  await mountRow({ showStatus: true });

  expect(await screen.findByText('Shipping')).toHaveTextContent('\u{1F680}Shipping');
});

test('follows profile changes for the shown user', async () => {
  const listeners: ((userId: string) => void)[] = [];
  (
    core.onProfileChanged as Mock<(listener: (userId: string) => void) => () => void>
  ).mockImplementation((listener) => {
    listeners.push(listener);
    return () => {};
  });
  core.userProfile.mockResolvedValue({
    ...profileFor('@bob:example.org'),
    status: { text: 'Shipping', emoji: null },
  });
  await mountRow({ showStatus: true });
  expect(await screen.findByText('Shipping')).toBeInTheDocument();

  core.userProfile.mockResolvedValue({
    ...profileFor('@bob:example.org'),
    status: { text: 'On holiday', emoji: null },
  });
  for (const listener of listeners) listener('@bob:example.org');

  expect(await screen.findByText('On holiday')).toBeInTheDocument();
  expect(screen.queryByText('Shipping')).not.toBeInTheDocument();
});

test('offers the whole status on hover, since the row truncates it', async () => {
  const text = 'Shipping the release candidate before the weekend, back on Monday';
  core.userProfile.mockResolvedValue({
    ...profileFor('@bob:example.org'),
    status: { text, emoji: '\u{1F680}' },
  });
  await mountRow({ showStatus: true });

  await userEvent.setup().hover(await screen.findByText(text));
  expect(await screen.findByText(`\u{1F680} ${text}`)).toBeInTheDocument();
});

test('renders a medium presence marker', async () => {
  presence.entry = { presence: 'online', statusMessage: null };
  await mountRow({});

  const dot = document.querySelector('[data-presence="online"]');
  expect(dot).toHaveClass('presence-dot-medium');
  expect(dot).not.toHaveClass('presence-dot-large');
});

test('falls back to the presence message when the profile has no status', async () => {
  core.userProfile.mockResolvedValue({ ...profileFor('@bob:example.org'), status: null });
  presence.entry = { presence: 'online', statusMessage: 'In a meeting' };
  await mountRow({ showStatus: true });

  expect(await screen.findByText('In a meeting')).toBeInTheDocument();
});

test('leaves the status out unless the row asks for it', async () => {
  core.userProfile.mockResolvedValue({
    ...profileFor('@bob:example.org'),
    status: { text: 'Shipping', emoji: null },
  });
  await mountRow({});

  expect(screen.queryByText('Shipping')).not.toBeInTheDocument();
});
