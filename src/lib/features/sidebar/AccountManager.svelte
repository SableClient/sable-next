<script lang="ts">
  import { goto } from '$app/navigation';
  import { resolve } from '$app/paths';
  import type { ProfileView } from '#src/generated/ProfileView';
  import { useCoreClient } from '#lib/core/context.js';
  import { pushOverride } from '#lib/features/notifications/push-config.js';
  import { logoutWithPush } from '#lib/features/notifications/web-push.js';
  import { i18n } from '#lib/i18n.js';
  import Alert from '#lib/ui/primitives/Alert.svelte';
  import Avatar from '#lib/ui/primitives/Avatar.svelte';
  import Button from '#lib/ui/primitives/Button.svelte';
  import DialogFrame from '#lib/ui/primitives/DialogFrame.svelte';
  import ProfileCard from '#lib/ui/primitives/ProfileCard.svelte';
  import SettingsSheet from '#lib/features/settings/SettingsSheet.svelte';

  const core = useCoreClient();
  let switching = $state(false);
  let removing = $state(false);
  let removeAccountId = $state<string | null>(null);
  let error = $state<string | null>(null);
  let settingsOpen = $state(false);
  let profile = $state<ProfileView | null>(null);
  let activeAccountId = $derived(core.session?.account_id);
  let activeUserId = $derived(core.session?.user_id ?? '');
  let displayName = $derived(profile?.display_name ?? activeUserId);
  let profileColor = $derived(profile?.hero_color ?? 'var(--sable-primary-container)');
  let accountToRemove = $derived(
    core.accounts.find((account) => account.account_id === removeAccountId) ?? null
  );

  $effect(() => {
    if (!activeUserId) return;

    let cancelled = false;
    void core.userProfile(activeUserId).then(
      (next) => {
        if (!cancelled) profile = next;
      },
      () => {}
    );
    return () => {
      cancelled = true;
    };
  });

  async function switchAccount(accountId: string): Promise<void> {
    if (accountId === activeAccountId || switching) return;

    switching = true;
    error = null;
    try {
      await core.switchAccount(accountId);
      await goto(resolve('/(app)/rooms'));
    } catch {
      error = $i18n.t('nav.switchAccount');
    } finally {
      switching = false;
    }
  }

  async function removeAccount(): Promise<void> {
    if (!accountToRemove || removing) return;

    removing = true;
    error = null;
    try {
      await core.removeAccount(accountToRemove.account_id);
      removeAccountId = null;
    } catch {
      error = $i18n.t('nav.removeAccountFailed');
    } finally {
      removing = false;
    }
  }
</script>

<svelte:head>
  <title>{$i18n.t('nav.manageAccounts')} - Sable</title>
</svelte:head>

{#snippet profileActions()}
  <Button variant="secondary" size="small" onclick={() => (settingsOpen = true)}
    >{$i18n.t('nav.settings')}</Button
  >
  <Button variant="secondary" size="small" onclick={() => void goto(resolve('settings/account'))}
    >{$i18n.t('nav.editProfile')}</Button
  >
{/snippet}

<main class="account-manager">
  <ProfileCard
    variant="sheet"
    {displayName}
    userId={activeUserId}
    avatarUrl={profile?.avatar_url}
    color={profileColor}
    heroColor={profile?.hero_color}
    heroBrightness={profile?.hero_brightness}
    bannerUrl={profile?.banner_url}
    status={profile?.status?.text}
    statusEmoji={profile?.status?.emoji}
    nameColorLight={profile?.name_color_light}
    nameColorDark={profile?.name_color_dark}
    actions={profileActions}
  />

  <section class="account-list" aria-labelledby="account-list-title">
    <div class="section-heading">
      <h1 id="account-list-title">{$i18n.t('nav.switchAccount')}</h1>
      <p>{$i18n.t('nav.manageAccountsDescription')}</p>
    </div>
    {#if error}<Alert variant="critical" role="alert">{error}</Alert>{/if}
    {#each core.accounts as account (account.account_id)}
      {@const active = account.account_id === activeAccountId}
      <article class="account-row sable-choice" data-selected={active ? 'true' : undefined}>
        <button
          class="account-select"
          type="button"
          disabled={active || switching}
          onclick={() => void switchAccount(account.account_id)}
        >
          <Avatar size="medium" name={account.user_id} />
          <span class="account-identity">
            <strong>{account.user_id}</strong>
            <small>{active ? $i18n.t('nav.activeAccount') : account.device_id}</small>
          </span>
        </button>
        {#if active}
          <Button
            variant="secondary"
            size="small"
            onclick={() => void goto(resolve('settings/account'))}
            >{$i18n.t('nav.editProfile')}</Button
          >
          <Button
            variant="danger"
            size="small"
            onclick={() => void logoutWithPush(core, pushOverride())}
            >{$i18n.t('settings.logout')}</Button
          >
        {:else}
          <Button
            variant="danger"
            size="small"
            onclick={() => {
              removeAccountId = account.account_id;
            }}>{$i18n.t('nav.removeAccount')}</Button
          >
        {/if}
      </article>
    {/each}
    <Button variant="secondary" onclick={() => void goto(resolve('login?addAccount=1'))}
      >{$i18n.t('nav.addAccount')}</Button
    >
  </section>
</main>

<DialogFrame
  open={accountToRemove !== null}
  variant="verification"
  label={$i18n.t('nav.removeAccountConfirm')}
  onOpenChange={(open) => {
    if (!open && !removing) removeAccountId = null;
  }}
>
  <div class="remove-dialog">
    <h2>{$i18n.t('nav.removeAccountConfirm')}</h2>
    <p>{$i18n.t('nav.removeAccountDescription')}</p>
    <div class="dialog-actions">
      <Button variant="ghost" disabled={removing} onclick={() => (removeAccountId = null)}
        >{$i18n.t('settings.cancel')}</Button
      >
      <Button variant="danger" loading={removing} onclick={() => void removeAccount()}
        >{$i18n.t('nav.removeAccount')}</Button
      >
    </div>
  </div>
</DialogFrame>

{#if settingsOpen}
  <SettingsSheet bind:open={settingsOpen} />
{/if}

<style>
  .account-manager {
    align-content: start;
    display: grid;
    gap: var(--space-500);
    margin: 0 auto;
    max-width: 42rem;
    overflow: auto;
    padding: var(--page-gutter);
    width: 100%;
  }

  .account-list {
    display: grid;
    gap: var(--space-300);
  }

  .section-heading {
    margin-bottom: var(--space-200);
  }

  .section-heading h1,
  .section-heading p {
    margin: 0;
  }

  .section-heading h1 {
    font-size: var(--font-size-heading);
  }

  .section-heading p {
    color: var(--sable-surface-var-on-container);
    margin-top: var(--space-200);
  }

  .account-row {
    align-items: center;
    background: var(--sable-surface-container);
    border: var(--border-width) solid var(--sable-surface-container-line);
    border-radius: var(--radius);
    display: flex;
    gap: var(--space-300);
    padding: var(--space-300);
  }

  .account-select {
    align-items: center;
    background: transparent;
    border: 0;
    color: inherit;
    cursor: pointer;
    display: flex;
    flex: 1;
    gap: var(--space-300);
    min-width: 0;
    padding: 0;
    text-align: left;
  }

  .account-select:disabled {
    cursor: default;
  }

  .account-row:not([data-selected='true']) .account-select:not(:disabled):hover {
    color: var(--sable-primary-main);
  }

  .account-identity {
    display: grid;
    min-width: 0;
  }

  strong,
  small {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  small,
  .remove-dialog p {
    color: var(--sable-surface-var-on-container);
  }

  .remove-dialog {
    display: grid;
    gap: var(--space-400);
    width: min(26rem, calc(100vw - 2rem));
  }

  .remove-dialog h2,
  .remove-dialog p {
    margin: 0;
  }

  .dialog-actions {
    display: flex;
    gap: var(--space-200);
    justify-content: flex-end;
  }
</style>
