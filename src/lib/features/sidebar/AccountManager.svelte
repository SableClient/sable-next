<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { resolve } from '$app/paths';
  import type { PresenceView, ProfileView } from '#src/generated/protocol';
  import { runtimeConfig } from '#lib/config/runtime-config.js';
  import { useCoreClient } from '#lib/core/context.js';
  import { pushOverride } from '#lib/features/notifications/push-config.js';
  import { logoutWithPush } from '#lib/features/notifications/web-push.js';
  import { i18n } from '#lib/i18n.js';
  import DotsThreeVerticalIcon from 'phosphor-svelte/lib/DotsThreeVerticalIcon';
  import GearIcon from 'phosphor-svelte/lib/GearIcon';
  import PlusIcon from 'phosphor-svelte/lib/PlusIcon';
  import SignOutIcon from 'phosphor-svelte/lib/SignOutIcon';
  import TrashIcon from 'phosphor-svelte/lib/TrashIcon';
  import ActionMenu from '#lib/ui/primitives/ActionMenu.svelte';
  import ActionMenuItem from '#lib/ui/primitives/ActionMenuItem.svelte';
  import Alert from '#lib/ui/primitives/Alert.svelte';
  import Avatar from '#lib/ui/primitives/Avatar.svelte';
  import BottomSheet from '#lib/ui/primitives/BottomSheet.svelte';
  import Button from '#lib/ui/primitives/Button.svelte';
  import DialogActions from '#lib/ui/primitives/DialogActions.svelte';
  import DialogFrame from '#lib/ui/primitives/DialogFrame.svelte';
  import IconButton from '#lib/ui/primitives/IconButton.svelte';
  import Pill from '#lib/ui/primitives/Pill.svelte';
  import OptionCards from '#lib/ui/primitives/OptionCards.svelte';
  import type { OptionCard } from '#lib/ui/primitives/option-card.js';
  import PresenceDot from '#lib/ui/primitives/PresenceDot.svelte';
  import SettingsRow from '#lib/ui/primitives/SettingsRow.svelte';
  import SettingsSection from '#lib/ui/primitives/SettingsSection.svelte';
  import StatusBadge from '#lib/ui/primitives/StatusBadge.svelte';
  import '#lib/ui/primitives/settings-row.css';
  import { usePresenceStore } from '#lib/rooms/presence.svelte.js';
  import { resolveUserStatus } from '#lib/rooms/user-status.js';
  import { SignOutGuard } from './sign-out-guard.svelte.js';
  import SignOutWarningDialog from './SignOutWarningDialog.svelte';
  import FormField from '#lib/ui/primitives/FormField.svelte';
  import ProfileCard from '#lib/ui/primitives/ProfileCard.svelte';
  import TextInput from '#lib/ui/primitives/TextInput.svelte';
  import { preferences, setPreference } from '#lib/settings/preferences.svelte.js';
  import { AccountDirectory } from './account-directory.svelte.js';

  const core = useCoreClient();
  const presenceStore = usePresenceStore();
  const accountProfiles = new AccountDirectory(core);
  const signOut = new SignOutGuard(core);
  let switching = $state(false);
  let accountSwitching = $state(true);
  let removing = $state(false);
  let removeAccountId = $state<string | null>(null);
  let error = $state<string | null>(null);
  let profile = $state<ProfileView | null>(null);
  let activeAccountId = $derived(core.session?.account_id);
  let activeUserId = $derived(core.session?.user_id ?? '');
  let displayName = $derived(profile?.display_name ?? activeUserId);
  let userStatus = $derived(resolveUserStatus(profile, presenceStore.get(activeUserId)));
  let profileColor = $derived(profile?.hero_color ?? 'var(--primary-container)');
  let presenceOptions = $derived<OptionCard<PresenceView>[]>([
    { value: 'online', label: $i18n.t('presence.online') },
    { value: 'unavailable', label: $i18n.t('presence.unavailable') },
    { value: 'offline', label: $i18n.t('presence.offline') },
  ]);
  let statusDraft = $state(preferences.presenceStatusMessage);
  let statusOpen = $state(false);
  let ownStatus = $derived(preferences.presenceStatusMessage.trim());
  let listedAccounts = $derived(
    accountSwitching
      ? core.accounts
      : core.accounts.filter((account) => account.account_id === activeAccountId)
  );
  let accountToRemove = $derived(
    core.accounts.find((account) => account.account_id === removeAccountId) ?? null
  );

  onMount(() => {
    void runtimeConfig().then((config) => {
      accountSwitching = !config.disableAccountSwitcher;
    });
  });

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

  function saveStatusMessage(): void {
    setPreference('presenceStatusMessage', statusDraft.trim());
    statusOpen = false;
  }

  function reauthenticate(homeserver: string, accountId: string): Promise<void> {
    return goto(
      resolve(
        `login?addAccount=1&reauth=${encodeURIComponent(accountId)}&server=${encodeURIComponent(homeserver)}`
      )
    );
  }

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
  <Button class="profile-settings" variant="primary" onclick={() => void goto(resolve('settings'))}
    ><GearIcon aria-hidden="true" />{$i18n.t('nav.settings')}</Button
  >
  <Pill onclick={() => void goto(resolve('settings/account'))}>{$i18n.t('nav.editProfile')}</Pill>
{/snippet}

{#snippet statusBubble()}
  <button
    class="status-bubble"
    type="button"
    aria-haspopup="dialog"
    aria-expanded={statusOpen}
    aria-label={`${$i18n.t('presence.setStatus')}: ${$i18n.t(`presence.${preferences.presence}`)}${ownStatus ? `, ${ownStatus}` : ''}`}
    onclick={() => {
      statusDraft = preferences.presenceStatusMessage;
      statusOpen = true;
    }}
  >
    <span class="status-bubble-presence">
      <PresenceDot presence={preferences.presence} label="" size="medium" />
      {$i18n.t(`presence.${preferences.presence}`)}
    </span>
    <span class="status-bubble-text" class:placeholder={!ownStatus}
      >{ownStatus || $i18n.t('presence.statusMessagePlaceholder')}</span
    >
  </button>
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
    status={userStatus?.text}
    statusEmoji={userStatus?.emoji}
    nameColorLight={profile?.name_color_light}
    nameColorDark={profile?.name_color_dark}
    actions={profileActions}
    crest={preferences.sendPresence ? statusBubble : undefined}
  />

  {#snippet addAccount()}
    <Button
      variant="secondary"
      size="small"
      onclick={() => void goto(resolve('login?addAccount=1'))}
      ><PlusIcon aria-hidden="true" />{$i18n.t('nav.addAccount')}</Button
    >
  {/snippet}
  <SettingsSection
    headingId="account-list-title"
    title={$i18n.t('nav.accounts')}
    actions={accountSwitching ? addAccount : undefined}
  >
    {#if error}<Alert variant="critical" role="alert">{error}</Alert>{/if}
    <ul class="settings-rows">
      {#each listedAccounts as account (account.account_id)}
        {@const active = account.account_id === activeAccountId}
        {@const identity = accountProfiles.identity(account.user_id)}
        <SettingsRow
          class="account-row"
          title={identity.displayName}
          description={account.needs_reauth ? $i18n.t('nav.accountSignedOut') : account.user_id}
        >
          {#snippet before()}
            <Avatar
              size="medium"
              id={account.user_id}
              name={identity.displayName}
              src={identity.avatarUrl}
            />
          {/snippet}
          {#if active}
            <StatusBadge variant="success" label={$i18n.t('nav.activeAccount')} />
          {:else}
            <Button
              variant="secondary"
              size="small"
              disabled={switching}
              onclick={() =>
                void (account.needs_reauth
                  ? reauthenticate(account.homeserver, account.account_id)
                  : switchAccount(account.account_id))}
              >{$i18n.t(account.needs_reauth ? 'nav.accountSignInAgain' : 'nav.switch')}</Button
            >
            <ActionMenu label={$i18n.t('nav.moreOptions')}>
              {#snippet trigger({ props })}
                <IconButton
                  {...props}
                  variant="ghost"
                  size="small"
                  class="selection-open"
                  label={$i18n.t('nav.moreOptions')}
                >
                  <DotsThreeVerticalIcon />
                </IconButton>
              {/snippet}
              <ActionMenuItem
                destructive
                onSelect={() => {
                  removeAccountId = account.account_id;
                }}
              >
                <TrashIcon aria-hidden="true" />
                <span>{$i18n.t('nav.removeAccount')}</span>
              </ActionMenuItem>
            </ActionMenu>
          {/if}
        </SettingsRow>
      {/each}
    </ul>
  </SettingsSection>

  <Button
    variant="danger"
    block
    loading={signOut.checking}
    onclick={() => void signOut.request(() => logoutWithPush(core, pushOverride()))}
    ><SignOutIcon aria-hidden="true" />{$i18n.t('settings.logout')}</Button
  >
</main>

<BottomSheet
  bind:open={statusOpen}
  label={$i18n.t('presence.setStatus')}
  closeLabel={$i18n.t('settings.cancel')}
>
  <form
    class="status-sheet"
    onsubmit={(event) => {
      event.preventDefault();
      saveStatusMessage();
    }}
  >
    <h2>{$i18n.t('presence.title')}</h2>
    <OptionCards
      label={$i18n.t('presence.title')}
      options={presenceOptions}
      value={preferences.presence}
      onSelect={(value) => setPreference('presence', value)}
    />
    <FormField fieldId="presence-status-message" label={$i18n.t('presence.statusMessage')}>
      <div class="status-message">
        <TextInput
          id="presence-status-message"
          bind:value={statusDraft}
          maxlength={120}
          placeholder={$i18n.t('presence.statusMessagePlaceholder')}
        />
        <Button type="submit" disabled={statusDraft.trim() === preferences.presenceStatusMessage}
          >{$i18n.t('presence.statusMessageSave')}</Button
        >
      </div>
    </FormField>
  </form>
</BottomSheet>

<SignOutWarningDialog guard={signOut} />

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
    <DialogActions>
      <Button variant="ghost" disabled={removing} onclick={() => (removeAccountId = null)}
        >{$i18n.t('settings.cancel')}</Button
      >
      <Button variant="danger" loading={removing} onclick={() => void removeAccount()}
        >{$i18n.t('nav.removeAccount')}</Button
      >
    </DialogActions>
  </div>
</DialogFrame>

<style>
  .account-manager {
    align-content: start;
    display: grid;
    gap: var(--space-500);
    grid-auto-rows: max-content;
    margin: 0 auto;
    max-width: 42rem;
    overflow: auto;
    overscroll-behavior: contain;
    padding: var(--page-gutter);
    width: 100%;
  }

  .account-manager :global(.profile-settings) {
    min-height: max(var(--control-height-400), var(--target-hit));
  }

  .status-bubble {
    background: var(--profile-panel-ground);
    border: var(--border-width) solid var(--profile-line);
    border-radius: var(--radii-500) var(--radii-500) var(--radii-500) var(--radii-200);
    color: inherit;
    cursor: pointer;
    display: grid;
    font: inherit;
    gap: var(--space-050);
    margin: 0 0 var(--space-100);
    max-width: 100%;
    min-width: 0;
    padding: var(--space-200) var(--space-300);
    text-align: start;
  }

  .status-bubble:focus-visible {
    outline: var(--focus-ring-width) solid var(--focus-ring);
    outline-offset: var(--focus-ring-offset);
  }

  .status-bubble-presence {
    align-items: center;
    color: var(--profile-text-muted);
    display: flex;
    font-size: var(--font-size-small);
    font-weight: var(--font-weight-medium);
    gap: var(--space-150);
    line-height: var(--line-height-small);
  }

  .status-bubble-text {
    -webkit-box-orient: vertical;
    display: -webkit-box;
    font-size: var(--font-size-label);
    -webkit-line-clamp: 2;
    line-clamp: 2;
    line-height: var(--line-height-small);
    overflow: hidden;
    overflow-wrap: anywhere;
  }

  .status-bubble-text.placeholder {
    color: var(--profile-text-muted);
  }

  @media (hover: hover) and (pointer: fine) {
    .status-bubble:hover {
      border-color: var(--profile-text-muted);
    }
  }

  @media (prefers-reduced-motion: no-preference) {
    :global(html:not([data-reduced-motion='on'])) .status-bubble {
      transition:
        scale var(--duration-fast) var(--ease-smooth-out),
        border-color var(--duration-fast) var(--ease-smooth-out);
    }

    :global(html:not([data-reduced-motion='on'])) .status-bubble:active {
      scale: 0.97;
    }
  }

  .account-manager :global(.settings-section-header) {
    align-items: center;
  }

  .account-manager :global(.setting-row.account-row) {
    flex-wrap: nowrap;
    gap: var(--space-300);
  }

  .account-manager :global(.account-row .row-copy) {
    flex-basis: 0;
  }

  .account-manager :global(.account-row .row-copy .name),
  .account-manager :global(.account-row .row-copy p) {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .account-manager :global(.account-row .row-control) {
    align-items: center;
    display: flex;
    flex: none;
    gap: var(--space-100);
  }

  .status-sheet {
    display: grid;
    gap: var(--space-400);
    padding: 0 var(--space-400);
  }

  .status-sheet h2 {
    font-size: var(--font-size-heading);
    margin: 0;
  }

  .status-message {
    align-items: center;
    display: flex;
    gap: var(--space-200);
  }

  .remove-dialog p {
    color: var(--surface-var-on-container);
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
</style>
