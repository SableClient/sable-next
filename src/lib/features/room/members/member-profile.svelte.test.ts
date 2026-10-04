// @vitest-environment happy-dom
import { expect, test, vi } from 'vitest';
import type { ProfileView } from '#src/generated/protocol';
import { MemberProfile } from './member-profile.svelte.js';

test('closing a profile prevents a pending failure from reopening or changing it', async () => {
  const request = Promise.withResolvers<ProfileView>();
  const profile = new MemberProfile({
    userProfile: () => request.promise,
    profiles: { peek: () => null },
  });
  const opening = profile.show('@old', document.createElement('button'));
  profile.close();
  request.reject(new Error('unavailable'));
  await opening;
  expect(profile.open).toBe(false);
  expect(profile.userId).toBeNull();
  expect(profile.anchor).toBeNull();
  expect(profile.failed).toBe(false);
});

test('a later profile remains selected when an earlier request completes', async () => {
  const old = Promise.withResolvers<ProfileView>();
  const next = { display_name: 'Next' } as ProfileView;
  const profile = new MemberProfile({
    userProfile: vi.fn().mockReturnValueOnce(old.promise).mockResolvedValueOnce(next),
    profiles: { peek: () => null },
  });
  const anchor = document.createElement('button');
  const first = profile.show('@old', anchor);
  await profile.show('@next', anchor);
  old.resolve({ display_name: 'Old' } as ProfileView);
  await first;
  expect(profile.userId).toBe('@next');
  expect(profile.profile).toEqual(next);
  expect(profile.failed).toBe(false);
});

test('a cached profile is shown at once while it is refreshed', async () => {
  const cached = { display_name: 'Cached' } as ProfileView;
  const fresh = Promise.withResolvers<ProfileView>();
  const profile = new MemberProfile({
    userProfile: () => fresh.promise,
    profiles: { peek: () => cached },
  });
  const opening = profile.show('@a', document.createElement('button'));
  expect(profile.profile).toEqual(cached);
  fresh.resolve({ display_name: 'Fresh' } as ProfileView);
  await opening;
  expect(profile.profile).toEqual({ display_name: 'Fresh' });
});
