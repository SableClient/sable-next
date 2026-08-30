<script lang="ts">
  import { untrack } from 'svelte';

  import type { ProfileView } from '#src/generated/ProfileView';

  import { useCoreClient } from '#lib/core/context.js';
  import Alert from '#lib/ui/primitives/Alert.svelte';
  import Button from '#lib/ui/primitives/Button.svelte';
  import Select from '#lib/ui/primitives/Select.svelte';
  import SettingsSection from '#lib/ui/primitives/SettingsSection.svelte';
  import TextArea from '#lib/ui/primitives/TextArea.svelte';
  import TextInput from '#lib/ui/primitives/TextInput.svelte';
  import ColorSetting from './ColorSetting.svelte';

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
      const url = await core.uploadAvatar(
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
      <span class="setting-label">Banner</span>
      <div class="setting-row">
        {#if profile.banner_url}<img
            class="banner"
            src={profile.banner_url}
            alt="Current profile banner"
            width="1000"
            height="375"
          />{/if}
        <label class="file-button sable-button sable-button-secondary sable-button-small">
          <input
            type="file"
            accept="image/*"
            onchange={(event: Event & { currentTarget: HTMLInputElement }) => {
              bannerFile = event.currentTarget.files?.[0] ?? null;
            }}
          />
          {profile.banner_url ? 'Change banner' : 'Upload banner'}
        </label>
        {#if bannerFile}<Button
            size="small"
            loading={saving === 'banner'}
            onclick={() => void saveBanner()}>Save</Button
          >{/if}
        {#if profile.banner_url}<Button
            variant="danger"
            size="small"
            loading={saving === 'banner'}
            onclick={() => void save('banner', [['chat.commet.profile_banner', null]])}
            >Remove</Button
          >{/if}
      </div>
    </div>{/if}

  {#if section === 'profile'}<SettingsSection title="Status" headingId="profile-status">
      <form
        class="form-row"
        onsubmit={(event) => {
          event.preventDefault();
          void save('status', [['m.status', status ? { text: status } : null]]);
        }}
      >
        <TextInput bind:value={status} placeholder="What are you up to?" maxlength={256} />
        <Button type="submit" loading={saving === 'status'}>Save</Button>
      </form>
    </SettingsSection>

    <SettingsSection title="Profile colors" headingId="profile-colors">
      <form
        class="form-stack"
        onsubmit={(event) => {
          event.preventDefault();
          void save('colors', [
            ['eu.she-a.color', { on_light: lightColor, on_dark: darkColor }],
            ['chat.commet.profile_color_scheme', { color: heroColor, brightness }],
          ]);
        }}
      >
        <ColorSetting
          label="Dark theme name color"
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
          label="Light theme name color"
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
          label="Profile card background"
          bind:value={heroColor}
          saving={saving === 'colors'}
          onSave={() =>
            void save('colors', [
              ['chat.commet.profile_color_scheme', { color: heroColor, brightness }],
            ])}
          onReset={() => void save('colors', [['chat.commet.profile_color_scheme', null]])}
        />
        <label
          >Background brightness <Select
            bind:value={brightness}
            items={[
              { value: 'light', label: 'Light' },
              { value: 'dark', label: 'Dark' },
            ]}
          /></label
        >
        <Button type="submit" loading={saving === 'colors'}>Save</Button>
      </form>
    </SettingsSection>

    <SettingsSection title="Pronouns and timezone" headingId="profile-identity">
      <form
        class="form-stack"
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
          >Pronouns <TextInput bind:value={pronouns} placeholder="they/them, she/her (en)" /></label
        >
        <label>Timezone <TextInput bind:value={timezone} placeholder="Europe/Paris" /></label>
        <Button type="submit" loading={saving === 'identity'}>Save</Button>
      </form>
    </SettingsSection>

    <SettingsSection title="Biography" headingId="profile-bio">
      <form
        class="form-stack"
        onsubmit={(event) => {
          event.preventDefault();
          void save('bio', [['moe.sable.app.bio', bio || null]]);
        }}
      >
        <TextArea bind:value={bio} rows={5} maxlength={5000} />
        <Button type="submit" loading={saving === 'bio'}>Save</Button>
      </form>
    </SettingsSection>

    {#if profile.extra.length}
      <SettingsSection title="Other profile fields" headingId="profile-extra">
        <dl class="extra-fields">
          {#each profile.extra as field (field.key)}<div>
              <dt>{field.key}</dt>
              <dd>{field.value}</dd>
            </div>{/each}
        </dl>
      </SettingsSection>
    {/if}
    <SettingsSection title="Animal cosmetics" headingId="profile-animal">
      <form
        class="form-stack"
        onsubmit={(event) => {
          event.preventDefault();
          void save('animal', [
            ['pet.plz.me', isAnimal || null],
            ['pet.plz.my', hasAnimal || null],
            ['pet.plz.gib', animalNeed || null],
          ]);
        }}
      >
        <label>Animal identity <TextInput bind:value={isAnimal} /></label>
        <label>Animals with you <TextInput bind:value={hasAnimal} /></label>
        <label>Animal need <TextInput bind:value={animalNeed} /></label>
        <Button type="submit" loading={saving === 'animal'}>Save</Button>
      </form>
    </SettingsSection>{/if}

  {#if section === 'account'}<SettingsSection
      title="Contact information"
      headingId="account-contact"
    >
      <div class="setting-row">
        {#if emails.length}{#each emails as email (email)}<code>{email}</code>{/each}{:else}<span
            >No email addresses attached to this account.</span
          >{/if}
      </div>
    </SettingsSection>

    <SettingsSection title="Blocked users" headingId="account-blocked">
      <form
        class="form-row"
        onsubmit={(event) => {
          event.preventDefault();
          void block();
        }}
      >
        <TextInput bind:value={userToBlock} placeholder="@user:example.org" />
        <Button type="submit" loading={saving === 'block'}>Block</Button>
      </form>
      {#if ignored.length}<ul class="ignored-users">
          {#each ignored as userId (userId)}<li>
              <code>{userId}</code><Button
                variant="danger"
                size="small"
                loading={saving === userId}
                onclick={() => void unblock(userId)}>Unblock</Button
              >
            </li>{/each}
        </ul>{/if}
    </SettingsSection>{/if}
</div>

<style>
  .profile-stack,
  .form-stack {
    display: grid;
    gap: var(--space-400);
  }

  .setting-row,
  .form-row {
    align-items: center;
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-300);
    padding: var(--space-400);
  }

  .banner-setting {
    display: grid;
    gap: var(--space-200);
  }

  .setting-label {
    font-weight: var(--font-weight-medium);
  }

  .form-stack,
  .form-row {
    padding: var(--space-400);
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

  .banner {
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
    padding: 0 var(--space-400) var(--space-400);
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
    padding: var(--space-400);
  }

  .extra-fields div {
    display: grid;
    gap: var(--space-200);
  }

  .extra-fields dt {
    font-weight: var(--font-weight-medium);
  }

  .extra-fields dd {
    margin: 0;
    overflow-wrap: anywhere;
  }
</style>
