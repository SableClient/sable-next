// @vitest-environment happy-dom

import { mount, tick, unmount } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';

vi.mock('#lib/core/context.js');

vi.mock('#lib/rooms/presence.svelte.js', async () => {
  const actual = await vi.importActual<typeof import('#lib/rooms/presence.svelte.js')>(
    '#lib/rooms/presence.svelte.js'
  );
  return { ...actual, usePresenceStore: () => ({ get: () => null }) };
});

import { setPreference } from '#lib/settings/preferences.svelte.js';

import MembersDrawer from './MembersDrawer.svelte';

const observerBackup = globalThis.IntersectionObserver;

afterEach(() => {
  document.body.replaceChildren();
  setPreference('memberSort', 'name-asc');
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
        },
        {
          user_id: '@bob:example.org',
          display_name: 'Bob',
          avatar_url: null,
          power_level: 100,
          membership: 'join' as const,
          member_ts: null,
          kicked: false,
        },
        {
          user_id: '@amy:example.org',
          display_name: 'Amy',
          avatar_url: null,
          power_level: 100,
          membership: 'join' as const,
          member_ts: null,
          kicked: false,
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
        },
        {
          user_id: '@amy:example.org',
          display_name: 'Amy',
          avatar_url: null,
          power_level: 0,
          membership: 'join' as const,
          member_ts: null,
          kicked: false,
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
