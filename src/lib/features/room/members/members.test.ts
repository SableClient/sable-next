import { expect, test } from 'vitest';

import {
  findMember,
  memberAvatar,
  memberIdentity,
  memberName,
  personaWithColor,
  senderDisplayColors,
  stripReplyFallback,
} from './members.js';

import type { MemberView, PerMessageProfileView, ProfileView } from '#src/generated/protocol';
import { setPreference } from '#lib/settings/preferences.svelte.js';
import { nameColorOnDark, nameColorOnLight } from '#lib/ui/primitives/readable-color.js';

const members = [
  { user_id: '@kris:example.org', display_name: 'Kris', avatar_url: 'mxc://a' },
  { user_id: '@bob:example.org', display_name: null, avatar_url: null },
] as unknown as MemberView[];

const persona = (overrides: Partial<PerMessageProfileView>): PerMessageProfileView =>
  ({
    display_name: null,
    avatar_url: null,
    color_on_light: null,
    color_on_dark: null,
    has_fallback: false,
    ...overrides,
  }) as PerMessageProfileView;

test('a missing or absent member falls back to the user id', () => {
  expect(memberNameOf('@kris:example.org')).toBe('Kris');
  expect(memberNameOf('@bob:example.org')).toBe('@bob:example.org');
  expect(memberNameOf('@nobody:example.org')).toBe('@nobody:example.org');
});

function memberNameOf(userId: string): string {
  return memberName(members, userId);
}

test('findMember treats a null user id as no member rather than searching', () => {
  expect(findMember(members, null)).toBeUndefined();
  expect(findMember(members, undefined)).toBeUndefined();
  expect(findMember(members, '@kris:example.org')?.display_name).toBe('Kris');
});

test('memberAvatar returns null rather than the id when there is no avatar', () => {
  expect(memberAvatar(members, '@kris:example.org')).toBe('mxc://a');
  expect(memberAvatar(members, '@bob:example.org')).toBeNull();
});

test('memberIdentity projects the id, name and avatar with the same fallbacks', () => {
  expect(memberIdentity(members, '@kris:example.org')).toEqual({
    userId: '@kris:example.org',
    name: 'Kris',
    avatar: 'mxc://a',
  });
  expect(memberIdentity(members, '@nobody:example.org')).toEqual({
    userId: '@nobody:example.org',
    name: '@nobody:example.org',
    avatar: null,
  });
});

test('a persona counts as tinted only when it carries a colour', () => {
  expect(personaWithColor(null)).toBeNull();
  expect(personaWithColor(persona({}))).toBeNull();
  expect(personaWithColor(persona({ color_on_light: '#fff' }))).not.toBeNull();
  expect(personaWithColor(persona({ color_on_dark: '#000' }))).not.toBeNull();
});

test('hiding profile colours lets the role colour show, except on your own name', () => {
  const profile = {
    name_color_light: '#2f5a1f',
    name_color_dark: '#9fd07c',
  } as ProfileView;
  try {
    setPreference('renderProfileColors', false);
    expect(senderDisplayColors('@bob:example.org', profile, null, false, null, '#0088ff')).toEqual(
      expect.objectContaining({
        nameColorLight: nameColorOnLight('#0088ff'),
        nameColorDark: nameColorOnDark('#0088ff'),
      })
    );
    expect(senderDisplayColors('@me:example.org', profile, null, true, null, '#0088ff')).toEqual(
      expect.objectContaining({ nameColorLight: '#2f5a1f', nameColorDark: '#9fd07c' })
    );

    setPreference('renderProfileColors', true);
    expect(senderDisplayColors('@bob:example.org', profile, null, false, null, '#0088ff')).toEqual(
      expect.objectContaining({ nameColorLight: '#2f5a1f', nameColorDark: '#9fd07c' })
    );
  } finally {
    setPreference('renderProfileColors', true);
  }
});

test('a reply fallback is stripped by display name in either form', () => {
  const kris = persona({ display_name: 'Kris' });

  expect(stripReplyFallback('Kris: hello', kris)).toBe('hello');
  expect(stripReplyFallback('<Kris> hello', kris)).toBe('hello');
  expect(stripReplyFallback('hello', kris)).toBe('hello');
});

test('a fallback-bearing persona strips up to the first separator', () => {
  const anon = persona({ has_fallback: true });

  expect(stripReplyFallback('someone: hello', anon)).toBe('hello');
  expect(stripReplyFallback('no separator here', anon)).toBe('no separator here');
});

test('no persona leaves the body untouched', () => {
  expect(stripReplyFallback('Kris: hello', null)).toBe('Kris: hello');
});
