<script lang="ts">
  import { onMount, onDestroy, untrack } from 'svelte';

  import type {
    BrightnessView,
    ProfileFieldView,
    ProfileView,
    TimelineItemView,
  } from '#src/generated/protocol';
  import { useCoreClient } from '#lib/core/context.js';
  import { i18n, t } from '#lib/i18n.js';
  import {
    BANNER_FIELD,
    BIO_FIELD,
    LEGACY_BIO_FIELDS,
    LEGACY_STATUS_FIELDS,
    NAME_COLOR_FIELD,
    PRONOUNS_FIELD,
    STATUS_FIELD,
    legacyDeletes,
  } from '#lib/profile/fields.js';
  import { MAX_PRONOUN_INPUT, pronounSets, pronounText } from '#lib/profile/pronouns.js';
  import { preferences } from '#lib/settings/preferences.svelte.js';
  import MentionProfileCard from '#lib/features/room/members/MentionProfileCard.svelte';
  import CodeIcon from 'phosphor-svelte/lib/CodeIcon';
  import LinkIcon from 'phosphor-svelte/lib/LinkIcon';
  import ListBulletsIcon from 'phosphor-svelte/lib/ListBulletsIcon';
  import QuotesIcon from 'phosphor-svelte/lib/QuotesIcon';
  import TextBIcon from 'phosphor-svelte/lib/TextBIcon';
  import TextItalicIcon from 'phosphor-svelte/lib/TextItalicIcon';
  import TextStrikethroughIcon from 'phosphor-svelte/lib/TextStrikethroughIcon';
  import IconButton from '#lib/ui/primitives/IconButton.svelte';
  import { roomLabel, useRoomList } from '#lib/rooms/room-list.svelte.js';
  import ProfileCard from '#lib/ui/primitives/ProfileCard.svelte';
  import { senderColor } from '../room/timeline/timeline-format';
  import Button from '#lib/ui/primitives/Button.svelte';
  import Select from '#lib/ui/primitives/Select.svelte';
  import SettingsSection from '#lib/ui/primitives/SettingsSection.svelte';
  import TextArea from '#lib/ui/primitives/TextArea.svelte';
  import TextInput from '#lib/ui/primitives/TextInput.svelte';
  import { toasts } from '#lib/ui/toasts.svelte.js';
  import { uprightJpeg } from '#lib/ui/upright-jpeg.js';
  import '#lib/ui/primitives/settings-row.css';
  import './profile-editor.css';
  import SpaceProfileEditor from './SpaceProfileEditor.svelte';
  import { isActiveSpace } from '#lib/features/sidebar/nav-rooms.js';
  import { bioHtml, bioMarkdown, bioTexts } from './bio-markdown.js';
  import ColorSetting from './ColorSetting.svelte';
  import { type SenderCosmetics } from '#lib/rooms/room-cosmetics.svelte.js';

  import {
    MessageDialogs,
    provideMessageDialogs,
  } from '#lib/features/room/messages/message-dialogs.svelte.js';
  import {
    OpenMessageMenu,
    provideMessageMenu,
  } from '#lib/features/room/messages/message-menu-open.svelte.js';
  import {
    PinnedEvents,
    providePinnedEvents,
  } from '#lib/features/room/timeline/pinned-events.svelte.js';
  import TimelineItem from '#lib/features/room/timeline/TimelineItem.svelte';
  import { scrollHint } from '#lib/ui/scroll-hint.js';

  interface Props {
    profile: ProfileView;
    userId: string;
    onSaved: () => void;
  }

  interface Draft {
    name: string;
    pronouns: string;
    timezone: string;
    status: string;
    bio: string;
    light: string;
    dark: string;
    hero: string;
    brightness: BrightnessView;
    isAnimal: string;
    hasAnimal: string;
    animalNeed: string;
    banner: string | null;
    extra: ProfileFieldView[];
    avatarRemoved: boolean;
  }

  let { profile, userId, onSaved }: Props = $props();
  const core = useCoreClient();
  providePinnedEvents(new PinnedEvents(core.commands));
  provideMessageDialogs(new MessageDialogs());
  provideMessageMenu(new OpenMessageMenu());

  const supportedZones =
    typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [];
  const zones = supportedZones.includes('UTC') ? supportedZones : ['UTC', ...supportedZones];

  function read(source: ProfileView): Draft {
    return {
      name: source.display_name ?? '',
      pronouns: pronounText(source.pronouns),
      timezone: source.timezone ?? '',
      status: source.status?.text ?? '',
      bio: bioMarkdown(source.bio ?? ''),
      light: source.name_color_light ?? '',
      dark: source.name_color_dark ?? '',
      hero: source.hero_color ?? '',
      brightness: source.hero_brightness ?? 'dark',
      isAnimal: source.animal?.is_animal ?? '',
      hasAnimal: source.animal?.has_animal ?? '',
      animalNeed: source.animal?.animal_need ?? '',
      banner: source.banner_url?.startsWith('mxc://') ? source.banner_url : null,
      extra: source.extra.map(({ key, value }) => ({ key, value })),
      avatarRemoved: false,
    };
  }

  let draft = $state(untrack(() => read(profile)));
  let base = $state.raw(untrack(() => read(profile)));
  let avatarFile = $state<File | null>(null);
  let avatarPreview = $state<string | null>(null);
  let uploadingBanner = $state(false);
  let saving = $state(false);
  let tab = $state<'edit' | 'preview'>('edit');
  const roomList = useRoomList();
  let scope = $state('default');
  let scopeItems = $derived([
    { value: 'default', label: t('settings.profileScopeDefault') },
    ...roomList.rooms
      .filter(isActiveSpace)
      .map((room) => ({ value: room.room_id, label: roomLabel(room) }))
      .sort((a, b) => a.label.localeCompare(b.label)),
  ]);
  let formEl = $state<HTMLFormElement>();
  let error = $state<string | null>(null);
  let editKey = $state<{ key: string; value: string; original: string } | undefined>(undefined);

  let dirty = $derived(
    avatarFile !== null || JSON.stringify($state.snapshot(draft)) !== JSON.stringify(base)
  );
  let zoneItems = $derived(
    (draft.timezone && !zones.includes(draft.timezone) ? [draft.timezone, ...zones] : zones).map(
      (zone) => ({ value: zone, label: zone })
    )
  );
  let hasAvatar = $derived(
    avatarFile !== null || (!draft.avatarRemoved && profile.avatar_url !== null)
  );
  let previewProfile = $derived<ProfileView>({
    ...profile,
    display_name: draft.name.trim() || null,
    avatar_url: avatarPreview ?? (draft.avatarRemoved ? null : profile.avatar_url),
    banner_url: draft.banner,
    bio: bioHtml(draft.bio),
    status: draft.status ? { text: draft.status, emoji: profile.status?.emoji ?? null } : null,
    pronouns: pronounSets(draft.pronouns).map(({ summary, language }) => ({
      summary,
      language: language ?? null,
    })),
    timezone: draft.timezone || null,
    hero_color: draft.hero || null,
    hero_brightness: draft.hero ? draft.brightness : null,
    name_color_light: draft.light || null,
    name_color_dark: draft.dark || null,
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
    sender_name: draft.name.trim() || null,
    sender_avatar: avatarPreview ?? (draft.avatarRemoved ? null : profile.avatar_url),
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
    const next = profile;
    untrack(() => {
      draft = read(next);
      base = read(next);
      setAvatar(null);
      editKey = undefined;
    });
  });

  onMount(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('editStatus') !== null) {
      const accountStatusInput = document.getElementById('account-status');
      if (accountStatusInput && accountStatusInput instanceof HTMLInputElement) {
        accountStatusInput.focus();
        accountStatusInput.select();
      }
    }
  });

  onDestroy(() => {
    if (avatarPreview) URL.revokeObjectURL(avatarPreview);
  });

  function setAvatar(file: File | null): void {
    if (avatarPreview) URL.revokeObjectURL(avatarPreview);
    avatarFile = file;
    avatarPreview = file ? URL.createObjectURL(file) : null;
  }

  function stageAvatar(file: File): void {
    setAvatar(file);
    draft.avatarRemoved = false;
  }

  function removeAvatar(): void {
    setAvatar(null);
    draft.avatarRemoved = true;
  }

  async function stageBanner(file: File): Promise<void> {
    uploadingBanner = true;
    error = null;
    try {
      draft.banner = await core.commands.uploadMedia(
        file.type || 'image/*',
        new Uint8Array(await file.arrayBuffer())
      );
    } catch {
      error = t('settings.profileSaveFailed');
    } finally {
      uploadingBanner = false;
    }
  }

  function commitExtra(): void {
    if (!editKey || !editKey.key) return;
    const { key, value, original } = editKey;
    draft.extra = [
      ...draft.extra.filter((field) => field.key !== original && field.key !== key),
      { key, value },
    ].sort((a, b) => a.key.localeCompare(b.key));
    editKey = undefined;
  }

  function removeExtra(): void {
    if (!editKey) return;
    const { key, original } = editKey;
    draft.extra = draft.extra.filter((field) => field.key !== original && field.key !== key);
    editKey = undefined;
  }

  function changed(...keys: Array<keyof Draft>): boolean {
    return keys.some((key) => JSON.stringify(draft[key]) !== JSON.stringify(base[key]));
  }

  function fields(): Array<[string, unknown]> {
    const out: Array<[string, unknown]> = [];
    if (changed('status')) {
      out.push(
        [STATUS_FIELD, draft.status ? { text: draft.status } : null],
        ...legacyDeletes(profile.legacy_fields, LEGACY_STATUS_FIELDS)
      );
    }
    if (changed('light', 'dark', 'hero', 'brightness')) {
      out.push(
        [
          NAME_COLOR_FIELD,
          draft.light || draft.dark
            ? { on_light: draft.light || null, on_dark: draft.dark || null }
            : null,
        ],
        [
          'chat.commet.profile_color_scheme',
          draft.hero ? { color: draft.hero, brightness: draft.brightness } : null,
        ]
      );
    }
    if (changed('pronouns')) out.push([PRONOUNS_FIELD, pronounSets(draft.pronouns)]);
    if (changed('timezone')) {
      out.push(['m.tz', draft.timezone || null], ['us.cloke.msc4175.tz', draft.timezone || null]);
    }
    if (changed('bio')) {
      out.push(
        [BIO_FIELD, draft.bio ? { 'm.text': bioTexts(draft.bio) } : null],
        ...legacyDeletes(profile.legacy_fields, LEGACY_BIO_FIELDS)
      );
    }
    if (changed('isAnimal', 'hasAnimal', 'animalNeed')) {
      out.push(
        ['pet.plz.me', draft.isAnimal || null],
        ['pet.plz.my', draft.hasAnimal || null],
        ['pet.plz.gib', draft.isAnimal || draft.hasAnimal ? draft.animalNeed : null]
      );
    }
    if (changed('banner')) out.push([BANNER_FIELD, draft.banner]);
    if (changed('extra')) {
      for (const field of draft.extra) {
        if (base.extra.find((prev) => prev.key === field.key)?.value !== field.value) {
          out.push([field.key, field.value]);
        }
      }
      for (const prev of base.extra) {
        if (!draft.extra.some((field) => field.key === prev.key)) out.push([prev.key, null]);
      }
    }
    return out;
  }

  async function save(): Promise<void> {
    if (!dirty || saving || uploadingBanner) return;
    saving = true;
    error = null;
    try {
      const name = draft.name.trim();
      if (name !== base.name.trim()) {
        await core.commands.setDisplayName(name || null, preferences.profileChangePropagation);
      }
      if (avatarFile) {
        const upright = await uprightJpeg(avatarFile);
        await core.uploadAvatar(
          upright.type || 'image/*',
          new Uint8Array(await upright.arrayBuffer()),
          preferences.profileChangePropagation
        );
      } else if (draft.avatarRemoved) {
        await core.commands.setAvatarUrl(null, preferences.profileChangePropagation);
      }
      for (const [field, value] of fields()) await core.setProfileField(field, value);
      base = $state.snapshot(draft);
      setAvatar(null);
      toasts.info(t('settings.profileSaved'));
      onSaved();
    } catch {
      error = t('settings.profileSaveFailed');
    } finally {
      saving = false;
    }
  }

  function saveShortcut(event: KeyboardEvent): void {
    if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 's') return;
    if (!formEl?.contains(document.activeElement)) return;
    event.preventDefault();
    void save();
  }

  interface BioFormat {
    id: 'bold' | 'italic' | 'strike' | 'code' | 'link' | 'quote' | 'list';
    icon: typeof TextBIcon;
    open: string;
    close: string;
    line?: boolean;
  }

  const bioFormats: BioFormat[] = [
    { id: 'bold', icon: TextBIcon, open: '**', close: '**' },
    { id: 'italic', icon: TextItalicIcon, open: '*', close: '*' },
    { id: 'strike', icon: TextStrikethroughIcon, open: '~~', close: '~~' },
    { id: 'code', icon: CodeIcon, open: '`', close: '`' },
    { id: 'link', icon: LinkIcon, open: '[', close: '](https://)' },
    { id: 'quote', icon: QuotesIcon, open: '> ', close: '', line: true },
    { id: 'list', icon: ListBulletsIcon, open: '- ', close: '', line: true },
  ];

  function formatBio({ open, close, line }: BioFormat): void {
    const field = document.getElementById('account-bio');
    if (!(field instanceof HTMLTextAreaElement)) return;
    const { selectionStart: start, selectionEnd: end, value } = field;
    const from = line ? value.lastIndexOf('\n', start - 1) + 1 : start;
    const selected = value.slice(from, end);
    const wrapped = line
      ? selected
          .split('\n')
          .map((row) => `${open}${row}`)
          .join('\n')
      : `${open}${selected}${close}`;
    draft.bio = value.slice(0, from) + wrapped + value.slice(end);
    const caret = from + wrapped.length - (line ? 0 : close.length);
    requestAnimationFrame(() => {
      field.focus();
      field.setSelectionRange(caret, caret);
    });
  }

  function cancel(): void {
    draft = read(profile);
    setAvatar(null);
    editKey = undefined;
    error = null;
  }
</script>

<svelte:window onkeydown={saveShortcut} />

<SettingsSection
  title={$i18n.t('settings.profile')}
  headingId="account-profile"
  class="profile-section"
>
  {#snippet actions()}
    <Select
      bind:value={scope}
      items={scopeItems}
      aria-label={$i18n.t('settings.profileScope')}
      class="scope-select"
    />
  {/snippet}
  <div class="tabs" role="tablist" aria-label={$i18n.t('settings.profile')}>
    {#each ['edit', 'preview'] as const as id (id)}
      <button
        type="button"
        role="tab"
        id={`profile-tab-${id}`}
        class="tab"
        aria-selected={tab === id}
        aria-controls={`profile-panel-${id}`}
        tabindex={tab === id ? 0 : -1}
        onclick={() => {
          tab = id;
        }}
        onkeydown={(event) => {
          if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
          tab = id === 'edit' ? 'preview' : 'edit';
          document.getElementById(`profile-tab-${tab}`)?.focus();
        }}
      >
        {$i18n.t(id === 'edit' ? 'common.edit' : 'settings.profilePreviewTab')}
      </button>
    {/each}
  </div>
  {#if scope !== 'default'}
    <SpaceProfileEditor {profile} {userId} spaceId={scope} {tab} />
  {:else if tab === 'preview'}
    <div
      class="preview-panel"
      role="tabpanel"
      id="profile-panel-preview"
      aria-labelledby="profile-tab-preview"
    >
      <MentionProfileCard {userId} member={null} roomId="" profile={previewProfile} />
      <TimelineItem
        item={previewMessage}
        collapsed={false}
        layout={preferences.layout}
        overrideCosmetics={previewCosmetics}
        preview
      />
    </div>
  {/if}
  <div
    hidden={tab !== 'edit' || scope !== 'default'}
    role="tabpanel"
    id="profile-panel-edit"
    aria-labelledby="profile-tab-edit"
  >
    <form
      bind:this={formEl}
      class="profile-form"
      onsubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <div class="profile-hero" aria-label={$i18n.t('settings.profilePreview')}>
        <ProfileCard
          {userId}
          displayName={draft.name.trim() || userId}
          avatarUrl={avatarPreview ?? (draft.avatarRemoved ? null : profile.avatar_url)}
          bannerUrl={draft.banner}
          color={draft.hero || senderColor(userId)}
          heroColor={draft.hero || null}
          heroBrightness={draft.hero ? draft.brightness : null}
          nameColorLight={draft.light || null}
          nameColorDark={draft.dark || null}
        >
          {#snippet statusField()}
            <TextInput
              id="account-status"
              class="inline-edit"
              bind:value={draft.status}
              aria-label={$i18n.t('settings.status')}
              placeholder={$i18n.t('common.whatAreYouUpTo')}
              maxlength={256}
            />
          {/snippet}
          {#snippet nameField()}
            <div class="caption-field">
              <label class="caption" for="account-display-name"
                >{$i18n.t('common.displayName')}</label
              >
              <TextInput
                id="account-display-name"
                class="inline-edit hero-name"
                bind:value={draft.name}
                placeholder={$i18n.t('common.displayName')}
                autocomplete="nickname"
                maxlength={255}
              />
            </div>
          {/snippet}
          {#snippet pronouns()}
            <div class="caption-field">
              <label class="caption" for="account-pronouns">{$i18n.t('settings.pronouns')}</label>
              <TextInput
                id="account-pronouns"
                class="inline-edit hero-pronouns"
                bind:value={draft.pronouns}
                aria-describedby="account-pronouns-hint"
                placeholder={$i18n.t('settings.pronounsAdd')}
                maxlength={MAX_PRONOUN_INPUT}
              />
              <span id="account-pronouns-hint" class="sr-only"
                >{$i18n.t('settings.pronounsHint')}</span
              >
            </div>
          {/snippet}
          {#snippet meta()}
            <div class="caption-field">
              <label class="caption" for="account-timezone">{$i18n.t('settings.timezone')}</label>
              <div class="timezone-row">
                <Select
                  id="account-timezone"
                  class="inline-edit timezone-select"
                  items={zoneItems}
                  bind:value={draft.timezone}
                  placeholder={$i18n.t('settings.timezoneNotSet')}
                />
                {#if draft.timezone}<Button
                    variant="ghost"
                    size="small"
                    onclick={() => {
                      draft.timezone = '';
                    }}>{$i18n.t('settings.removeTimezone')}</Button
                  >{/if}
              </div>
            </div>
          {/snippet}
          {#snippet actions()}
            <label class="file-button btn btn-secondary btn-small">
              <input
                type="file"
                accept="image/*"
                onchange={(event: Event & { currentTarget: HTMLInputElement }) => {
                  const file = event.currentTarget.files?.[0];
                  event.currentTarget.value = '';
                  if (file) stageAvatar(file);
                }}
              />
              {$i18n.t(hasAvatar ? 'common.changeAvatar' : 'settings.uploadAvatar')}
            </label>
            {#if hasAvatar}<Button variant="secondary" size="small" onclick={removeAvatar}
                >{$i18n.t('common.removeAvatar')}</Button
              >{/if}
            <label class="file-button btn btn-secondary btn-small">
              <input
                type="file"
                accept="image/*"
                disabled={uploadingBanner}
                onchange={(event: Event & { currentTarget: HTMLInputElement }) => {
                  const file = event.currentTarget.files?.[0];
                  event.currentTarget.value = '';
                  if (file) void stageBanner(file);
                }}
              />
              {draft.banner ? $i18n.t('common.changeBanner') : $i18n.t('settings.saveBanner')}
            </label>
            {#if draft.banner}<Button
                variant="secondary"
                size="small"
                loading={uploadingBanner}
                onclick={() => {
                  draft.banner = null;
                }}>{$i18n.t('common.removeBanner')}</Button
              >{/if}
          {/snippet}
          {#snippet footer()}
            <div class="card-fields">
              <fieldset class="group">
                <legend>{$i18n.t('settings.profileColors')}</legend>
                <div class="field-grid">
                  <ColorSetting
                    label={$i18n.t('settings.profileColorsBackground')}
                    bind:value={draft.hero}
                    onCommit={() => {}}
                    onReset={() => {
                      draft.hero = '';
                    }}
                  />
                  <div class="caption-field">
                    <label class="caption" for="account-brightness"
                      >{$i18n.t('settings.profileColorsBrightness')}</label
                    >
                    <Select
                      id="account-brightness"
                      class="inline-edit"
                      bind:value={draft.brightness}
                      items={[
                        { value: 'light', label: $i18n.t('common.light') },
                        { value: 'dark', label: $i18n.t('common.dark') },
                      ]}
                    />
                  </div>
                  <ColorSetting
                    label={$i18n.t('settings.profileColorsOnDark')}
                    bind:value={draft.dark}
                    onCommit={() => {}}
                    onReset={() => {
                      draft.dark = '';
                    }}
                  />
                  <ColorSetting
                    label={$i18n.t('settings.profileColorsOnLight')}
                    bind:value={draft.light}
                    onCommit={() => {}}
                    onReset={() => {
                      draft.light = '';
                    }}
                  />
                </div>
              </fieldset>
              <fieldset class="group">
                <legend>{$i18n.t('settings.animalIdentity')}</legend>
                <div class="field-grid">
                  <div class="caption-field">
                    <label class="caption" for="account-animal-is"
                      >{$i18n.t('settings.animalIdentityWhatIs')}</label
                    >
                    <TextInput
                      id="account-animal-is"
                      class="inline-edit"
                      bind:value={draft.isAnimal}
                      placeholder={$i18n.t('settings.animalIdentityWhatIsPlaceholder')}
                    />
                  </div>
                  <div class="caption-field">
                    <label class="caption" for="account-animal-has"
                      >{$i18n.t('settings.animalIdentityWhatHas')}</label
                    >
                    <TextInput
                      id="account-animal-has"
                      class="inline-edit"
                      bind:value={draft.hasAnimal}
                      placeholder={$i18n.t('settings.animalIdentityWhatHasPlaceholder')}
                    />
                  </div>
                  <div class="caption-field">
                    <label class="caption" for="account-animal-needs"
                      >{$i18n.t('settings.animalIdentityWhatNeeds')}</label
                    >
                    <TextInput
                      id="account-animal-needs"
                      class="inline-edit"
                      bind:value={draft.animalNeed}
                      placeholder={$i18n.t('settings.animalIdentityWhatNeedsPlaceholder')}
                    />
                  </div>
                </div>
              </fieldset>
            </div>
          {/snippet}

          <div class="caption-field">
            <label class="caption" for="account-bio">{$i18n.t('settings.biography')}</label>
            <div class="bio-toolbar" role="toolbar" aria-label={$i18n.t('settings.bioFormatting')}>
              {#each bioFormats as format (format.id)}
                <IconButton
                  variant="ghost"
                  size="small"
                  label={$i18n.t(`settings.bioFormat.${format.id}`)}
                  onclick={() => formatBio(format)}
                >
                  <format.icon />
                </IconButton>
              {/each}
            </div>
            <TextArea
              id="account-bio"
              class="inline-edit"
              bind:value={draft.bio}
              rows={4}
              maxlength={5000}
              placeholder={$i18n.t('settings.biographyHint')}
            />
          </div>
        </ProfileCard>
      </div>
      <div class="settings-form">
        <fieldset class="group">
          <legend>{$i18n.t('settings.otherProfileFields')}</legend>
          <p class="settings-note">
            {$i18n.t('settings.otherProfileFieldsDescription')}
            <span aria-label={$i18n.t('settings.otherProfileFieldsKaomojiTranslation')}
              >{$i18n.t('settings.otherProfileFieldsKaomoji')}</span
            >
          </p>
          {#if draft.extra.length}
            <div class="extra-list" {@attach scrollHint}>
              {#each draft.extra as field (field.key)}
                <Button
                  variant={editKey?.original === field.key ? 'primary' : 'ghost'}
                  size="small"
                  class="choice"
                  aria-pressed={editKey?.original === field.key}
                  block
                  onclick={() => {
                    editKey = { key: field.key, value: field.value, original: field.key };
                  }}
                >
                  {field.key}
                </Button>
              {/each}
            </div>
          {/if}
          {#if editKey !== undefined}
            <div class="extra-edit">
              <TextInput
                bind:value={editKey.key}
                maxlength={256}
                aria-label={$i18n.t('settings.otherProfileFieldsKeyPlaceholder')}
                placeholder={$i18n.t('settings.otherProfileFieldsKeyPlaceholder')}
                onkeydown={(event) => {
                  if (event.key !== 'Enter') return;
                  event.preventDefault();
                  commitExtra();
                }}
              />
              <TextArea
                bind:value={editKey.value}
                rows={5}
                maxlength={5000}
                aria-label={$i18n.t('settings.otherProfileFieldsValuePlaceholder')}
                placeholder={$i18n.t('settings.otherProfileFieldsValuePlaceholder')}
              />
              <div class="extra-buttons">
                <Button size="small" onclick={commitExtra}
                  >{$i18n.t('settings.otherProfileFieldsDone')}</Button
                >
                <Button
                  variant="danger"
                  size="small"
                  aria-label={$i18n.t('settings.otherProfileFieldsRemove')}
                  onclick={removeExtra}>{$i18n.t('common.remove')}</Button
                >
                <Button
                  size="small"
                  aria-label={$i18n.t('settings.otherProfileFieldsCancel')}
                  onclick={() => (editKey = undefined)}
                >
                  {$i18n.t('common.cancel')}
                </Button>
              </div>
            </div>
          {:else}
            <div>
              <Button
                size="small"
                onclick={() => {
                  editKey = { key: '', value: '', original: '' };
                }}>{$i18n.t('common.add')}</Button
              >
            </div>
          {/if}
        </fieldset>
      </div>
      <div class="actions">
        {#if error}<p class="actions-note critical" role="alert">{error}</p>
        {:else if dirty}<p class="actions-note" role="status">
            {$i18n.t('settings.unsavedChanges')}
          </p>{/if}
        <Button
          type="submit"
          variant="primary"
          disabled={!dirty || uploadingBanner}
          loading={saving}>{$i18n.t('common.save')}</Button
        >
        <Button disabled={!dirty || saving} onclick={cancel}>{$i18n.t('common.cancel')}</Button>
      </div>
    </form>
  </div>
</SettingsSection>

<style>
  .tabs {
    border-bottom: var(--border-width) solid var(--surface-var-container-line);
    display: flex;
    gap: var(--space-100);
    padding: var(--space-200) var(--space-300) 0;
  }

  .tab {
    background: none;
    border: 0;
    border-bottom: var(--border-width-600) solid transparent;
    color: var(--surface-var-on-container);
    cursor: pointer;
    font: inherit;
    font-weight: var(--font-weight-medium);
    padding: var(--space-200) var(--space-300);
  }

  .tab[aria-selected='true'] {
    border-bottom-color: var(--primary-main);
    color: var(--surface-on-container);
  }

  .tab:focus-visible {
    outline: var(--focus-ring-width) solid var(--focus-ring);
    outline-offset: calc(-1 * var(--focus-ring-width));
  }

  .preview-panel {
    display: flex;
    flex-direction: column;
    gap: var(--space-400);
    padding: var(--space-400);
  }

  .preview-panel > :global(.message) {
    border-radius: var(--radius);
  }

  .extra-list {
    display: flex;
    flex-direction: column;
    gap: var(--space-200);
    max-height: 14rem;
    overflow: auto;
  }

  .extra-edit {
    display: flex;
    flex-direction: column;
    gap: var(--space-100);
  }

  .extra-buttons {
    align-items: center;
    display: flex;
    gap: var(--space-100);
    justify-content: end;
  }
</style>
