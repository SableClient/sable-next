// @vitest-environment happy-dom

import { mount, tick, unmount } from 'svelte';
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
  document.body.replaceChildren();
  localStorage.clear();
  setPreference('memberSort', 'name-asc');
  setPreference('groupMembersByPresence', true);
  globalThis.IntersectionObserver = observerBackup;
});

test('sorts members by power then name and opens their profile', async () => {
  const onMemberProfile = vi.fn();
  const instance = mount(MembersDrawer, {
    target: document.body,
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

  const members = [
    ...document.querySelectorAll<HTMLButtonElement>('.member.member-identity-button'),
  ];
  expect(members.map((member) => member.querySelector('.member-name')?.textContent)).toEqual([
    'Amy',
    'Bob',
    'Zoe',
  ]);
  members[0]?.click();
  expect(onMemberProfile).toHaveBeenCalledWith('@amy:example.org', members[0]);
  await unmount(instance);
});

test('uses a role tag for its group, member colour and emoji', async () => {
  const instance = mount(MembersDrawer, {
    target: document.body,
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

  expect(document.querySelector('.group-label')?.textContent).toBe('🛡️Sentinel');
  expect(document.querySelector('.member-identity-role-icon')?.textContent).toBe('🛡️');
  expect(document.querySelector('.member-name')?.getAttribute('style')).toContain('#ff0000');
  await unmount(instance);
});

test('waits for room role tags instead of briefly rendering default labels', async () => {
  const instance = mount(MembersDrawer, {
    target: document.body,
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

  expect(document.querySelector('.status')?.textContent).toContain('Loading members');
  expect(document.querySelector('.group-label')).toBeNull();
  await unmount(instance);
});

test('resizes the desktop drawer with the keyboard', async () => {
  const instance = mount(MembersDrawer, {
    target: document.body,
    props: { loading: false, members: [], onClose: vi.fn(), onMemberProfile: vi.fn() },
  });
  await tick();

  const drawer = document.querySelector<HTMLElement>('.members-drawer');
  const handle = document.querySelector<HTMLButtonElement>('.resize-handle');
  handle?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
  await tick();

  expect(drawer?.style.width).toBe('282px');
  await unmount(instance);
});

test('reopens the desktop drawer at the width it was resized to', async () => {
  const props = { loading: false, members: [], onClose: vi.fn(), onMemberProfile: vi.fn() };
  const first = mount(MembersDrawer, { target: document.body, props });
  await tick();
  document
    .querySelector<HTMLButtonElement>('.resize-handle')
    ?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
  await tick();
  await unmount(first);

  const second = mount(MembersDrawer, { target: document.body, props });
  await tick();

  expect(document.querySelector<HTMLElement>('.members-drawer')?.style.width).toBe('282px');
  await unmount(second);
});

test('honours the sort preference and fetches the membership a filter names', async () => {
  setPreference('memberSort', 'name-desc');
  const loadMembership = vi.fn(() => Promise.resolve([]));
  const instance = mount(MembersDrawer, {
    target: document.body,
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

  const names = [...document.querySelectorAll('.member .member-name')].map(
    (node) => node.textContent
  );
  expect(names).toEqual(['Zoe', 'Amy']);
  expect(loadMembership).not.toHaveBeenCalled();
  await unmount(instance);
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
  const instance = mount(MembersDrawer, {
    target: document.body,
    props: { loading: false, members, onClose: vi.fn(), onMemberProfile: vi.fn() },
  });
  await tick();

  expect(document.querySelectorAll('.member.member-identity-button')).toHaveLength(30);
  expect(document.querySelector('.load-sentinel')).not.toBeNull();

  observers[0]([{ isIntersecting: true }] as IntersectionObserverEntry[], {} as never);
  await tick();

  expect(document.querySelectorAll('.member.member-identity-button')).toHaveLength(40);
  expect(document.querySelector('.load-sentinel')).toBeNull();
  await unmount(instance);
});

test('sinks members without presence under offline and drops service members', async () => {
  offline.add('@zoe:example.org');
  const instance = mount(MembersDrawer, {
    target: document.body,
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

  const names = [...document.querySelectorAll('.member .member-name')].map(
    (node) => node.textContent
  );
  expect(names).toEqual(['Amy', 'Zoe']);
  expect([...document.querySelectorAll('.group-label')].map((node) => node.textContent)).toEqual([
    'Member',
    'Offline',
  ]);
  expect(document.querySelector('header p')?.textContent).toBe('2 members');
  await unmount(instance);
});

test('keeps power-level groups when presence grouping is off', async () => {
  setPreference('groupMembersByPresence', false);
  offline.add('@zoe:example.org');
  const instance = mount(MembersDrawer, {
    target: document.body,
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

  expect([...document.querySelectorAll('.group-label')].map((node) => node.textContent)).toEqual([
    'Admin',
    'Member',
  ]);
  await unmount(instance);
});
