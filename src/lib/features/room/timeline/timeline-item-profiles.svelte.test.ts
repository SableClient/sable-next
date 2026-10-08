import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import type { CoreClient } from '#lib/core/client.svelte.js';
import type { ProfileView } from '#src/generated/protocol';

import { TimelineItemProfiles } from './timeline-item-profiles.svelte.js';

const profile = (display_name: string) => ({ display_name }) as ProfileView;

function setup(cached: ProfileView | null = null) {
  let notify: (userId: string) => void = () => {};
  const userProfile = vi.fn<(userId: string) => Promise<ProfileView>>();
  const core = {
    userProfile,
    cachedUserProfile: () => cached,
    onProfileChanged: (listener: (userId: string) => void) => {
      notify = listener;
      return () => {};
    },
  } as unknown as CoreClient;
  return {
    profiles: new TimelineItemProfiles(core),
    userProfile,
    notify: (id: string) => {
      notify(id);
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

test('a failed lookup is retried', async () => {
  const { profiles, userProfile } = setup();
  userProfile.mockRejectedValueOnce(new Error('limited')).mockResolvedValueOnce(profile('a'));
  profiles.sync('@a:x', null, false);
  await vi.advanceTimersByTimeAsync(300);
  expect(profiles.sender).toBeNull();
  await vi.advanceTimersByTimeAsync(3000);
  expect(profiles.sender).toEqual(profile('a'));
  profiles.dispose();
});

test('a profile change refetches while keeping the old profile on screen', async () => {
  const { profiles, userProfile, notify } = setup();
  userProfile.mockResolvedValueOnce(profile('old')).mockResolvedValueOnce(profile('new'));
  profiles.sync('@a:x', null, false);
  await vi.advanceTimersByTimeAsync(300);
  expect(profiles.sender).toEqual(profile('old'));
  notify('@a:x');
  expect(profiles.sender).toEqual(profile('old'));
  await vi.advanceTimersByTimeAsync(300);
  expect(profiles.sender).toEqual(profile('new'));
  profiles.dispose();
});

test('a change for another user is ignored', async () => {
  const { profiles, userProfile, notify } = setup();
  userProfile.mockResolvedValue(profile('a'));
  profiles.sync('@a:x', null, false);
  await vi.advanceTimersByTimeAsync(300);
  notify('@b:x');
  await vi.advanceTimersByTimeAsync(300);
  expect(userProfile).toHaveBeenCalledTimes(1);
  profiles.dispose();
});

test('a cached profile is shown at once without a lookup', () => {
  const { profiles, userProfile } = setup(profile('cached'));
  profiles.sync('@a:x', null, false);
  expect(profiles.sender).toEqual(profile('cached'));
  expect(userProfile).not.toHaveBeenCalled();
  profiles.dispose();
});

test('a row torn down before the lookup delay never asks', async () => {
  const { profiles, userProfile } = setup();
  profiles.sync('@a:x', null, false);
  profiles.dispose();
  await vi.advanceTimersByTimeAsync(1000);
  expect(userProfile).not.toHaveBeenCalled();
});
