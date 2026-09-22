<script lang="ts">
  import { untrack } from 'svelte';

  import type { ProfileView } from '#src/generated/protocol';
  import { i18n } from '#lib/i18n.js';

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

  interface Props {
    profile: ProfileView;
    onSaved: () => void;
    section: 'banner' | 'profile' | 'account';
  }

  let { profile, onSaved, section }: Props = $props();
  const core = useCoreClient();
  let bannerFile = $state<File | null>(null);
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

  $effect(() => {
    void core.session?.user_id;
    untrack(() => {
      status = profile.status?.text ?? '';
      bio = profile.bio ?? '';
      pronouns = profile.pronouns
        .map(({ summary, language }) => `${summary}${language ? ` (${language})` : ''}`)
        .join(', ');
      timezone = profile.timezone ?? '';
      lightColor = profile.name_color_light ?? '';
      darkColor = profile.name_color_dark ?? '';
      heroColor = profile.hero_color ?? '';
      brightness = profile.hero_brightness ?? 'dark';
      isAnimal = profile.animal?.is_animal ?? '';
      hasAnimal = profile.animal?.has_animal ?? '';
      animalNeed = profile.animal?.animal_need ?? '';
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

  async function save(key: string, fields: Array<[string, unknown]>): Promise<void> {
    if (saving) return;
    saving = key;
    error = null;
    try {
      for (const [field, value] of fields) await core.setProfileField(field, value);
      onSaved();
    } catch {
      error = 'Could not save your profile changes.';
    } finally {
      saving = null;
    }
  }

  async function saveBanner(): Promise<void> {
    if (!bannerFile || saving) return;
    saving = 'banner';
    error = null;
    try {
      const url = await core.commands.uploadMedia(
        bannerFile.type || 'image/*',
        new Uint8Array(await bannerFile.arrayBuffer())
      );
      await core.setProfileField('chat.commet.profile_banner', url);
      bannerFile = null;
      onSaved();
    } catch {
      error = 'Could not save your profile changes.';
    } finally {
      saving = null;
    }
  }

  async function block(): Promise<void> {
    const userId = userToBlock.trim();
    if (!userId || saving) return;
    saving = 'block';
    error = null;
    try {
      await core.setUserIgnored(userId, true);
      ignored = [...ignored, userId].sort();
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

  function pronounSets(): Array<{ summary: string; language?: string }> {
    return pronouns
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => {
        const match = /^(.*?)(?:\s*\(([^)]+)\))?$/.exec(entry);
        return {
          summary: match?.[1]?.trim() || entry,
          ...(match?.[2] ? { language: match[2] } : {}),
        };
      });
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
            onchange={(event: Event & { currentTarget: HTMLInputElement }) => {
              bannerFile = event.currentTarget.files?.[0] ?? null;
            }}
          />
          {profile.banner_url ? $i18n.t('settings.changeBanner') : $i18n.t('settings.saveBanner')}
        </label>
        {#if bannerFile}<Button
            size="small"
            loading={saving === 'banner'}
            onclick={() => void saveBanner()}>{$i18n.t('settings.saveButton')}</Button
          >{/if}
        {#if profile.banner_url}<Button
            variant="danger"
            size="small"
            loading={saving === 'banner'}
            onclick={() => void save('banner', [['chat.commet.profile_banner', null]])}
            >{$i18n.t('settings.removeButton')}</Button
          >{/if}
      </div>
    </div>{/if}

  {#if section === 'profile'}<SettingsSection
      title={$i18n.t('settings.status')}
      headingId="profile-status"
    >
      <form
        class="settings-form form-row"
        onsubmit={(event) => {
          event.preventDefault();
          void save('status', [['m.status', status ? { text: status } : null]]);
        }}
      >
        <TextInput
          bind:value={status}
          placeholder={$i18n.t('settings.statusPlaceholder')}
          maxlength={256}
        />
        <Button type="submit" loading={saving === 'status'}>{$i18n.t('settings.saveButton')}</Button
        >
      </form>
    </SettingsSection>

    <SettingsSection title={$i18n.t('settings.profileColors')} headingId="profile-colors">
      <form
        class="settings-form form-stack"
        onsubmit={(event) => {
          event.preventDefault();
          void save('colors', [
            ['eu.she-a.color', { on_light: lightColor, on_dark: darkColor }],
            ['chat.commet.profile_color_scheme', { color: heroColor, brightness }],
          ]);
        }}
      >
        <ColorSetting
          label={$i18n.t('settings.profileColorsOnDark')}
          bind:value={darkColor}
          saving={saving === 'colors'}
          onSave={() =>
            void save('colors', [['eu.she-a.color', { on_light: lightColor, on_dark: darkColor }]])}
          onReset={() =>
            void save('colors', [
              ['eu.she-a.color', { on_light: lightColor || null, on_dark: null }],
            ])}
        />
        <ColorSetting
          label={$i18n.t('settings.profileColorsOnLight')}
          bind:value={lightColor}
          saving={saving === 'colors'}
          onSave={() =>
            void save('colors', [['eu.she-a.color', { on_light: lightColor, on_dark: darkColor }]])}
          onReset={() =>
            void save('colors', [
              ['eu.she-a.color', { on_light: null, on_dark: darkColor || null }],
            ])}
        />
        <ColorSetting
          label={$i18n.t('settings.profileColorsBackground')}
          bind:value={heroColor}
          saving={saving === 'colors'}
          onSave={() =>
            void save('colors', [
              ['chat.commet.profile_color_scheme', { color: heroColor, brightness }],
            ])}
          onReset={() => void save('colors', [['chat.commet.profile_color_scheme', null]])}
        />
        <label
          >{$i18n.t('settings.profileColorsBrightness')}<Select
            bind:value={brightness}
            items={[
              { value: 'light', label: $i18n.t('settings.profileColorsBrightnessLight') },
              { value: 'dark', label: $i18n.t('settings.profileColorsBrightnessDark') },
            ]}
          /></label
        >
        <Button type="submit" loading={saving === 'colors'}>{$i18n.t('settings.saveButton')}</Button
        >
      </form>
    </SettingsSection>

    <SettingsSection title={$i18n.t('settings.pronounsAndTimezone')} headingId="profile-identity">
      <form
        class="settings-form form-stack"
        onsubmit={(event) => {
          event.preventDefault();
          void save('identity', [
            ['io.fsky.nyx.pronouns', pronounSets()],
            ['m.tz', timezone || null],
            ['us.cloke.msc4175.tz', timezone || null],
          ]);
        }}
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
        <Button type="submit" loading={saving === 'identity'}
          >{$i18n.t('settings.saveButton')}</Button
        >
      </form>
    </SettingsSection>

    <!-- very sloppy fix, WILL NEED A PROPER IMPLEMENTATION LATER i just cba to figure it out rnrn -->
    <SettingsSection title={$i18n.t('settings.biography')} headingId="profile-bio">
      <form
        class="settings-form form-stack"
        onsubmit={(event) => {
          event.preventDefault();
          void save('bio', [
            [
              'gay.fomx.biography',
              bio
                ? {
                    'm.text': [
                      { body: bio, mimetype: 'text/html' },
                      {
                        body: bio,
                      },
                    ],
                  }
                : null,
            ],
          ]);
        }}
      >
        <TextArea bind:value={bio} rows={5} maxlength={5000} />
        <Button type="submit" loading={saving === 'bio'}>{$i18n.t('settings.saveButton')}</Button>
      </form>
    </SettingsSection>

    <SettingsSection title={$i18n.t('settings.animalIdentity')} headingId="profile-animal">
      <form
        class="settings-form form-stack"
        onsubmit={(event) => {
          event.preventDefault();
          void save('animal', [
            ['pet.plz.me', isAnimal || null],
            ['pet.plz.my', hasAnimal || null],
            ['pet.plz.gib', animalNeed || null],
          ]);
        }}
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
        <Button type="submit" loading={saving === 'animal'}>{$i18n.t('settings.saveButton')}</Button
        >
      </form>
    </SettingsSection>

    <SettingsSection title={$i18n.t('settings.otherProfileFields')} headingId="profile-extra">
      <SettingsRow title={$i18n.t('settings.otherProfileFieldsTitle')}>
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
