<script lang="ts">
  import { CoreError } from '#src/transport';
  import { useCoreClient } from '#lib/core/context.js';
  import { i18n } from '#lib/i18n.js';
  import { openExternalAuthUrl } from '#lib/platform/external-auth.js';
  import Button from '#lib/ui/primitives/Button.svelte';
  import ConfirmDialog from '#lib/ui/primitives/ConfirmDialog.svelte';
  import Label from '#lib/ui/primitives/Label.svelte';
  import SettingsRow from '#lib/ui/primitives/SettingsRow.svelte';
  import SettingsSection from '#lib/ui/primitives/SettingsSection.svelte';
  import TextInput from '#lib/ui/primitives/TextInput.svelte';
  import '#lib/ui/primitives/settings-row.css';

  const core = useCoreClient();
  let oauth = $state(false);
  let open = $state(false);
  let password = $state('');
  let typedUserId = $state('');
  let busy = $state(false);
  let error = $state<string | null>(null);

  $effect(() => {
    void core.rpc.encryption.devices().then(
      ({ oauth: supported }) => {
        oauth = supported;
      },
      (cause: unknown) => {
        console.debug('[sable settings] device list unavailable', cause);
      }
    );
  });

  function messageFor(cause: unknown): string {
    if (cause instanceof CoreError) {
      if (cause.detail.code === 'interactive_auth_required')
        return i18n.t('settings.deleteAccountPasswordRequired');
      if (cause.detail.code === 'denied') return i18n.t('settings.wrongPassword');
    }
    return i18n.t('settings.actionFailed');
  }

  let userId = $derived(core.session?.user_id ?? '');
  let confirmed = $derived(typedUserId.trim() === userId);

  function reset(): void {
    password = '';
    typedUserId = '';
    error = null;
  }

  async function deleteAccount(): Promise<void> {
    if (busy || !confirmed) return;
    busy = true;
    error = null;
    try {
      const managementUrl = await core.rpc.account.deactivateAccount({
        password: password || null,
      });
      if (managementUrl) {
        await openExternalAuthUrl(managementUrl);
        open = false;
        return;
      }
      await core.logout();
    } catch (cause) {
      error = messageFor(cause);
    } finally {
      busy = false;
    }
  }
</script>

<SettingsSection headingId="account-delete" title={i18n.t('settings.deleteAccount')}>
  <ul class="settings-rows">
    <SettingsRow id="delete-account" title={i18n.t('settings.deleteAccountHint')}>
      <Button variant="danger" onclick={() => (open = true)}>
        {i18n.t('settings.deleteAccountAction')}
      </Button>
    </SettingsRow>
  </ul>
</SettingsSection>

<ConfirmDialog
  bind:open
  title={i18n.t('settings.deleteAccountConfirm')}
  description={i18n.t('settings.deleteAccountDescription')}
  confirmLabel={i18n.t('settings.deleteAccountAction')}
  {busy}
  {error}
  confirmDisabled={!confirmed}
  onConfirm={() => void deleteAccount()}
  onOpenChange={(next) => {
    if (!next) reset();
  }}
>
  <Label for="delete-account-confirm">
    {i18n.t('settings.deleteAccountTypeUserId', { userId })}
  </Label>
  <TextInput id="delete-account-confirm" bind:value={typedUserId} autocomplete="off" />
  {#if !oauth}
    <Label for="delete-account-password">{i18n.t('settings.password')}</Label>
    <TextInput
      id="delete-account-password"
      type="password"
      bind:value={password}
      autocomplete="current-password"
    />
  {/if}
</ConfirmDialog>
