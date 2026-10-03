<script lang="ts">
  import type { ProfileView } from '#src/generated/protocol';
  import { i18n } from '#lib/i18n.js';

  import { useCoreClient } from '#lib/core/context.js';
  import Alert from '#lib/ui/primitives/Alert.svelte';
  import Button from '#lib/ui/primitives/Button.svelte';
  import SettingsSection from '#lib/ui/primitives/SettingsSection.svelte';
  import TextInput from '#lib/ui/primitives/TextInput.svelte';
  import '#lib/ui/primitives/settings-row.css';

  interface Props {
    profile: ProfileView;
  }

  let { profile }: Props = $props();
  const core = useCoreClient();
  let emails = $state<string[]>([]);
  let ignored = $state<string[]>([]);
  let userToBlock = $state('');
  let saving = $state<string | null>(null);
  let error = $state<string | null>(null);

  $effect(() => {
    void core.session?.user_id;
    void profile.user_id;
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

  <SettingsSection title={$i18n.t('settings.contactInformation')} headingId="account-contact">
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
        <Button type="submit" loading={saving === 'block'}>{$i18n.t('settings.blockButton')}</Button
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
  </SettingsSection>
</div>

<style>
  .profile-stack {
    display: grid;
    gap: var(--space-400);
    grid-template-columns: minmax(0, 1fr);
  }

  .form-row {
    align-items: center;
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-300);
  }

  .form-row :global(.text-input) {
    flex: 1;
    min-width: 10rem;
  }

  .form-row code,
  .ignored-users code {
    min-width: 0;
    overflow-wrap: anywhere;
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
    min-width: 0;
  }

  .ignored-users code {
    flex: 1;
  }
</style>
