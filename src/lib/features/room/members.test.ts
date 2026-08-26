import { expect, test } from 'vitest';

import {
  findMember,
  isCaption,
  memberAvatar,
  memberName,
  personaWithColor,
  stripReplyFallback,
} from './members.js';

import type { MemberView } from '#src/generated/MemberView';
import type { PerMessageProfileView } from '#src/generated/PerMessageProfileView';

const members = [
  { user_id: '@erwan:example.org', display_name: 'Erwan', avatar_url: 'mxc://a' },
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
  expect(memberNameOf('@erwan:example.org')).toBe('Erwan');
  expect(memberNameOf('@bob:example.org')).toBe('@bob:example.org');
  expect(memberNameOf('@nobody:example.org')).toBe('@nobody:example.org');
});

function memberNameOf(userId: string): string {
  return memberName(members, userId);
}

test('findMember treats a null user id as no member rather than searching', () => {
  expect(findMember(members, null)).toBeUndefined();
  expect(findMember(members, undefined)).toBeUndefined();
  expect(findMember(members, '@erwan:example.org')?.display_name).toBe('Erwan');
});

test('memberAvatar returns null rather than the id when there is no avatar', () => {
  expect(memberAvatar(members, '@erwan:example.org')).toBe('mxc://a');
  expect(memberAvatar(members, '@bob:example.org')).toBeNull();
});

test('a persona counts as tinted only when it carries a colour', () => {
  expect(personaWithColor(null)).toBeNull();
  expect(personaWithColor(persona({}))).toBeNull();
  expect(personaWithColor(persona({ color_on_light: '#fff' }))).not.toBeNull();
  expect(personaWithColor(persona({ color_on_dark: '#000' }))).not.toBeNull();
});

test('a bare filename is not treated as a caption', () => {
  expect(isCaption('photo.png')).toBe(false);
  expect(isCaption('holiday.jpeg')).toBe(false);
  expect(isCaption('look at this photo.png')).toBe(true);
  expect(isCaption('a caption')).toBe(true);
});

test('a reply fallback is stripped by display name in either form', () => {
  const erwan = persona({ display_name: 'Erwan' });

  expect(stripReplyFallback('Erwan: hello', erwan)).toBe('hello');
  expect(stripReplyFallback('<Erwan> hello', erwan)).toBe('hello');
  expect(stripReplyFallback('hello', erwan)).toBe('hello');
});

test('a fallback-bearing persona strips up to the first separator', () => {
  const anon = persona({ has_fallback: true });

  expect(stripReplyFallback('someone: hello', anon)).toBe('hello');
  expect(stripReplyFallback('no separator here', anon)).toBe('no separator here');
});

test('no persona leaves the body untouched', () => {
  expect(stripReplyFallback('Erwan: hello', null)).toBe('Erwan: hello');
});
