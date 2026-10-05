<script lang="ts">
  import { onDestroy } from 'svelte';

  import type {
    PronounView,
    ProfileView,
    RoomPermissionsView,
    RoomPowerLevelsView,
    TimelineItemView,
  } from '#src/generated/protocol';
  import { useCoreClient } from '#lib/core/context.js';
  import {
    COSMETIC_EVENT_TYPES,
    pronounContent,
    writeMemberColors,
  } from '#lib/features/composer/slash-commands.js';
  import { preferences } from '#lib/settings/preferences.svelte.js';
  import MentionProfileCard from '#lib/features/room/members/MentionProfileCard.svelte';
  import { canSendState } from '#lib/features/room/settings/permission-groups.js';
  import { senderColor } from '../room/timeline/timeline-format';
  import { i18n, t } from '#lib/i18n.js';
  import { useRoomList } from '#lib/rooms/room-list.svelte.js';
  import Button from '#lib/ui/primitives/Button.svelte';
  import ProfileCard from '#lib/ui/primitives/ProfileCard.svelte';
  import TextInput from '#lib/ui/primitives/TextInput.svelte';
  import TimelineItem from '#lib/features/room/timeline/TimelineItem.svelte';
  import { uprightJpeg } from '#lib/ui/upright-jpeg.js';
  import ColorSetting from './ColorSetting.svelte';
  import { type SenderCosmetics } from '#lib/rooms/room-cosmetics.svelte.js';
  import './profile-editor.css';

  interface Props {
    profile: ProfileView;
    userId: string;
    spaceId: string;
    tab: 'edit' | 'preview';
  }

  interface Draft {
    name: string;
    pronouns: string;
    light: string;
    dark: string;
    avatar: string | null;
  }

  let { profile, userId, spaceId, tab }: Props = $props();
  const core = useCoreClient();
  const roomList = useRoomList();

  const blank: Draft = { name: '', pronouns: '', light: '', dark: '', avatar: null };
  let draft = $state<Draft>({ ...blank });
  let base = $state.raw<Draft>({ ...blank });
  let avatarFile = $state<File | null>(null);
  let avatarPreview = $state<string | null>(null);
  let permissions = $state.raw<RoomPermissionsView | null>(null);
  let levels = $state.raw<RoomPowerLevelsView | null>(null);
  let loading = $state(true);
  let saving = $state(false);
  let error = $state<string | null>(null);
  let applied = $state<{ done: number; failed: number; total: number } | null>(null);
  let run = 0;

  let space = $derived(roomList.byId(spaceId));
  let ownLevel = $derived(permissions?.own_power_level ?? 0);
  let canSetColor = $derived(canSendState(levels, ownLevel, 'm.room.member'));
  let canSetPronouns = $derived(canSendState(levels, ownLevel, COSMETIC_EVENT_TYPES.pronoun));
  let dirty = $derived(
    avatarFile !== null || JSON.stringify($state.snapshot(draft)) !== JSON.stringify(base)
  );
  let profileName = $derived(profile.display_name);
  let shownAvatar = $derived(avatarPreview ?? draft.avatar ?? profile.avatar_url);
  let pronounViews = $derived<PronounView[]>(
    draft.pronouns
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry !== '')
      .map((entry) => {
        const [first = '', second] = entry.split(':');
        return second === undefined
          ? { summary: entry, language: null }
          : { summary: second.trim(), language: first.trim() || null };
      })
  );
  let previewProfile = $derived<ProfileView>({
    ...profile,
    display_name: draft.name.trim() || profile.display_name,
    avatar_url: shownAvatar,
    pronouns: pronounViews.length ? pronounViews : profile.pronouns,
    name_color_light: draft.light || profile.name_color_light,
    name_color_dark: draft.dark || profile.name_color_dark,
  });
  let applyTargets = $derived.by(() => {
    const found: string[] = [];
    const seen: string[] = [spaceId];
    const walk = (parent: typeof space) => {
      for (const edge of parent?.space_children ?? []) {
        if (seen.includes(edge.room_id)) continue;
        seen.push(edge.room_id);
        const child = roomList.byId(edge.room_id);
        if (child?.state !== 'joined') continue;
        if (child.is_space) walk(child);
        else found.push(child.room_id);
      }
    };
    walk(space);
    return found;
  });

  const previewCosmetics = $derived<SenderCosmetics>({
    colorOnLight: previewProfile.name_color_light,
    colorOnDark: previewProfile.name_color_dark,
    pronouns: previewProfile.pronouns,
  });

  const previewMessage = $derived<TimelineItemView>({
    id: 'profile-message-preview',
    event_id: null,
    transaction_id: null,
    send_state: null,
    sender: profile.user_id,
    sender_name: previewProfile.display_name,
    sender_avatar: previewProfile.avatar_url,
    timestamp: Date.now(),
    content: {
      kind: 'message',
      body: 'See you at six?',
      html: 'See you at six?',
      emote: false,
      notice: false,
      edited: false,
    },
    in_reply_to: null,
    forum_title: null,
    thread_root: null,
    thread_summary: null,
    reactions: [],
    is_own: true,
    read_by: [],
    read_timestamps: {},
    per_message_profile: null,
    bundled_link_previews: [],
    link_previews_removed: null,
    mention: 'none',
    forwarded: null,
  });

  $effect(() => {
    const target = spaceId;
    void load(target);
  });

  onDestroy(() => {
    if (avatarPreview) URL.revokeObjectURL(avatarPreview);
  });

  function record(value: unknown): Record<string, unknown> {
    return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
  }

  function text(value: unknown): string {
    return typeof value === 'string' ? value : '';
  }

  function setAvatar(file: File | null): void {
    if (avatarPreview) URL.revokeObjectURL(avatarPreview);
    avatarFile = file;
    avatarPreview = file ? URL.createObjectURL(file) : null;
  }

  async function load(target: string): Promise<void> {
    const current = ++run;
    loading = true;
    error = null;
    applied = null;
    setAvatar(null);
    try {
      const [member, pronounEvent, nextPermissions, nextLevels] = await Promise.all([
        core.commands.roomStateEvent(target, 'm.room.member', userId),
        core.commands.roomStateEvent(target, COSMETIC_EVENT_TYPES.pronoun, userId),
        core.commands.roomPermissions(target),
        core.commands.roomPowerLevels(target),
      ]);
      if (current !== run) return;
      const memberRecord = record(member);
      const colors = record(memberRecord['eu.she-a.color']);
      const memberName = text(memberRecord.displayname);
      const memberAvatar = text(memberRecord.avatar_url);
      const sets = record(pronounEvent).pronouns;
      permissions = nextPermissions;
      levels = nextLevels;
      const next: Draft = {
        name: memberName === profile.display_name ? '' : memberName,
        pronouns: Array.isArray(sets)
          ? sets
              .map((set) => {
                const entry = record(set);
                const language = text(entry.language);
                return `${language ? `${language}:` : ''}${text(entry.summary)}`;
              })
              .filter((entry) => entry !== '')
              .join(', ')
          : '',
        light: text(colors.on_light),
        dark: text(colors.on_dark),
        avatar: memberAvatar === '' || memberAvatar === profile.avatar_url ? null : memberAvatar,
      };
      draft = { ...next };
      base = { ...next };
    } catch (failure) {
      if (current === run) {
        console.warn('[sable space] profile unavailable', failure);
        error = t('room.cosmeticsFailed');
      }
    } finally {
      if (current === run) loading = false;
    }
  }

  async function writeMember(
    target: string,
    fields: Partial<Record<'displayname' | 'avatar_url', string | null>>
  ): Promise<void> {
    const rest = Object.fromEntries(
      Object.entries(
        record(await core.commands.roomStateEvent(target, 'm.room.member', userId))
      ).filter(([key]) => !(key in fields))
    );
    await core.commands.sendStateEvent(target, 'm.room.member', userId, {
      ...rest,
      membership: 'join',
      ...Object.fromEntries(Object.entries(fields).filter(([, value]) => value)),
    });
  }

  async function save(): Promise<void> {
    if (!dirty || saving) return;
    saving = true;
    error = null;
    try {
      let avatar = draft.avatar;
      if (avatarFile) {
        const upright = await uprightJpeg(avatarFile);
        avatar = await core.commands.uploadMedia(
          upright.type || 'image/*',
          new Uint8Array(await upright.arrayBuffer())
        );
      }
      if (draft.name !== base.name || avatar !== base.avatar) {
        await writeMember(spaceId, {
          displayname: draft.name.trim() || profileName,
          avatar_url: avatar ?? profile.avatar_url,
        });
      }
      if (draft.light !== base.light || draft.dark !== base.dark) {
        await writeMemberColors(core.commands, spaceId, userId, {
          kind: 'set',
          colors: { on_light: draft.light || undefined, on_dark: draft.dark || undefined },
        });
      }
      if (draft.pronouns !== base.pronouns) {
        await core.commands.sendStateEvent(
          spaceId,
          COSMETIC_EVENT_TYPES.pronoun,
          userId,
          pronounContent(draft.pronouns.trim() === '' ? 'reset' : draft.pronouns) ?? {}
        );
      }
      draft = { ...draft, avatar };
      base = $state.snapshot(draft);
      setAvatar(null);
    } catch (failure) {
      console.warn('[sable space] profile not saved', failure);
      error = t('room.cosmeticsFailed');
    } finally {
      saving = false;
    }
  }

  function cancel(): void {
    draft = { ...base };
    setAvatar(null);
    error = null;
  }

  async function applyToRooms(): Promise<void> {
    if (saving) return;
    saving = true;
    error = null;
    let progress = { done: 0, failed: 0, total: applyTargets.length };
    applied = progress;
    for (const child of applyTargets) {
      try {
        await writeMember(child, {
          displayname: draft.name.trim() || profileName,
          avatar_url: draft.avatar ?? profile.avatar_url,
        });
        progress = { ...progress, done: progress.done + 1 };
      } catch (failure) {
        console.warn('[sable space] look not applied to a room', failure);
        progress = { ...progress, failed: progress.failed + 1 };
      }
      applied = progress;
    }
    saving = false;
  }

  let applyNote = $derived.by(() => {
    if (applied && saving)
      return t('room.cosmeticsApplying', {
        done: applied.done + applied.failed,
        total: applied.total,
      });
    if (applied?.failed)
      return t('room.cosmeticsAppliedPartial', { count: applied.done, failed: applied.failed });
    if (applied) return t('room.cosmeticsApplied', { count: applied.done });
    if (applyTargets.length === 0) return t('room.cosmeticsApplyRoomsNone');
    if (dirty) return t('room.cosmeticsApplyRoomsSaveFirst');
    return t('room.cosmeticsApplyRoomsHint', { count: applyTargets.length });
  });
</script>

{#if tab === 'preview'}
  <div class="preview-panel" role="tabpanel" id="profile-panel-preview">
    <MentionProfileCard {userId} member={null} roomId="" profile={previewProfile} />
    <TimelineItem
      item={previewMessage}
      collapsed={false}
      layout={preferences.layout}
      overrideCosmetics={previewCosmetics}
      preview
    />
  </div>
{:else}
  <div role="tabpanel" id="profile-panel-edit" aria-busy={loading}>
    <form
      class="profile-form"
      onsubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <div class="profile-hero" aria-label={$i18n.t('settings.profilePreview')}>
        <ProfileCard
          {userId}
          displayName={draft.name.trim() || profile.display_name || userId}
          avatarUrl={shownAvatar}
          bannerUrl={profile.banner_url}
          color={profile.hero_color || senderColor(userId)}
          heroColor={profile.hero_color}
          heroBrightness={profile.hero_brightness}
          nameColorLight={draft.light || profile.name_color_light}
          nameColorDark={draft.dark || profile.name_color_dark}
        >
          {#snippet nameField()}
            <div class="caption-field">
              <label class="caption" for="space-display-name"
                >{$i18n.t('room.cosmeticsNameSpace')}</label
              >
              <TextInput
                id="space-display-name"
                class="inline-edit hero-name"
                bind:value={draft.name}
                placeholder={profile.display_name ?? userId}
                disabled={loading}
                maxlength={255}
              />
            </div>
          {/snippet}
          {#snippet pronouns()}
            <div class="caption-field">
              <label class="caption" for="space-pronouns">{$i18n.t('settings.pronouns')}</label>
              <TextInput
                id="space-pronouns"
                class="inline-edit hero-pronouns"
                bind:value={draft.pronouns}
                disabled={loading || !canSetPronouns}
                placeholder={$i18n.t('room.cosmeticsPronounsPlaceholder')}
                title={canSetPronouns ? undefined : $i18n.t('room.cosmeticsNotAllowed')}
              />
            </div>
          {/snippet}
          {#snippet actions()}
            <label class="file-button btn btn-secondary btn-small">
              <input
                type="file"
                accept="image/*"
                disabled={loading}
                onchange={(event: Event & { currentTarget: HTMLInputElement }) => {
                  const file = event.currentTarget.files?.[0];
                  event.currentTarget.value = '';
                  if (file) setAvatar(file);
                }}
              />
              {$i18n.t('room.cosmeticsAvatarChange')}
            </label>
            {#if draft.avatar || avatarFile}
              <Button
                variant="secondary"
                size="small"
                onclick={() => {
                  setAvatar(null);
                  draft.avatar = null;
                }}>{$i18n.t('room.cosmeticsAvatarReset')}</Button
              >
            {/if}
          {/snippet}
        </ProfileCard>
      </div>
      <div class="settings-form">
        {#if canSetColor}
          <fieldset class="group">
            <legend>{$i18n.t('settings.profileColors')}</legend>
            <ColorSetting
              label={$i18n.t('room.cosmeticsColorDark')}
              bind:value={draft.dark}
              onCommit={() => {}}
              onReset={() => {
                draft.dark = '';
              }}
            />
            <ColorSetting
              label={$i18n.t('room.cosmeticsColorLight')}
              bind:value={draft.light}
              onCommit={() => {}}
              onReset={() => {
                draft.light = '';
              }}
            />
          </fieldset>
        {/if}
        <fieldset class="group">
          <legend>{$i18n.t('room.cosmeticsApplyRooms')}</legend>
          <p class="settings-note">{applyNote}</p>
          <div>
            <Button
              size="small"
              disabled={saving || dirty || applyTargets.length === 0}
              onclick={() => void applyToRooms()}
              >{$i18n.t('room.cosmeticsApplyRoomsAction')}</Button
            >
          </div>
        </fieldset>
      </div>
      <div class="actions">
        {#if error}<p class="actions-note critical" role="alert">{error}</p>
        {:else if dirty}<p class="actions-note" role="status">
            {$i18n.t('settings.unsavedChanges')}
          </p>{/if}
        <Button type="submit" variant="primary" disabled={!dirty || loading} loading={saving}
          >{$i18n.t('settings.saveButton')}</Button
        >
        <Button disabled={!dirty || saving} onclick={cancel}>{$i18n.t('settings.cancel')}</Button>
      </div>
    </form>
  </div>
{/if}

<style>
  .preview-panel {
    display: flex;
    flex-direction: column;
    gap: var(--space-400);
    padding: var(--space-400);
  }

  .preview-panel > :global(.message) {
    border-radius: var(--radius);
  }
</style>
