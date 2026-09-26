import type { MemberView, PerMessageProfileView, ProfileView } from '#src/generated/protocol';

import { profileOverrides } from '#lib/profile/profile-overrides.svelte.js';
import type { SenderCosmetics } from '#lib/rooms/room-cosmetics.svelte.js';

import { senderColor } from './timeline-format';

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
  room: SenderCosmetics | null = null
): SenderDisplayColors {
  const override = profileOverrides.colors(userId);
  if (override === null) {
    const nameColor = isOwn ? 'var(--primary-on-container)' : senderColor(userId);
    return { nameColor, nameColorLight: null, nameColorDark: null, tinted: false };
  }
  const personaTint = personaWithColor(persona);
  const nameColorLight =
    override?.light ??
    override?.dark ??
    personaTint?.color_on_light ??
    room?.colorOnLight ??
    profile?.name_color_light ??
    profile?.name_color_dark ??
    null;
  const nameColorDark =
    override?.dark ??
    override?.light ??
    personaTint?.color_on_dark ??
    room?.colorOnDark ??
    profile?.name_color_dark ??
    profile?.name_color_light ??
    null;
  const tinted = nameColorLight !== null || nameColorDark !== null;
  const nameColor = isOwn ? 'var(--primary-on-container)' : senderColor(userId);

  return { nameColor, nameColorLight, nameColorDark, tinted };
}

export function findMember(
  members: readonly MemberView[],
  userId: string | null | undefined
): MemberView | undefined {
  if (!userId) return undefined;

  return members.find((member) => member.user_id === userId);
}

export function memberName(members: readonly MemberView[], userId: string): string {
  return profileOverrides.name(userId, findMember(members, userId)?.display_name ?? userId);
}

export function memberAvatar(members: readonly MemberView[], userId: string): string | null {
  return profileOverrides.avatar(userId, findMember(members, userId)?.avatar_url ?? null);
}

export interface MemberIdentity {
  userId: string;
  name: string;
  avatar: string | null;
}

export function memberIdentity(members: readonly MemberView[], userId: string): MemberIdentity {
  const member = findMember(members, userId);

  return { userId, name: member?.display_name ?? userId, avatar: member?.avatar_url ?? null };
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
