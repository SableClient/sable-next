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
  import CheckCircleIcon from 'phosphor-svelte/lib/CheckCircleIcon';
  import GearIcon from 'phosphor-svelte/lib/GearIcon';
  import PencilSimpleIcon from 'phosphor-svelte/lib/PencilSimpleIcon';
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
  import OptionCards from '#lib/ui/primitives/OptionCards.svelte';
  import type { OptionCard } from '#lib/ui/primitives/option-card.js';
  import PresenceDot from '#lib/ui/primitives/PresenceDot.svelte';
  import StatusBadge from '#lib/ui/primitives/StatusBadge.svelte';
  import Spinner from '#lib/ui/primitives/Spinner.svelte';
  import { resolveUserStatus } from '#lib/rooms/user-status.js';
  import { LEGACY_STATUS_FIELDS, STATUS_FIELD, legacyDeletes } from '#lib/profile/fields.js';
  import { SignOutGuard } from './sign-out-guard.svelte.js';
  import SignOutWarningDialog from './SignOutWarningDialog.svelte';
  import FormField from '#lib/ui/primitives/FormField.svelte';
  import ProfileCard from '#lib/ui/primitives/ProfileCard.svelte';
  import TextInput from '#lib/ui/primitives/TextInput.svelte';
  import { preferences, setPreference } from '#lib/settings/preferences.svelte.js';
  import { AccountDirectory } from './account-directory.svelte.js';

  const core = useCoreClient();
  const accountProfiles = new AccountDirectory(core);
  const signOut = new SignOutGuard(core);
  let switchingAccountId = $state<string | null>(null);
  let accountSwitching = $state(true);
  let removing = $state(false);
  let removeAccountId = $state<string | null>(null);
  let error = $state<string | null>(null);
  let profile = $state<ProfileView | null>(null);
  let activeAccountId = $derived(core.session?.account_id);
  let activeUserId = $derived(core.session?.user_id ?? '');
  let displayName = $derived(profile?.display_name ?? activeUserId);
  let userStatus = $derived(
    resolveUserStatus(profile, { statusMessage: preferences.presenceStatusMessage })
  );
  let profileColor = $derived(profile?.hero_color ?? 'var(--primary-container)');
  let presenceOptions = $derived<OptionCard<PresenceView>[]>([
    { value: 'online', label: $i18n.t('presence.online') },
    { value: 'unavailable', label: $i18n.t('presence.unavailable') },
    { value: 'offline', label: $i18n.t('presence.offline') },
  ]);
  let statusDraft = $state(preferences.presenceStatusMessage);
  let presenceDraft = $state<PresenceView>(preferences.presence);
  let statusOpen = $state(false);
  let statusSaving = $state(false);
  let statusError = $state<string | null>(null);
  let ownStatus = $derived(userStatus?.text ?? '');
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

  async function saveStatusMessage(): Promise<void> {
    statusSaving = true;
    statusError = null;
    const text = statusDraft.trim();
    const status = text ? { text, emoji: userStatus?.emoji ?? null } : null;
    try {
      if (text !== ownStatus) {
        await core.setProfileField(STATUS_FIELD, status);
        for (const [field] of legacyDeletes(profile?.legacy_fields ?? [], LEGACY_STATUS_FIELDS)) {
          await core.setProfileField(field, null);
        }
        profile = profile ? { ...profile, status } : await core.userProfile(activeUserId);
      }
      setPreference('presenceStatusMessage', text);
      setPreference('presence', presenceDraft);
      statusOpen = false;
    } catch {
      statusError = $i18n.t('settings.profileSaveFailed');
    } finally {
      statusSaving = false;
    }
  }

  function reauthenticate(homeserver: string, accountId: string): Promise<void> {
    return goto(
      resolve(
        `login?addAccount=1&reauth=${encodeURIComponent(accountId)}&server=${encodeURIComponent(homeserver)}`
      )
    );
  }

  async function switchAccount(accountId: string): Promise<void> {
    if (accountId === activeAccountId || switchingAccountId !== null) return;

    switchingAccountId = accountId;
    error = null;
    try {
      await core.switchAccount(accountId);
      await goto(resolve('/(app)/rooms'));
    } catch {
      error = $i18n.t('nav.switchAccountFailed');
    } finally {
      switchingAccountId = null;
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

{#snippet statusBubble()}
  <button
    class="status-bubble"
    type="button"
    aria-haspopup="dialog"
    aria-expanded={statusOpen}
    aria-label={`${$i18n.t('presence.setStatus')}: ${$i18n.t(`presence.${preferences.presence}`)}${ownStatus ? `, ${ownStatus}` : ''}`}
    onclick={() => {
      statusDraft = ownStatus;
      presenceDraft = preferences.presence;
      statusError = null;
      statusOpen = true;
    }}
  >
    <span class="status-bubble-presence">
      <PresenceDot presence={preferences.presence} label="" size="medium" />
      {$i18n.t(`presence.${preferences.presence}`)}
    </span>
    <span class="status-bubble-text" class:placeholder={!ownStatus}
      >{#if userStatus?.emoji}<span>{userStatus.emoji}</span>
      {/if}{ownStatus || $i18n.t('presence.statusMessagePlaceholder')}</span
    >
  </button>
{/snippet}

{#snippet editProfile()}
  <Button variant="secondary" onclick={() => void goto(resolve('settings/account'))}
    ><PencilSimpleIcon aria-hidden="true" />{$i18n.t('nav.editProfile')}</Button
  >
{/snippet}

<main class="account-manager" aria-label={$i18n.t('nav.profile')}>
  <div class="account-profile">
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
      crest={preferences.sendPresence ? statusBubble : undefined}
      actions={editProfile}
    />
    <Button variant="secondary" size="large" block onclick={() => void goto(resolve('settings'))}
      ><GearIcon aria-hidden="true" />{$i18n.t('nav.settings')}</Button
    >
  </div>

  <section class="account-list" aria-labelledby="account-list-title">
    <header class="account-list-heading">
      <h2 id="account-list-title">{$i18n.t('nav.accounts')}</h2>
      {#if accountSwitching}
        <Button variant="secondary" onclick={() => void goto(resolve('login?addAccount=1'))}
          ><PlusIcon aria-hidden="true" />{$i18n.t('nav.addAccount')}</Button
        >
      {/if}
    </header>
    {#if error}<Alert variant="critical" role="alert">{error}</Alert>{/if}
    <ul class="account-rows">
      {#each listedAccounts as account (account.account_id)}
        {@const active = account.account_id === activeAccountId}
        {@const identity = accountProfiles.identity(account.user_id)}
        <li class="account-row">
          <Button
            variant="ghost"
            class="account-select"
            aria-pressed={active}
            aria-busy={switchingAccountId === account.account_id}
            aria-label={`${$i18n.t(active ? 'nav.activeAccount' : account.needs_reauth ? 'nav.accountSignInAgain' : 'nav.switchAccount')}: ${identity.displayName}, ${account.user_id}`}
            disabled={active || switchingAccountId !== null}
            onclick={() =>
              void (account.needs_reauth
                ? reauthenticate(account.homeserver, account.account_id)
                : switchAccount(account.account_id))}
          >
            <Avatar
              size="medium"
              id={account.user_id}
              name={identity.displayName}
              src={identity.avatarUrl}
            />
            <span class="account-copy">
              <span class="account-name">{identity.displayName}</span>
              <span class="account-id">{account.user_id}</span>
              {#if active}
                <StatusBadge variant="success" label={$i18n.t('nav.activeAccount')} />
              {:else}
                <span class="account-status" aria-live="polite">
                  {#if account.needs_reauth}
                    <StatusBadge variant="neutral" label={$i18n.t('nav.accountSignedOut')} />
                  {/if}
                  {#if switchingAccountId === account.account_id}<Spinner small />{/if}
                  <span
                    >{$i18n.t(
                      switchingAccountId === account.account_id
                        ? 'nav.switchingAccount'
                        : account.needs_reauth
                          ? 'nav.accountSignInAgain'
                          : 'nav.switch'
                    )}</span
                  >
                </span>
              {/if}
            </span>
            {#if active}<CheckCircleIcon aria-hidden="true" />{/if}
          </Button>
          {#if !active}
            <ActionMenu label={`${$i18n.t('nav.moreOptions')}: ${account.user_id}`}>
              {#snippet trigger({ props })}
                <IconButton
                  {...props}
                  variant="ghost"
                  size="large"
                  class="selection-open"
                  label={`${$i18n.t('nav.moreOptions')}: ${account.user_id}`}
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
        </li>
      {/each}
    </ul>
  </section>

  <Button
    variant="secondary"
    class="sign-out"
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
      void saveStatusMessage();
    }}
  >
    <h2>{$i18n.t('presence.title')}</h2>
    <OptionCards
      label={$i18n.t('presence.title')}
      options={presenceOptions}
      value={presenceDraft}
      disabled={statusSaving}
      onSelect={(value) => (presenceDraft = value)}
    />
    <FormField fieldId="presence-status-message" label={$i18n.t('presence.statusMessage')}>
      <TextInput
        id="presence-status-message"
        bind:value={statusDraft}
        disabled={statusSaving}
        maxlength={120}
        placeholder={$i18n.t('presence.statusMessagePlaceholder')}
      />
    </FormField>
    {#if statusError}<Alert variant="critical" role="alert">{statusError}</Alert>{/if}
    <DialogActions>
      <Button variant="ghost" disabled={statusSaving} onclick={() => (statusOpen = false)}
        >{$i18n.t('settings.cancel')}</Button
      >
      <Button
        type="submit"
        loading={statusSaving}
        disabled={statusDraft.trim() === ownStatus && presenceDraft === preferences.presence}
        >{$i18n.t('presence.statusMessageSave')}</Button
      >
    </DialogActions>
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
    {#if accountToRemove}
      <p class="remove-account-identity">
        <strong>{accountProfiles.identity(accountToRemove.user_id).displayName}</strong>
        <span>{accountToRemove.user_id}</span>
      </p>
    {/if}
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
    container-type: inline-size;
    display: grid;
    gap: var(--space-600);
    grid-auto-rows: max-content;
    margin: 0 auto;
    max-width: 42rem;
    overflow: auto;
    overscroll-behavior: contain;
    padding: var(--page-gutter);
    width: 100%;
  }

  .account-profile {
    display: grid;
    gap: var(--space-300);
  }

  .account-profile :global(.profile-card) {
    --profile-avatar-size: 5rem;
  }

  .account-profile :global(.profile-card .profile-card-cover) {
    height: 8rem;
  }

  .account-profile :global(.profile-card-crest) {
    align-items: start;
    display: grid;
    grid-template-columns: var(--profile-avatar-size) minmax(0, 1fr);
  }

  .account-profile :global(.profile-card-avatar-wrap),
  .account-profile :global(.profile-card-crest-content),
  .account-profile :global(.profile-card-status) {
    margin-bottom: 0;
    margin-top: calc(var(--profile-avatar-size) / -2);
    transform: none;
  }

  .account-profile :global(.profile-card-identity) {
    padding: var(--space-200) var(--space-400) var(--space-400);
  }

  .account-profile :global(.profile-card-name) {
    font-size: calc(1.5rem * var(--text-scale));
    line-height: var(--line-height-heading);
  }

  .account-profile :global(.profile-card-user-id) {
    align-items: flex-start;
    max-width: 100%;
    padding-top: var(--space-100);
  }

  .account-profile :global(.profile-card-user-id svg) {
    margin-top: 0.25em;
  }

  .account-list {
    display: grid;
    gap: var(--space-300);
  }

  .account-list-heading {
    align-items: center;
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-200);
    justify-content: space-between;
  }

  .account-list-heading h2 {
    font-size: var(--font-size-subheading);
    line-height: var(--line-height-heading);
    margin: 0;
  }

  .account-rows {
    background: var(--surface-var-container);
    border: var(--border-width) solid var(--surface-var-container-line);
    border-radius: var(--radius);
    color: var(--surface-var-on-container);
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .account-manager :global(.sign-out) {
    --button-on-container: var(--crit-main);

    justify-self: start;
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

  .account-row {
    align-items: center;
    display: flex;
    min-width: 0;
    padding-right: var(--space-100);
  }

  .account-row + .account-row {
    border-top: var(--border-width) solid var(--surface-var-container-line);
  }

  .account-row :global(.account-select) {
    align-items: center;
    border-radius: var(--radius);
    display: grid;
    flex: 1;
    gap: var(--space-300);
    grid-template-columns: auto minmax(0, 1fr);
    min-width: 0;
    padding: var(--space-400);
    text-align: start;
  }

  .account-row :global(.account-select[aria-pressed='true']) {
    cursor: default;
    grid-template-columns: auto minmax(0, 1fr) auto;
    opacity: 1;
  }

  .account-row :global(.account-select[aria-busy='true']) {
    opacity: 1;
  }

  .account-copy {
    display: grid;
    gap: var(--space-100);
    justify-items: start;
    min-width: 0;
    overflow-wrap: anywhere;
  }

  .account-name {
    font-weight: var(--font-weight-medium);
  }

  .account-id {
    color: var(--surface-var-on-container);
    font-size: var(--font-size-small);
    line-height: var(--line-height-body);
  }

  .account-status {
    align-items: center;
    color: var(--primary-on-container);
    display: flex;
    flex-wrap: wrap;
    font-size: var(--font-size-label);
    font-weight: var(--font-weight-medium);
    gap: var(--space-200);
    line-height: var(--line-height-body);
  }

  @container (width < 20rem) {
    .account-row {
      display: block;
      padding-right: 0;
      position: relative;
    }

    .account-row :global(.account-select) {
      grid-template-columns: auto minmax(0, 1fr) var(--control-height-large);
      width: 100%;
    }

    .account-copy {
      display: contents;
    }

    .account-name {
      grid-column: 2;
      grid-row: 1;
    }

    .account-id,
    .account-status,
    .account-copy > :global(.status-badge) {
      grid-column: 1 / -1;
    }

    .account-row :global(.account-select > svg) {
      grid-column: 3;
      grid-row: 1;
      justify-self: center;
    }

    .account-row :global(.selection-open) {
      position: absolute;
      right: var(--space-400);
      top: var(--space-400);
    }
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

  .status-sheet :global(.text-input) {
    min-height: var(--control-height-large);
  }

  .remove-dialog .remove-account-identity {
    color: var(--surface-on-container);
    display: grid;
    gap: var(--space-100);
    overflow-wrap: anywhere;
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
