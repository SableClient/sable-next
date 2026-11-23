<script lang="ts">
  import { useCoreClient } from '#lib/core/context.js';
  import PasswordField from '#lib/features/auth/shared/PasswordField.svelte';
  import { i18n } from '#lib/i18n.js';
  import { openAccountManagementUrl } from '#lib/platform/account-management.js';
  import { isCoreError } from '#src/transport';
  import Alert from '#lib/ui/primitives/Alert.svelte';
  import Button from '#lib/ui/primitives/Button.svelte';
  import FormField from '#lib/ui/primitives/FormField.svelte';
  import SettingsRow from '#lib/ui/primitives/SettingsRow.svelte';
  import SettingsSection from '#lib/ui/primitives/SettingsSection.svelte';
  import Switch from '#lib/ui/primitives/Switch.svelte';
  import '#lib/ui/primitives/settings-row.css';

  type Field = 'current' | 'new' | 'confirm';

  const core = useCoreClient();
  let accountManagementUrl = $derived(core.oauthMetadata?.account_management_uri ?? null);

  let enabled = $state(false);
  let currentPassword = $state('');
  let newPassword = $state('');
  let confirmPassword = $state('');
  let logoutDevices = $state(false);
  let busy = $state(false);
  let done = $state(false);
  let failure = $state<{ field: Field | null; message: string } | null>(null);

  $effect(() => {
    if (core.oauthMetadata !== null) return;
    let cancelled = false;
    core.rpc.account.passwordChangeEnabled().then(
      (value) => !cancelled && (enabled = value),
      () => !cancelled && (enabled = true)
    );
    return () => {
      cancelled = true;
    };
  });

  function failureFor(cause: unknown): NonNullable<typeof failure> {
    if (isCoreError(cause, 'denied'))
      return { field: 'current', message: i18n.t('settings.changePasswordWrongCurrent') };
    if (isCoreError(cause, 'weak_password'))
      return { field: 'new', message: i18n.t('errors.weakPassword') };
    if (isCoreError(cause, 'unsupported'))
      return { field: null, message: i18n.t('settings.changePasswordUnsupported') };
    return { field: null, message: i18n.t('settings.actionFailed') };
  }

  function errorFor(field: Field): string | null {
    return failure?.field === field ? failure.message : null;
  }

  async function submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (busy) return;
    done = false;
    if (newPassword !== confirmPassword) {
      failure = { field: 'confirm', message: i18n.t('auth.passwordsDoNotMatch') };
      return;
    }
    busy = true;
    failure = null;
    try {
      await core.rpc.account.changePassword({
        current_password: currentPassword,
        new_password: newPassword,
        logout_devices: logoutDevices,
      });
      currentPassword = '';
      newPassword = '';
      confirmPassword = '';
      done = true;
    } catch (cause) {
      failure = failureFor(cause);
    } finally {
      busy = false;
    }
  }
</script>

{#if accountManagementUrl}
  <SettingsSection headingId="account-password" title={i18n.t('settings.changePassword')}>
    <ul class="settings-rows">
      <SettingsRow
        id="change-password"
        title={i18n.t('settings.changePassword')}
        description={i18n.t('settings.changePasswordManageHint')}
      >
        <Button onclick={() => void openAccountManagementUrl(accountManagementUrl)}>
          {i18n.t('settings.changePasswordManage')}
        </Button>
      </SettingsRow>
    </ul>
  </SettingsSection>
{:else if enabled}
  <SettingsSection headingId="account-password" title={i18n.t('settings.changePassword')}>
    <form class="settings-form" onsubmit={submit}>
      <p class="settings-note">{i18n.t('settings.changePasswordHint')}</p>
      <FormField
        dense
        fieldId="change-password-current"
        label={i18n.t('settings.changePasswordCurrent')}
        error={errorFor('current')}
      >
        <PasswordField
          id="change-password-current"
          bind:value={currentPassword}
          disabled={busy}
          autocomplete="current-password"
          invalid={failure?.field === 'current'}
          describedBy={failure?.field === 'current' ? 'change-password-current-error' : undefined}
        />
      </FormField>
      <FormField
        dense
        fieldId="change-password-new"
        label={i18n.t('auth.newPassword')}
        error={errorFor('new')}
      >
        <PasswordField
          id="change-password-new"
          bind:value={newPassword}
          disabled={busy}
          autocomplete="new-password"
          invalid={failure?.field === 'new'}
          describedBy={failure?.field === 'new' ? 'change-password-new-error' : undefined}
        />
      </FormField>
      <FormField
        dense
        fieldId="change-password-confirm"
        label={i18n.t('auth.confirmNewPassword')}
        error={errorFor('confirm')}
      >
        <PasswordField
          id="change-password-confirm"
          bind:value={confirmPassword}
          disabled={busy}
          autocomplete="new-password"
          invalid={failure?.field === 'confirm'}
          describedBy={failure?.field === 'confirm' ? 'change-password-confirm-error' : undefined}
        />
      </FormField>
      <div class="logout-row">
        <span>{i18n.t('settings.changePasswordSignOutOthers')}</span>
        <Switch
          bind:checked={logoutDevices}
          disabled={busy}
          label={i18n.t('settings.changePasswordSignOutOthers')}
        />
      </div>
      {#if failure && failure.field === null}
        <Alert variant="critical" role="alert">{failure.message}</Alert>
      {/if}
      {#if done}
        <Alert variant="success" role="status">{i18n.t('settings.changePasswordDone')}</Alert>
      {/if}
      <div>
        <Button type="submit" variant="primary" loading={busy}>
          {i18n.t('settings.changePasswordAction')}
        </Button>
      </div>
    </form>
  </SettingsSection>
{/if}

<style>
  .logout-row {
    align-items: center;
    display: flex;
    gap: var(--space-300);
    justify-content: space-between;
  }
</style>
