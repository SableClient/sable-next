// @vitest-environment happy-dom

import { render, screen } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { tick } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';

vi.mock('#lib/core/context.js');

const offline = new Set<string>();

vi.mock('#lib/rooms/presence.svelte.js', async () => {
  const actual = await vi.importActual<typeof import('#lib/rooms/presence.svelte.js')>(
    '#lib/rooms/presence.svelte.js'
  );
  return {
    ...actual,
    usePresenceStore: () => ({
      get: () => null,
      peek: (userId: string) =>
        offline.has(userId)
          ? null
          : { presence: 'online', statusMessage: null, lastActiveAgo: null, receivedAt: 0 },
    }),
  };
});

import { setPreference } from '#lib/settings/preferences.svelte.js';

import MembersDrawer from './MembersDrawer.svelte';

const observerBackup = globalThis.IntersectionObserver;

afterEach(() => {
  offline.clear();
  localStorage.clear();
  setPreference('memberSort', 'name-asc');
  setPreference('groupMembersByPresence', true);
  globalThis.IntersectionObserver = observerBackup;
});

const user = userEvent.setup();
const memberNames = () =>
  screen
    .queryAllByRole('button', { name: /^Open .*'s profile$/ })
    .map((member) => member.querySelector('.member-name')?.textContent);
const groups = () =>
  screen.queryAllByRole('heading', { level: 3 }).map((heading) => heading.textContent);
const drawer = () => screen.getByRole('complementary');

test('sorts members by power then name and opens their profile', async () => {
  const onMemberProfile = vi.fn();
  render(MembersDrawer, {
    props: {
      loading: false,
      members: [
        {
          user_id: '@zoe:example.org',
          display_name: 'Zoe',
          avatar_url: null,
          power_level: 0,
          membership: 'join' as const,
          member_ts: null,
          kicked: false,
          service: false,
        },
        {
          user_id: '@bob:example.org',
          display_name: 'Bob',
          avatar_url: null,
          power_level: 100,
          membership: 'join' as const,
          member_ts: null,
          kicked: false,
          service: false,
        },
        {
          user_id: '@amy:example.org',
          display_name: 'Amy',
          avatar_url: null,
          power_level: 100,
          membership: 'join' as const,
          member_ts: null,
          kicked: false,
          service: false,
        },
      ],
      onClose: vi.fn(),
      onMemberProfile,
    },
  });
  await tick();

  expect(memberNames()).toEqual(['Amy', 'Bob', 'Zoe']);
  const amy = screen.getByRole('button', { name: "Open Amy's profile" });
  await user.click(amy);
  expect(onMemberProfile).toHaveBeenCalledWith('@amy:example.org', amy);
});

test('uses a role tag for its group, member colour and emoji', async () => {
  render(MembersDrawer, {
    props: {
      loading: false,
      members: [
        {
          user_id: '@amy:example.org',
          display_name: 'Amy',
          avatar_url: null,
          power_level: 50,
          membership: 'join' as const,
          member_ts: null,
          kicked: false,
          service: false,
        },
      ],
      powerTags: { 50: { name: 'Sentinel', color: '#ff0000', icon: '🛡️' } },
      onClose: vi.fn(),
      onMemberProfile: vi.fn(),
    },
  });
  await tick();

  expect(groups()).toEqual(['🛡️Sentinel']);
  expect(document.querySelector('.member-identity-row .role-tag-icon')).not.toBeInTheDocument();
  expect(screen.getByText('Amy')).toHaveAttribute('style', expect.stringContaining('#cf0000'));
});

test('waits for room role tags instead of briefly rendering default labels', async () => {
  render(MembersDrawer, {
    props: {
      loading: false,
      members: [
        {
          user_id: '@amy:example.org',
          display_name: 'Amy',
          avatar_url: null,
          power_level: 50,
          membership: 'join' as const,
          member_ts: null,
          kicked: false,
          service: false,
        },
      ],
      powerTags: null,
      onClose: vi.fn(),
      onMemberProfile: vi.fn(),
    },
  });
  await tick();

  expect(screen.getByText(/Loading members/)).toBeInTheDocument();
  expect(groups()).toEqual([]);
});

test('resizes the desktop drawer with the keyboard', async () => {
  render(MembersDrawer, {
    props: { loading: false, members: [], onClose: vi.fn(), onMemberProfile: vi.fn() },
  });
  await tick();

  screen.getByRole('slider').focus();
  await user.keyboard('{ArrowLeft}');

  expect(drawer().style.width).toBe('282px');
});

test('reopens the desktop drawer at the width it was resized to', async () => {
  const props = { loading: false, members: [], onClose: vi.fn(), onMemberProfile: vi.fn() };
  const first = render(MembersDrawer, { props });
  await tick();
  screen.getByRole('slider').focus();
  await user.keyboard('{ArrowLeft}');
  first.unmount();

  render(MembersDrawer, { props });
  await tick();

  expect(drawer().style.width).toBe('282px');
});

test('honours the sort preference and fetches the membership a filter names', async () => {
  setPreference('memberSort', 'name-desc');
  const loadMembership = vi.fn(() => Promise.resolve([]));
  render(MembersDrawer, {
    props: {
      loading: false,
      members: [
        {
          user_id: '@zoe:example.org',
          display_name: 'Zoe',
          avatar_url: null,
          power_level: 0,
          membership: 'join' as const,
          member_ts: null,
          kicked: false,
          service: false,
        },
        {
          user_id: '@amy:example.org',
          display_name: 'Amy',
          avatar_url: null,
          power_level: 0,
          membership: 'join' as const,
          member_ts: null,
          kicked: false,
          service: false,
        },
      ],
      loadMembership,
      onClose: vi.fn(),
      onMemberProfile: vi.fn(),
    },
  });
  await tick();

  expect(memberNames()).toEqual(['Zoe', 'Amy']);
  expect(loadMembership).not.toHaveBeenCalled();
});

test('renders a first page of members and grows when the sentinel shows', async () => {
  const observers: IntersectionObserverCallback[] = [];
  globalThis.IntersectionObserver = class {
    disconnect = vi.fn();
    observe = vi.fn();
    unobserve = vi.fn();
    takeRecords = vi.fn(() => []);
    root = null;
    rootMargin = '';
    thresholds = [];
    constructor(callback: IntersectionObserverCallback) {
      observers.push(callback);
    }
  } as unknown as typeof IntersectionObserver;

  const members = Array.from({ length: 40 }, (_, index) => ({
    user_id: `@user${String(index).padStart(2, '0')}:example.org`,
    display_name: `User ${index}`,
    avatar_url: null,
    power_level: 0,
    membership: 'join' as const,
    member_ts: null,
    kicked: false,
    service: false,
  }));
  render(MembersDrawer, {
    props: { loading: false, members, onClose: vi.fn(), onMemberProfile: vi.fn() },
  });
  await tick();

  expect(memberNames()).toHaveLength(30);
  expect(document.querySelector('.load-sentinel')).toBeInTheDocument();

  observers[0]([{ isIntersecting: true }] as IntersectionObserverEntry[], {} as never);
  await tick();

  expect(memberNames()).toHaveLength(40);
  expect(document.querySelector('.load-sentinel')).not.toBeInTheDocument();
});

test('sinks members without presence under offline and drops service members', async () => {
  offline.add('@zoe:example.org');
  offline.add('@amy:example.org');
  render(MembersDrawer, {
    props: {
      loading: false,
      members: [
        {
          user_id: '@zoe:example.org',
          display_name: 'Zoe',
          avatar_url: null,
          power_level: 100,
          membership: 'join' as const,
          member_ts: null,
          kicked: false,
          service: false,
        },
        {
          user_id: '@amy:example.org',
          display_name: 'Amy',
          avatar_url: null,
          power_level: 0,
          membership: 'join' as const,
          member_ts: null,
          kicked: false,
          service: false,
        },
        {
          user_id: '@bot:example.org',
          display_name: 'Bot',
          avatar_url: null,
          power_level: 100,
          membership: 'join' as const,
          member_ts: null,
          kicked: false,
          service: true,
        },
      ],
      onClose: vi.fn(),
      onMemberProfile: vi.fn(),
    },
  });
  await tick();

  expect(memberNames()).toEqual(['Zoe', 'Amy']);
  expect(groups()).toEqual(['Admin', 'Offline']);
  expect(screen.getByText('2 members')).toBeInTheDocument();
});

test('keeps power-level groups when presence grouping is off', async () => {
  setPreference('groupMembersByPresence', false);
  offline.add('@zoe:example.org');
  render(MembersDrawer, {
    props: {
      loading: false,
      members: [
        {
          user_id: '@zoe:example.org',
          display_name: 'Zoe',
          avatar_url: null,
          power_level: 100,
          membership: 'join' as const,
          member_ts: null,
          kicked: false,
          service: false,
        },
        {
          user_id: '@amy:example.org',
          display_name: 'Amy',
          avatar_url: null,
          power_level: 0,
          membership: 'join' as const,
          member_ts: null,
          kicked: false,
          service: false,
        },
      ],
      onClose: vi.fn(),
      onMemberProfile: vi.fn(),
    },
  });
  await tick();

  expect(groups()).toEqual(['Admin', 'Member']);
});
