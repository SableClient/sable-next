import type { MemberView } from '#src/generated/MemberView';
import type { PerMessageProfileView } from '#src/generated/PerMessageProfileView';
import type { ProfileView } from '#src/generated/ProfileView';

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
  isOwn = false
): SenderDisplayColors {
  const personaTint = personaWithColor(persona);
  const nameColorLight =
    personaTint?.color_on_light ?? profile?.name_color_light ?? profile?.name_color_dark ?? null;
  const nameColorDark =
    personaTint?.color_on_dark ?? profile?.name_color_dark ?? profile?.name_color_light ?? null;
  const tinted = nameColorLight !== null || nameColorDark !== null;
  const nameColor = isOwn ? 'var(--sable-primary-on-container)' : senderColor(userId);

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
  return findMember(members, userId)?.display_name ?? userId;
}

export function memberAvatar(members: readonly MemberView[], userId: string): string | null {
  return findMember(members, userId)?.avatar_url ?? null;
}

export function personaWithColor(
  profile: PerMessageProfileView | null
): PerMessageProfileView | null {
  return profile && (profile.color_on_light ?? profile.color_on_dark) !== null ? profile : null;
}

export function isCaption(body: string): boolean {
  return !/^\S+\.[a-z0-9]{2,4}$/i.test(body);
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
