import type { MemberView, PerMessageProfileView, ProfileView } from '#src/generated/protocol';

import { profileOverrides } from '#lib/profile/profile-overrides.svelte.js';
import { preferences } from '#lib/settings/preferences.svelte.js';
import type { SenderCosmetics } from '#lib/rooms/room-cosmetics.svelte.js';
import {
  nameColorOnDark,
  nameColorOnLight,
  roleColorOnDark,
  roleColorOnLight,
} from '#lib/ui/primitives/readable-color.js';

import { senderColor } from '../timeline/timeline-format';

export interface SenderDisplayColors {
  nameColor: string;
  nameColorLight: string | null;
  nameColorDark: string | null;
  tinted: boolean;
}

export function senderDisplayColors(
  userId: string,
  profile: ProfileView | null,
  persona: PerMessageProfileView | null = null,
  isOwn = false,
  room: SenderCosmetics | null = null,
  roleColor: string | null = null
): SenderDisplayColors {
  const override = profileOverrides.colors(userId);
  if (override === null) {
    const nameColor = isOwn ? 'var(--surface-on-container)' : senderColor(userId);
    return { nameColor, nameColorLight: null, nameColorDark: null, tinted: false };
  }
  const personaTint = personaWithColor(persona);
  const colored = isOwn || preferences.renderProfileColors ? profile : null;
  const nameColorLight =
    override?.light ??
    override?.dark ??
    personaTint?.color_on_light ??
    room?.colorOnLight ??
    colored?.name_color_light ??
    colored?.name_color_dark ??
    roleColorOnLight(roleColor);
  const nameColorDark =
    override?.dark ??
    override?.light ??
    personaTint?.color_on_dark ??
    room?.colorOnDark ??
    colored?.name_color_dark ??
    colored?.name_color_light ??
    roleColorOnDark(roleColor);
  const tinted = nameColorLight !== null || nameColorDark !== null;
  const nameColor = isOwn ? 'var(--surface-on-container)' : senderColor(userId);

  return {
    nameColor,
    nameColorLight: nameColorOnLight(nameColorLight),
    nameColorDark: nameColorOnDark(nameColorDark),
    tinted,
  };
}

const memberIndexes = new WeakMap<readonly MemberView[], Map<string, MemberView>>();

export function findMember(
  members: readonly MemberView[],
  userId: string | null | undefined
): MemberView | undefined {
  if (!userId) return undefined;

  let index = memberIndexes.get(members);
  if (!index) {
    index = new Map(members.map((member) => [member.user_id, member]));
    memberIndexes.set(members, index);
  }
  return index.get(userId);
}

export function memberName(members: readonly MemberView[], userId: string): string {
  return findMember(members, userId)?.display_name ?? userId;
}

export function memberAvatar(members: readonly MemberView[], userId: string): string | null {
  return findMember(members, userId)?.avatar_url ?? null;
}

export interface MemberIdentity {
  userId: string;
  name: string;
  avatar: string | null;
}

export function memberIdentity(members: readonly MemberView[], userId: string): MemberIdentity {
  return { userId, name: memberName(members, userId), avatar: memberAvatar(members, userId) };
}

export function personaWithColor(
  profile: PerMessageProfileView | null
): PerMessageProfileView | null {
  return profile && (profile.color_on_light ?? profile.color_on_dark) !== null ? profile : null;
}

export function stripReplyFallback(body: string, profile: PerMessageProfileView | null): string {
  if (!profile) return body;

  const name = profile.display_name?.trim();
  if (name && body.startsWith(`${name}: `)) return body.slice(name.length + 2);
  if (name && body.startsWith(`<${name}> `)) return body.slice(name.length + 3);
  if (!profile.has_fallback) return body;

  const separator = body.indexOf(': ');

  return separator === -1 ? body : body.slice(separator + 2);
}
