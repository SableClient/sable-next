<script lang="ts">
  import { i18n } from '#lib/i18n.js';
  import Alert from '#lib/ui/primitives/Alert.svelte';
  import Button from '#lib/ui/primitives/Button.svelte';
  import DialogFrame from '#lib/ui/primitives/DialogFrame.svelte';
  import FormField from '#lib/ui/primitives/FormField.svelte';
  import Switch from '#lib/ui/primitives/Switch.svelte';
  import TextInput from '#lib/ui/primitives/TextInput.svelte';

  import { moderationErrorMessage } from './member-profile-actions';

  interface Props {
    action: 'kick' | 'ban' | null;
    name: string;
    onConfirm: (reason: string | null, redactEvents: boolean) => Promise<void>;
    onClose: () => void;
  }

  let { action, name, onConfirm, onClose }: Props = $props();

  const id = $props.id();
  let reason = $state('');
  let redactEvents = $state(false);
  let busy = $state(false);
  let error = $state<string | null>(null);

  const confirmLabel = $derived.by(() => {
    if (action === 'ban')
      return i18n.t(redactEvents ? 'timeline.profileBanAndDelete' : 'timeline.profileBan');
    return i18n.t(redactEvents ? 'timeline.profileKickAndDelete' : 'timeline.profileKick');
  });

  function close(): void {
    reason = '';
    redactEvents = false;
    error = null;
    onClose();
  }

  async function confirm(): Promise<void> {
    if (busy) return;
    busy = true;
    error = null;
    try {
      await onConfirm(reason.trim() || null, redactEvents);
      close();
    } catch (cause) {
      console.warn('[sable profile] moderation action failed', cause);
      error = moderationErrorMessage(cause);
    } finally {
      busy = false;
    }
  }
</script>

<DialogFrame
  open={action !== null}
  onOpenChange={(next) => {
    if (!next) close();
  }}
  variant="verification"
  label={i18n.t(action === 'ban' ? 'timeline.profileBan' : 'timeline.profileKick')}
  onConfirm={() => void confirm()}
>
  {#if action}
    <div class="moderation">
      <h2>
        {i18n.t(action === 'ban' ? 'timeline.profileBanConfirm' : 'timeline.profileKickConfirm', {
          name,
        })}
      </h2>
      {#if error}
        <Alert variant="critical" role="alert">{error}</Alert>
      {/if}
      <FormField fieldId="{id}-reason" label={i18n.t('timeline.deleteReason')}>
        <TextInput id="{id}-reason" bind:value={reason} autocomplete="off" />
      </FormField>
      <div class="redact">
        <div class="redact-text">
          <label for="{id}-redact">{i18n.t('timeline.profileRedactEvents')}</label>
          <p>{i18n.t('timeline.profileRedactEventsHint')}</p>
        </div>
        <Switch
          id="{id}-redact"
          bind:checked={redactEvents}
          label={i18n.t('timeline.profileRedactEvents')}
        />
      </div>
      <div class="actions">
        <Button variant="ghost" disabled={busy} onclick={close}>{i18n.t('common.cancel')}</Button>
        <Button type="submit" variant="danger" loading={busy}>{confirmLabel}</Button>
      </div>
    </div>
  {/if}
</DialogFrame>

<style>
  .moderation {
    display: grid;
    gap: var(--space-300);
    width: min(27rem, calc(100vw - 2rem));
  }

  h2 {
    font-size: var(--font-size-heading);
    line-height: 1.3;
    margin: 0;
    overflow-wrap: anywhere;
  }

  .redact {
    align-items: center;
    display: flex;
    gap: var(--space-300);
    justify-content: space-between;
  }

  .redact-text {
    display: grid;
    gap: var(--space-050);
  }

  .redact-text p {
    color: var(--surface-var-on-container);
    font-size: var(--font-size-small);
    line-height: var(--line-height-small);
    margin: 0;
  }

  .actions {
    display: flex;
    gap: var(--space-200);
    justify-content: flex-end;
  }
</style>
