<script lang="ts">
  import { i18n } from '#lib/i18n.js';

  import Button from './Button.svelte';

  interface Props {
    dirty: boolean;
    saving: boolean;
    saved: boolean;
    failed: boolean;
    notice?: string | null;
    onReset: () => void;
    onSave: () => void;
  }

  let { dirty, saving, saved, failed, notice = null, onReset, onSave }: Props = $props();

  let status = $derived.by(() => {
    if (failed) return i18n.t('room.settingsFailed');
    if (dirty) return notice ?? i18n.t('common.unsavedChangesNotice');
    return saved ? i18n.t('room.settingsSaved') : '';
  });
</script>

<div class={['save-bar', { pending: dirty }]}>
  <!-- Mounted while empty: a live region that arrives with its text is often not announced. -->
  <p class={['save-status', { error: failed }]} role="status">{status}</p>
  {#if dirty}
    <Button variant="ghost" disabled={saving} onclick={onReset}>
      {i18n.t('common.reset')}
    </Button>
  {/if}
  <Button variant="primary" disabled={!dirty || saving} loading={saving} onclick={onSave}>
    {i18n.t('common.save')}
  </Button>
</div>

<style>
  .save-bar {
    align-items: center;
    border: var(--border-width) solid transparent;
    border-radius: var(--radius);
    display: flex;
    gap: var(--space-300);
    justify-content: flex-end;
    padding: var(--space-200) var(--space-300);
  }

  .save-bar.pending {
    background: var(--bg-container);
    border-color: var(--bg-container-line);
    bottom: var(--space-300);
    box-shadow: var(--shadow-e200);
    color: var(--bg-on-container);
    position: sticky;
    z-index: 1;
  }

  .save-status {
    color: var(--surface-var-on-container);
    font-size: var(--font-size-small);
    margin: 0;
    margin-inline-end: auto;
  }

  .save-bar.pending .save-status:not(.error) {
    color: var(--bg-on-container);
    font-weight: var(--font-weight-medium);
  }

  .save-status.error {
    color: var(--crit-main);
  }
</style>
