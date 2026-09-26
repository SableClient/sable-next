<script lang="ts">
  import { untrack } from 'svelte';

  import type { ProfileView } from '#src/generated/protocol';
  import { i18n, t } from '#lib/i18n.js';
  import { toasts } from '#lib/ui/toasts.svelte.js';

  import { useCoreClient } from '#lib/core/context.js';
  import MediaImage from '#lib/ui/MediaImage.svelte';
  import Alert from '#lib/ui/primitives/Alert.svelte';
  import Button from '#lib/ui/primitives/Button.svelte';
  import Select from '#lib/ui/primitives/Select.svelte';
  import SettingsSection from '#lib/ui/primitives/SettingsSection.svelte';
  import TextArea from '#lib/ui/primitives/TextArea.svelte';
  import TextInput from '#lib/ui/primitives/TextInput.svelte';
  import ColorSetting from './ColorSetting.svelte';
  import SettingsRow from '#lib/ui/primitives/SettingsRow.svelte';
  import '#lib/ui/primitives/settings-row.css';
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
  import { pronounSets, pronounText } from '#lib/profile/pronouns.js';
  import { bioMarkdown, bioTexts } from './bio-markdown.js';

  interface Props {
    profile: ProfileView;
    onSaved: () => void;
    section: 'banner' | 'profile' | 'account';
  }

  let { profile, onSaved, section }: Props = $props();
  const core = useCoreClient();
  let status = $state('');
  let bio = $state('');
  let pronouns = $state('');
  let timezone = $state('');
  let lightColor = $state('');
  let darkColor = $state('');
  let heroColor = $state('');
  let brightness = $state<'light' | 'dark'>('dark');
  let isAnimal = $state('');
  let hasAnimal = $state('');
  let animalNeed = $state('');
  let emails = $state<string[]>([]);
  let ignored = $state<string[]>([]);
  let userToBlock = $state('');
  let saving = $state<string | null>(null);
  let error = $state<string | null>(null);
  let banner = $derived(profile.banner_url?.startsWith('mxc://') ? profile.banner_url : null);
  let editKey = $state<{ key: string; value: string; original: string } | undefined>(undefined);

  type Snapshot = Record<string, string>;
  interface Group {
    name: string;
    read: () => Snapshot;
    write: (snapshot: Snapshot) => void;
    fields: () => Array<[string, unknown]>;
  }

  const groups = {
    status: {
      name: 'settings.status',
      read: () => ({ status }),
      write: (snapshot) => {
        status = snapshot.status ?? '';
      },
      fields: () => [
        [STATUS_FIELD, status ? { text: status } : null],
        ...legacyDeletes(profile.legacy_fields, LEGACY_STATUS_FIELDS),
      ],
    },
    colors: {
      name: 'settings.profileColors',
      read: () => ({ lightColor, darkColor, heroColor, brightness }),
      write: (snapshot) => {
        lightColor = snapshot.lightColor ?? '';
        darkColor = snapshot.darkColor ?? '';
        heroColor = snapshot.heroColor ?? '';
        brightness = snapshot.brightness === 'light' ? 'light' : 'dark';
      },
      fields: () => [
        [
          NAME_COLOR_FIELD,
          lightColor || darkColor
            ? { on_light: lightColor || null, on_dark: darkColor || null }
            : null,
        ],
        ['chat.commet.profile_color_scheme', heroColor ? { color: heroColor, brightness } : null],
      ],
    },
    identity: {
      name: 'settings.pronounsAndTimezone',
      read: () => ({ pronouns, timezone }),
      write: (snapshot) => {
        pronouns = snapshot.pronouns ?? '';
        timezone = snapshot.timezone ?? '';
      },
      fields: () => [
        [PRONOUNS_FIELD, pronounSets(pronouns)],
        ['m.tz', timezone || null],
        ['us.cloke.msc4175.tz', timezone || null],
      ],
    },
    bio: {
      name: 'settings.biography',
      read: () => ({ bio }),
      write: (snapshot) => {
        bio = snapshot.bio ?? '';
      },
      fields: () => [
        [BIO_FIELD, bio ? { 'm.text': bioTexts(bio) } : null],
        ...legacyDeletes(profile.legacy_fields, LEGACY_BIO_FIELDS),
      ],
    },
    animal: {
      name: 'settings.animalIdentity',
      read: () => ({ isAnimal, hasAnimal, animalNeed }),
      write: (snapshot) => {
        isAnimal = snapshot.isAnimal ?? '';
        hasAnimal = snapshot.hasAnimal ?? '';
        animalNeed = snapshot.animalNeed ?? '';
      },
      fields: () => [
        ['pet.plz.me', isAnimal || null],
        ['pet.plz.my', hasAnimal || null],
        ['pet.plz.gib', isAnimal || hasAnimal ? animalNeed : null],
      ],
    },
  } satisfies Record<string, Group>;
  type GroupKey = keyof typeof groups;

  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- last-saved values, nothing renders them
  const saved = new Map<GroupKey, Snapshot>();

  function sameSnapshot(a: Snapshot, b: Snapshot): boolean {
    return Object.keys(a).every((key) => a[key] === b[key]);
  }

  async function autosave(key: GroupKey): Promise<void> {
    const group: Group = groups[key];
    const before = saved.get(key);
    const now = group.read();
    if (before && sameSnapshot(before, now)) return;
    saved.set(key, now);
    if (!(await save(key, group.fields()))) {
      if (before) saved.set(key, before);
      return;
    }
    if (!before) return;
    toasts.undoable(t('settings.savedField', { name: t(group.name) }), {
      label: t('settings.undo'),
      onUndo: () => {
        group.write(before);
        saved.set(key, before);
        void save(key, group.fields());
      },
    });
  }

  function leaving(key: GroupKey) {
    return (event: FocusEvent & { currentTarget: HTMLElement }): void => {
      const next = event.relatedTarget;
      if (next instanceof Node && event.currentTarget.contains(next)) return;
      void autosave(key);
    };
  }

  function submitting(key: GroupKey) {
    return (event: SubmitEvent): void => {
      event.preventDefault();
      void autosave(key);
    };
  }

  $effect(() => {
    void core.session?.user_id;
    untrack(() => {
      status = profile.status?.text ?? '';
      bio = bioMarkdown(profile.bio ?? '');
      pronouns = pronounText(profile.pronouns);
      timezone = profile.timezone ?? '';
      lightColor = profile.name_color_light ?? '';
      darkColor = profile.name_color_dark ?? '';
      heroColor = profile.hero_color ?? '';
      brightness = profile.hero_brightness ?? 'dark';
      isAnimal = profile.animal?.is_animal ?? '';
      hasAnimal = profile.animal?.has_animal ?? '';
      animalNeed = profile.animal?.animal_need ?? '';
      for (const key of Object.keys(groups) as GroupKey[]) saved.set(key, groups[key].read());
    });
  });

  $effect(() => {
    if (section !== 'account') return;
    let cancelled = false;
    void Promise.all([core.commands.accountContacts(), core.commands.ignoredUsers()]).then(
      ([nextEmails, nextIgnored]) => {
        if (cancelled) return;
        emails = nextEmails;
        ignored = nextIgnored;
      },
      () => {
        if (!cancelled) error = 'Could not load account details.';
      }
    );
    return () => {
      cancelled = true;
    };
  });

  async function save(key: string, fields: Array<[string, unknown]>): Promise<boolean> {
    saving = key;
    error = null;
    try {
      for (const [field, value] of fields) await core.setProfileField(field, value);
      onSaved();
      return true;
    } catch {
      error = t('settings.profileSaveFailed');
      return false;
    } finally {
      if (saving === key) saving = null;
    }
  }

  function offerBannerUndo(previous: string | null): void {
    toasts.undoable(t('settings.savedField', { name: t('settings.banner') }), {
      label: t('settings.undo'),
      onUndo: () => void save('banner', [[BANNER_FIELD, previous]]),
    });
  }

  async function uploadBanner(file: File): Promise<void> {
    const previous = profile.banner_url;
    saving = 'banner';
    error = null;
    try {
      const url = await core.commands.uploadMedia(
        file.type || 'image/*',
        new Uint8Array(await file.arrayBuffer())
      );
      await core.setProfileField(BANNER_FIELD, url);
      onSaved();
      offerBannerUndo(previous);
    } catch {
      error = t('settings.profileSaveFailed');
    } finally {
      saving = null;
    }
  }

  async function removeBanner(): Promise<void> {
    const previous = profile.banner_url;
    if (await save('banner', [[BANNER_FIELD, null]])) offerBannerUndo(previous);
  }

  async function block(): Promise<void> {
    const userId = userToBlock.trim();
    if (!userId || saving) return;
    saving = 'block';
    error = null;
    try {
      await core.setUserIgnored(userId, true);
      if (!ignored.includes(userId)) ignored = [...ignored, userId].sort();
      userToBlock = '';
    } catch {
      error = 'Could not update blocked users.';
    } finally {
      saving = null;
    }
  }

  async function unblock(userId: string): Promise<void> {
    if (saving) return;
    saving = userId;
    error = null;
    try {
      await core.setUserIgnored(userId, false);
      ignored = ignored.filter((entry) => entry !== userId);
    } catch {
      error = 'Could not update blocked users.';
    } finally {
      saving = null;
    }
  }
</script>

<div class="profile-stack">
  {#if error}<Alert variant="critical" aria-live="polite">{error}</Alert>{/if}

  {#if section === 'banner'}<div class="banner-setting">
      <span class="setting-label">{$i18n.t('settings.banner')}</span>
      <div class="banner-row">
        {#if banner}<MediaImage
            class="banner"
            source={banner}
            alt={$i18n.t('settings.currentProfileBanner')}
            width={1000}
            height={375}
          />{/if}
        <label class="file-button btn btn-secondary btn-small">
          <input
            type="file"
            accept="image/*"
            disabled={saving === 'banner'}
            onchange={(event: Event & { currentTarget: HTMLInputElement }) => {
              const file = event.currentTarget.files?.[0];
              event.currentTarget.value = '';
              if (file) void uploadBanner(file);
            }}
          />
          {profile.banner_url ? $i18n.t('settings.changeBanner') : $i18n.t('settings.saveBanner')}
        </label>
        {#if profile.banner_url}<Button
            variant="ghost"
            size="small"
            loading={saving === 'banner'}
            onclick={() => void removeBanner()}>{$i18n.t('settings.removeButton')}</Button
          >{/if}
      </div>
    </div>{/if}

  {#if section === 'profile'}<SettingsSection
      title={$i18n.t('settings.status')}
      headingId="profile-status"
    >
      <form
        class="settings-form form-row"
        onsubmit={submitting('status')}
        onfocusout={leaving('status')}
      >
        <TextInput
          bind:value={status}
          placeholder={$i18n.t('settings.statusPlaceholder')}
          maxlength={256}
          aria-label={$i18n.t('settings.status')}
        />
      </form>
    </SettingsSection>

    <SettingsSection title={$i18n.t('settings.profileColors')} headingId="profile-colors">
      <form class="settings-form form-stack" onsubmit={submitting('colors')}>
        <ColorSetting
          label={$i18n.t('settings.profileColorsOnDark')}
          bind:value={darkColor}
          onCommit={() => void autosave('colors')}
          onReset={() => {
            darkColor = '';
            void autosave('colors');
          }}
        />
        <ColorSetting
          label={$i18n.t('settings.profileColorsOnLight')}
          bind:value={lightColor}
          onCommit={() => void autosave('colors')}
          onReset={() => {
            lightColor = '';
            void autosave('colors');
          }}
        />
        <ColorSetting
          label={$i18n.t('settings.profileColorsBackground')}
          bind:value={heroColor}
          onCommit={() => void autosave('colors')}
          onReset={() => {
            heroColor = '';
            void autosave('colors');
          }}
        />
        <label
          >{$i18n.t('settings.profileColorsBrightness')}<Select
            bind:value={brightness}
            items={[
              { value: 'light', label: $i18n.t('settings.profileColorsBrightnessLight') },
              { value: 'dark', label: $i18n.t('settings.profileColorsBrightnessDark') },
            ]}
            onValueChange={() => void autosave('colors')}
          /></label
        >
      </form>
    </SettingsSection>

    <SettingsSection title={$i18n.t('settings.pronounsAndTimezone')} headingId="profile-identity">
      <form
        class="settings-form form-stack"
        onsubmit={submitting('identity')}
        onfocusout={leaving('identity')}
      >
        <label
          >{$i18n.t('settings.pronouns')}
          <TextInput
            bind:value={pronouns}
            placeholder={$i18n.t('settings.pronounsPlaceholder')}
          /></label
        >
        <label
          >{$i18n.t('settings.timezone')}<TextInput
            bind:value={timezone}
            placeholder={$i18n.t('settings.timezonePlaceholder')}
          /></label
        >
      </form>
    </SettingsSection>

    <SettingsSection
      title={$i18n.t('settings.biography')}
      description={$i18n.t('settings.biographyHint')}
      headingId="profile-bio"
    >
      <form class="settings-form form-stack" onfocusout={leaving('bio')}>
        <TextArea
          bind:value={bio}
          rows={5}
          maxlength={5000}
          aria-label={$i18n.t('settings.biography')}
        />
      </form>
    </SettingsSection>

    <SettingsSection title={$i18n.t('settings.animalIdentity')} headingId="profile-animal">
      <form
        class="settings-form form-stack"
        onsubmit={submitting('animal')}
        onfocusout={leaving('animal')}
      >
        <label
          >{$i18n.t('settings.animalIdentityWhatIs')}<TextInput
            bind:value={isAnimal}
            placeholder={$i18n.t('settings.animalIdentityWhatIsPlaceholder')}
          /></label
        >
        <label
          >{$i18n.t('settings.animalIdentityWhatHas')}<TextInput
            bind:value={hasAnimal}
            placeholder={$i18n.t('settings.animalIdentityWhatHasPlaceholder')}
          /></label
        >
        <label
          >{$i18n.t('settings.animalIdentityWhatNeeds')}<TextInput
            bind:value={animalNeed}
            placeholder={$i18n.t('settings.animalIdentityWhatNeedsPlaceholder')}
          /></label
        >
      </form>
    </SettingsSection>

    <SettingsSection title={$i18n.t('settings.otherProfileFields')} headingId="profile-extra">
      <SettingsRow id="other-profile-fields" title={$i18n.t('settings.otherProfileFieldsTitle')}>
        {#snippet description()}
          <span>{$i18n.t('settings.otherProfileFieldsDescription')}</span>
          <span aria-label={$i18n.t('settings.otherProfileFieldsKaomojiTranslation')}
            >{$i18n.t('settings.otherProfileFieldsKaomoji')}</span
          >
        {/snippet}
        <Button
          variant="secondary"
          size="small"
          onclick={() => {
            editKey = { key: '', value: '', original: '' };
          }}
        >
          {$i18n.t('settings.addButton')}
        </Button>
      </SettingsRow>
      <div class="settings-form extra-fields">
        {#if profile.extra.length || editKey}
          <div class="extra-list">
            {#each profile.extra as field, i (i)}
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
        {:else}
          <span>{$i18n.t('settings.otherProfileFieldsEmpty')}</span>
        {/if}
        {#if editKey !== undefined}
          <div class="extra-edit">
            <TextInput
              bind:value={editKey.key}
              maxlength={256}
              placeholder={$i18n.t('settings.otherProfileFieldsKeyPlaceholder')}
            />
            <TextArea
              bind:value={editKey.value}
              rows={5}
              maxlength={5000}
              placeholder={$i18n.t('settings.otherProfileFieldsValuePlaceholder')}
            />
            <div class="extra-buttons">
              <Button
                size="small"
                onclick={() => {
                  if (!editKey || editKey.key.length === 0) return;
                  if (editKey.original === editKey.key) {
                    void save('field', [[editKey.key, editKey.value]]);
                  } else {
                    void save('field', [
                      [editKey.key, editKey.value],
                      [editKey.original, null],
                    ]);
                  }
                  const oldPosition = profile.extra.findIndex(
                    (field) => field.key === editKey?.original
                  );
                  if (oldPosition !== -1) profile.extra.splice(oldPosition, 1);
                  profile.extra.push({ key: editKey.key, value: editKey.value });
                  profile.extra = profile.extra.sort((a, b) => a.key.localeCompare(b.key));
                  editKey = undefined;
                }}>{$i18n.t('settings.saveButton')}</Button
              >
              <Button
                variant="danger"
                size="small"
                onclick={() => {
                  if (!editKey) return;
                  void save(
                    'field',
                    editKey.original === editKey.key
                      ? [[editKey.key, null]]
                      : [
                          [editKey.key, null],
                          [editKey.original, null],
                        ]
                  );
                  editKey = undefined;
                }}>{$i18n.t('settings.removeButton')}</Button
              >
              <Button size="small" onclick={() => (editKey = undefined)}>
                {$i18n.t('settings.cancel')}
              </Button>
            </div>
          </div>
        {/if}
      </div>
    </SettingsSection>
  {/if}

  {#if section === 'account'}<SettingsSection
      title={$i18n.t('settings.contactInformation')}
      headingId="account-contact"
    >
      <div class="settings-form form-row">
        {#if emails.length}{#each emails as email (email)}<code>{email}</code>{/each}{:else}<span
            >{$i18n.t('settings.contactInformationNoEmail')}</span
          >{/if}
      </div>
    </SettingsSection>

    <SettingsSection title={$i18n.t('settings.blockedUsers')} headingId="account-blocked">
      <div class="settings-form">
        <form
          class="form-row"
          onsubmit={(event) => {
            event.preventDefault();
            void block();
          }}
        >
          <TextInput
            bind:value={userToBlock}
            placeholder={$i18n.t('settings.blockedUsersPlaceholder')}
          />
          <Button type="submit" loading={saving === 'block'}
            >{$i18n.t('settings.blockButton')}</Button
          >
        </form>
        {#if ignored.length}<ul class="ignored-users">
            {#each ignored as userId (userId)}<li>
                <code>{userId}</code><Button
                  variant="danger"
                  size="small"
                  loading={saving === userId}
                  onclick={() => void unblock(userId)}>{$i18n.t('settings.unblockButton')}</Button
                >
              </li>{/each}
          </ul>{/if}
      </div>
    </SettingsSection>{/if}
</div>

<style>
  .profile-stack {
    display: grid;
    gap: var(--space-400);
  }

  .banner-row,
  .form-row {
    align-items: center;
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-300);
  }

  .banner-setting {
    display: grid;
    gap: var(--space-200);
  }

  .setting-label {
    font-weight: var(--font-weight-medium);
  }

  .form-row :global(.text-input) {
    flex: 1;
    min-width: 10rem;
  }

  .form-stack label {
    display: grid;
    font-weight: var(--font-weight-medium);
    gap: var(--space-200);
  }

  .banner-setting :global(.banner) {
    border-radius: var(--radius);
    height: 6rem;
    object-fit: cover;
    width: 100%;
  }

  .file-button {
    cursor: pointer;
  }

  .file-button input {
    height: 1px;
    opacity: 0;
    position: absolute;
    width: 1px;
  }

  .ignored-users {
    display: grid;
    gap: var(--space-300);
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .ignored-users li {
    align-items: center;
    display: flex;
    gap: var(--space-300);
    justify-content: space-between;
  }

  .extra-fields {
    display: grid;
    gap: var(--space-300);
    margin: 0;
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
