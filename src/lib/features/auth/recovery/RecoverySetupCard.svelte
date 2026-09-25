<script lang="ts">
  import CopyIcon from 'phosphor-svelte/lib/CopyIcon';
  import DownloadSimpleIcon from 'phosphor-svelte/lib/DownloadSimpleIcon';

  import { useCoreClient } from '#lib/core/context.js';
  import { i18n, t } from '#lib/i18n.js';
  import { saveBytes } from '#lib/platform/files.js';
  import Button from '#lib/ui/primitives/Button.svelte';
  import TextInput from '#lib/ui/primitives/TextInput.svelte';
  import AuthField from '../shared/AuthField.svelte';
  import FormField from '#lib/ui/primitives/FormField.svelte';
  import AuthInfoBox from '../shared/AuthInfoBox.svelte';
  import AuthSecondaryAction from '../shared/AuthSecondaryAction.svelte';
  import AuthStatusSlot from '../shared/AuthStatusSlot.svelte';

  interface Props {
    recoveryKey?: string | null;
    onComplete: () => void;
    onSkip: () => void;
  }

  let { recoveryKey: givenKey = null, onComplete, onSkip }: Props = $props();
  const core = useCoreClient();
  let createdKey = $state('');
  let creating = $state(false);
  let error = $state<string | null>(null);
  let kept = $state<'copied' | 'downloaded' | null>(null);
  let writtenDown = $state(false);
  const recoveryKey = $derived(createdKey || givenKey || '');
  const saved = $derived(writtenDown);

  async function createRecoveryKey(): Promise<void> {
    creating = true;
    error = null;
    try {
      createdKey = await core.commands.enableRecovery();
    } catch {
      error = t('settings.actionFailed');
    } finally {
      creating = false;
    }
  }

  async function copy(): Promise<void> {
    error = null;
    try {
      await navigator.clipboard.writeText(recoveryKey);
      kept = 'copied';
    } catch {
      error = t('setup.recoveryCopyFailed');
    }
  }

  async function download(): Promise<void> {
    error = null;
    const outcome = await saveBytes(
      new TextEncoder().encode(`${recoveryKey}\n`),
      'sable-recovery-key.txt',
      'text/plain'
    );
    if (outcome === 'saved') kept = 'downloaded';
    else if (outcome === 'failed') error = t('setup.recoveryDownloadFailed');
  }

  function selectRecoveryKey(event: Event & { currentTarget: HTMLInputElement }): void {
    event.currentTarget.select();
  }
</script>

<form
  class="recovery-setup-card auth-card-surface"
  aria-labelledby="recovery-setup-title"
  onsubmit={(event) => {
    event.preventDefault();
    if (!recoveryKey) void createRecoveryKey();
    else if (saved) onComplete();
  }}
>
  {#if recoveryKey}
    <AuthField labelId="recovery-setup-title" label={$i18n.t('settings.saveRecoveryKey')}>
      <AuthInfoBox id="new-account-recovery-key-help">
        {$i18n.t('setup.recoverySaveDescription')}
      </AuthInfoBox>
    </AuthField>

    <FormField dense fieldId="new-account-recovery-key" label={$i18n.t('settings.recoveryKey')}>
      <TextInput
        id="new-account-recovery-key"
        value={recoveryKey}
        readonly
        aria-describedby="new-account-recovery-key-help"
        spellcheck={false}
        onclick={selectRecoveryKey}
        onfocus={selectRecoveryKey}
      />
    </FormField>

    <div class="recovery-keep">
      <Button onclick={() => void copy()}>
        <CopyIcon aria-hidden="true" />
        {$i18n.t(kept === 'copied' ? 'setup.recoveryCopied' : 'setup.recoveryCopy')}
      </Button>
      <Button onclick={() => void download()}>
        <DownloadSimpleIcon aria-hidden="true" />
        {$i18n.t(kept === 'downloaded' ? 'setup.recoveryDownloaded' : 'setup.recoveryDownload')}
      </Button>
    </div>

    <label class="recovery-written">
      <input type="checkbox" bind:checked={writtenDown} />
      {$i18n.t('setup.recoveryWrittenDown')}
    </label>
  {:else}
    <AuthField labelId="recovery-setup-title" label={$i18n.t('auth.setUpRecovery')}>
      <AuthInfoBox>{$i18n.t('auth.recoverySetupDescription')}</AuthInfoBox>
    </AuthField>
  {/if}

  <AuthStatusSlot
    message={error ?? (recoveryKey && !saved ? $i18n.t('setup.recoverySaveFirst') : null)}
    tone={error ? 'error' : 'muted'}
  />

  <Button
    type="submit"
    variant="primary"
    block
    loading={creating}
    disabled={Boolean(recoveryKey) && !saved}
  >
    {recoveryKey ? $i18n.t('auth.continue') : $i18n.t('auth.createRecoveryKey')}
  </Button>
</form>

{#if !recoveryKey}
  <AuthSecondaryAction label={$i18n.t('auth.skipForNow')} onclick={onSkip} />
{/if}

<style>
  .recovery-setup-card {
    min-width: 0;
  }

  .recovery-keep {
    display: grid;
    gap: var(--space-200);
    grid-template-columns: repeat(auto-fit, minmax(8rem, 1fr));
  }

  .recovery-keep :global(svg) {
    flex: 0 0 auto;
    height: var(--icon-size-medium);
    width: var(--icon-size-medium);
  }

  .recovery-written {
    align-items: center;
    display: flex;
    font-size: var(--font-size-small);
    gap: var(--space-200);
  }
</style>
