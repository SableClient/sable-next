// @vitest-environment happy-dom

import { render, screen } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { tick, type ComponentProps } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';
import type { MemberView } from '#src/generated/protocol';
import { core } from '#lib/core/__mocks__/context.js';
import TooltipProvider from '#lib/ui/primitives/TooltipProvider.svelte';

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

import { preferences, setPreference } from '#lib/settings/preferences.svelte.js';
import {
  contrastRatio,
  roleColorOnDark,
  roleColorOnLight,
} from '#lib/ui/primitives/readable-color.js';

import MembersDrawer from './MembersDrawer.svelte';
import { FOUNDER_POWER_LEVEL } from '../settings/power-level-tags';

const observerBackup = globalThis.IntersectionObserver;

afterEach(() => {
  core.memberPreviews.clear();
  offline.clear();
  localStorage.clear();
  setPreference('memberSort', 'name-asc');
  setPreference('groupMembersByPresence', true);
  globalThis.IntersectionObserver = observerBackup;
});

const user = userEvent.setup();
const memberNames = () =>
  Array.from(
    document.querySelectorAll('.member-identity-button'),
    (member) => member.querySelector('.member-name')?.textContent
  );
const groups = () =>
  screen.queryAllByRole('heading', { level: 3 }).map((heading) => heading.textContent);
const drawer = () => screen.getByRole('complementary');

function renderDrawer(props: Partial<ComponentProps<typeof MembersDrawer>> = {}) {
  return render(
    MembersDrawer,
    {
      members: [],
      loading: false,
      onMemberProfile: vi.fn(),
      ...props,
    },
    { wrapper: TooltipProvider }
  );
}

function member(name: string, level = 0): MemberView {
  return {
    user_id: `@${name.toLowerCase().replaceAll(' ', '')}:example.org`,
    display_name: name,
    real_name: name,
    avatar_url: null,
    real_avatar_url: null,
    power_level: level,
    membership: 'join',
    member_ts: null,
    kicked: false,
    service: false,
  };
}

async function renderPreview(props: Partial<ComponentProps<typeof MembersDrawer>> = {}) {
  const view = renderDrawer({ roomId: '!room:test', members: [member('Amy')], ...props });
  await tick();
  await view.rerender({ members: [], loading: true });
  return view;
}

test('shows a room preview while members and roles reload', async () => {
  const props = {
    roomId: '!first:test',
    members: Array.from({ length: 60 }, (_, i) => member(`User ${i}`, 50)),
    powerTags: { 50: { name: 'Helpers', color: '#ff0000', icon: null } },
    onMemberProfile: vi.fn(),
  };
  const { rerender } = await renderPreview(props);
  const initial = memberNames();
  expect(initial).toHaveLength(30);

  const pending = { ...props, loading: true, members: [], powerTags: null };
  await rerender({ ...pending, roomId: '!second:test' });
  expect(memberNames()).toEqual([]);
  expect(screen.getByText(/Loading members/)).toBeInTheDocument();

  await rerender(pending);
  expect(memberNames()).toEqual(initial);
  expect(groups()).toEqual(['Helpers']);
  expect(screen.getByText('60 members')).toBeInTheDocument();
  expect(screen.queryByText(/Loading members/)).not.toBeInTheDocument();
  expect(document.querySelector('.load-sentinel')).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'User 0' }));
  expect(props.onMemberProfile).toHaveBeenCalledWith('@user0:example.org', expect.any(HTMLElement));

  await rerender({ ...props, loading: false, members: [member('Renamed', 50)] });
  expect(memberNames()).toEqual(['Renamed']);
  expect(screen.getByText('1 member')).toBeInTheDocument();
});

test('waits for full data when searching or filtering a preview', async () => {
  const props = {
    loadMembership: vi.fn(() =>
      Promise.resolve([{ ...member('Bob'), membership: 'leave' as const }])
    ),
  };
  await renderPreview(props);
  expect(memberNames()).toEqual(['Amy']);

  const search = screen.getByRole('textbox', { name: 'Search members' });
  await user.type(search, 'Bob');
  expect(memberNames()).toEqual([]);
  expect(screen.getByText(/Loading members/)).toBeInTheDocument();
  await user.clear(search);
  expect(memberNames()).toEqual(['Amy']);

  await user.click(screen.getByRole('button', { name: 'Filter members: Joined' }));
  await user.click(screen.getByRole('menuitemradio', { name: /Left/ }));
  expect(memberNames()).toEqual(['Bob']);
  expect(props.loadMembership).toHaveBeenCalledWith('leave');
});

test('drops a displayed preview when the account cache clears', async () => {
  await renderPreview();
  expect(memberNames()).toEqual(['Amy']);
  core.memberPreviews.clear();
  await tick();
  expect(memberNames()).toEqual([]);
  expect(screen.getByText(/Loading members/)).toBeInTheDocument();
});

test('skips previews after sort or grouping changes', async () => {
  const { rerender } = await renderPreview();
  expect(memberNames()).toEqual(['Amy']);
  setPreference('memberSort', 'name-desc');
  await tick();
  expect(memberNames()).toEqual([]);
  setPreference('memberSort', 'name-asc');
  await tick();
  expect(memberNames()).toEqual(['Amy']);
  setPreference('groupMembersByPresence', false);
  await tick();
  expect(memberNames()).toEqual([]);
  setPreference('groupMembersByPresence', true);
  await rerender({ alwaysListedFrom: 50 });
  expect(memberNames()).toEqual([]);
});

test('ignores old filter responses after switching rooms', async () => {
  const replies: ((members: MemberView[]) => void)[] = [];
  const loadMembership = vi.fn(() => new Promise<MemberView[]>((resolve) => replies.push(resolve)));
  const { rerender } = renderDrawer({ roomId: '!first:test', members: [], loadMembership });
  await user.click(screen.getByRole('button', { name: 'Filter members: Joined' }));
  await user.click(screen.getByRole('menuitemradio', { name: /Left/ }));
  await rerender({ roomId: '!second:test' });
  expect(loadMembership).toHaveBeenCalledTimes(2);
  replies[1]([{ ...member('Bob'), membership: 'leave' }]);
  await tick();
  expect(memberNames()).toEqual(['Bob']);
  replies[0]([{ ...member('Amy'), membership: 'leave' }]);
  await tick();
  expect(memberNames()).toEqual(['Bob']);
});

test('sorts members by power then name and opens their profile', async () => {
  const onMemberProfile = vi.fn();
  renderDrawer({
    members: [member('Zoe'), member('Bob', 100), member('Amy', 100)],
    onMemberProfile,
  });
  await tick();

  expect(memberNames()).toEqual(['Amy', 'Bob', 'Zoe']);
  const amy = screen.getByRole('button', { name: 'Amy' });
  await user.click(amy);
  expect(onMemberProfile).toHaveBeenCalledWith('@amy:example.org', amy);
  setPreference('memberSort', 'name-desc');
  await tick();
  expect(memberNames()).toEqual(['Bob', 'Amy', 'Zoe']);
});

test.each([
  { level: 50, name: 'Sentinel', icon: '🛡️' },
  { level: FOUNDER_POWER_LEVEL, name: 'Founder', icon: '👑' },
])('shows saved $name flair in the member list', async ({ level, name, icon }) => {
  renderDrawer({
    members: [member('Amy', level)],
    powerTags: { [level]: { name, color: '#ff0000', icon } },
  });
  await tick();

  expect(groups()).toEqual([`${icon}${name}`]);
  expect(document.querySelector('.member-identity-row .role-tag-icon')).not.toBeInTheDocument();
  expect(screen.getByText('Amy')).toHaveAttribute('style', expect.stringContaining('#cf0000'));
});

test('tints a role heading with its colour corrected for each theme', async () => {
  renderDrawer({ members: [member('Amy', FOUNDER_POWER_LEVEL)], powerTags: {} });
  await tick();

  const heading = screen.getByRole('heading', { level: 3 });
  expect(heading).toHaveClass('tinted');
  expect(heading.style.getPropertyValue('--name-color-on-light')).toBe(roleColorOnLight('#0000ff'));
  expect(heading.style.getPropertyValue('--name-color-on-dark')).toBe(roleColorOnDark('#0000ff'));
});

test('keeps a role heading legible when the name colour correction is off', async () => {
  const before = preferences.nameColorCorrection;
  try {
    preferences.nameColorCorrection = 'off';
    renderDrawer({ members: [member('Amy', FOUNDER_POWER_LEVEL)], powerTags: {} });
    await tick();

    const heading = screen.getByRole('heading', { level: 3 });
    const light = heading.style.getPropertyValue('--name-color-on-light');
    const dark = heading.style.getPropertyValue('--name-color-on-dark');
    expect(contrastRatio(light, '#e4e4e7')).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(dark, '#2d2c36')).toBeGreaterThanOrEqual(4.5);
  } finally {
    preferences.nameColorCorrection = before;
  }
});

test('waits for room role tags instead of briefly rendering default labels', async () => {
  renderDrawer({ members: [member('Amy', 50)], powerTags: null });
  await tick();

  expect(screen.getByText(/Loading members/)).toBeInTheDocument();
  expect(groups()).toEqual([]);
});

test('remembers the width after resizing with the keyboard', async () => {
  const first = renderDrawer();
  await tick();
  screen.getByRole('slider').focus();
  await user.keyboard('{ArrowLeft}');
  expect(drawer().style.width).toBe('282px');
  first.unmount();

  renderDrawer();
  await tick();

  expect(drawer().style.width).toBe('282px');
});

test('a membership tab loads again when the room members change', async () => {
  const loadMembership = vi.fn(() => Promise.resolve([]));
  const { rerender } = renderDrawer({ members: [], loadMembership });
  expect(loadMembership).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: 'Filter members: Joined' }));
  await user.click(screen.getByRole('menuitemradio', { name: /Left/ }));
  await tick();
  expect(loadMembership).toHaveBeenCalledTimes(1);

  await rerender({ members: [] });
  await tick();
  expect(loadMembership).toHaveBeenCalledTimes(2);
});

test('renders a first page of members and grows when the sentinel shows', async () => {
  const observers: IntersectionObserverCallback[] = [];
  globalThis.IntersectionObserver = class {
    disconnect = vi.fn();
    observe = vi.fn();
    constructor(callback: IntersectionObserverCallback) {
      observers.push(callback);
    }
  } as unknown as typeof IntersectionObserver;

  const members = Array.from({ length: 40 }, (_, index) => member(`User ${index}`));
  renderDrawer({ members });
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
  renderDrawer({
    members: [member('Zoe', 100), member('Amy'), { ...member('Bot', 100), service: true }],
  });
  await tick();

  expect(memberNames()).toEqual(['Zoe', 'Amy']);
  expect(groups()).toEqual(['Admin', 'Offline']);
  expect(screen.getByText('2 members')).toBeInTheDocument();
});

test('keeps power-level groups when presence grouping is off', async () => {
  setPreference('groupMembersByPresence', false);
  offline.add('@zoe:example.org');
  renderDrawer({ members: [member('Zoe', 100), member('Amy')] });
  await tick();

  expect(groups()).toEqual(['Admin', 'Member']);
});
