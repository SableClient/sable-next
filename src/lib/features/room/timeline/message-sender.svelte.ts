import type { ResolvedItem } from '#lib/rooms/timeline-item.js';
import type { MemberView, PerMessageProfileView, ProfileView } from '#src/generated/protocol';

import { i18n } from '#lib/i18n.js';
import { splitDisplayNamePronouns, withDisplayNamePronouns } from '#lib/personas/pronouns.js';
import { profileOverrides } from '#lib/profile/profile-overrides.svelte.js';
import type { SenderCosmetics } from '#lib/rooms/room-cosmetics.svelte.js';
import { preferences } from '#lib/settings/preferences.svelte.js';

import { findMember, memberName, personaWithColor } from '../members/members.js';

export interface MessageSenderOptions {
  item: ResolvedItem;
  members: readonly MemberView[];
  profile: ProfileView | null;
  cosmetics: SenderCosmetics | null;
  onSenderProfile?: (
    userId: string,
    anchor: HTMLElement,
    pmp?: PerMessageProfileView | null
  ) => void;
  onMentionUser?: (userId: string, name: string) => void;
}

export class MessageSender {
  readonly #options: () => MessageSenderOptions;

  constructor(options: () => MessageSenderOptions) {
    this.#options = options;
  }

  readonly persona = $derived.by(() => this.#options().item.per_message_profile);
  readonly tint = $derived.by(() => personaWithColor(this.persona));

  readonly #member = $derived.by(() => {
    const { item, members } = this.#options();
    return findMember(members, item.sender);
  });

  readonly accountName = $derived.by(() => {
    const { item, profile } = this.#options();
    const member = this.#member;
    return profileOverrides.name(
      item.sender ?? '',
      (member ? member.display_name : item.sender_name) ??
        (member ? null : profile?.display_name) ??
        item.sender ??
        i18n.t('timeline.unknownSender')
    );
  });

  readonly #identity = $derived.by(() => {
    const name = this.persona?.display_name ?? this.accountName;
    return preferences.showPronouns && preferences.showPronounPills
      ? splitDisplayNamePronouns(name)
      : { name, pronouns: [] };
  });

  readonly name = $derived.by(() => this.#identity.name);

  readonly avatar = $derived.by(() => {
    const { item } = this.#options();
    if (this.persona?.avatar_url === '') return null;
    return (
      this.persona?.avatar_url ??
      profileOverrides.avatar(
        item.sender ?? '',
        this.#member ? this.#member.avatar_url : item.sender_avatar
      )
    );
  });

  readonly pronouns = $derived.by(() => {
    if (!preferences.showPronouns || !preferences.showPronounPills) return [];
    const { profile, cosmetics } = this.#options();
    return withDisplayNamePronouns(
      this.persona?.pronouns.length
        ? this.persona.pronouns
        : cosmetics?.pronouns.length
          ? cosmetics.pronouns
          : (profile?.pronouns ?? []),
      this.#identity.pronouns
    );
  });

  readonly emoteSender = $derived.by(() => {
    const { item } = this.#options();
    return item.forwarded ? (item.forwarded.sender ?? null) : item.sender;
  });

  readonly emoteName = $derived.by(() => {
    const { item, members } = this.#options();
    if (!item.forwarded) return splitDisplayNamePronouns(this.name).name;
    return splitDisplayNamePronouns(
      this.emoteSender ? memberName(members, this.emoteSender) : i18n.t('timeline.unknownSender')
    ).name;
  });

  readonly nameAction = $derived.by(() => this.#nameClick(this.#options().item.sender));
  readonly emoteNameAction = $derived.by(() => this.#nameClick(this.emoteSender));

  #nameClick(userId: string | null): 'profile' | 'mention' | null {
    if (userId === null) return null;
    const { onSenderProfile, onMentionUser } = this.#options();
    if (
      (preferences.usernameClick === 'profile' || onMentionUser === undefined) &&
      onSenderProfile !== undefined
    )
      return 'profile';
    return onMentionUser === undefined ? null : 'mention';
  }

  openProfile = (anchor: HTMLElement): void => {
    const { item, onSenderProfile } = this.#options();
    if (item.sender) onSenderProfile?.(item.sender, anchor, this.persona);
  };

  openAccountProfile = (anchor: HTMLElement): void => {
    const { item, onSenderProfile } = this.#options();
    if (item.sender) onSenderProfile?.(item.sender, anchor);
  };

  openEmoteProfile = (anchor: HTMLElement): void => {
    const { item, onSenderProfile } = this.#options();
    if (this.emoteSender)
      onSenderProfile?.(this.emoteSender, anchor, item.forwarded ? null : this.persona);
  };

  mention = (): void => {
    const { item, onMentionUser } = this.#options();
    if (item.sender) onMentionUser?.(item.sender, this.accountName);
  };

  mentionEmote = (): void => {
    if (this.emoteSender) this.#options().onMentionUser?.(this.emoteSender, this.emoteName);
  };
}
