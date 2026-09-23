<script lang="ts">
  import type { Snippet } from 'svelte';

  import Label from './Label.svelte';

  interface Props {
    fieldId: string;
    label: string;
    labelSuffix?: Snippet;
    dense?: boolean;
    error?: string | null;
    children: Snippet;
  }

  let { fieldId, label, labelSuffix, dense = false, error = null, children }: Props = $props();
</script>

<div class={['form-field', { dense }]}>
  {#if labelSuffix}
    <div class="form-field-label">
      <Label for={fieldId}>{label}</Label>
      {@render labelSuffix()}
    </div>
  {:else}
    <Label for={fieldId}>{label}</Label>
  {/if}
  {@render children()}
  {#if error}<p class="form-field-error error" role="alert">{error}</p>{/if}
</div>

<style>
  .form-field {
    display: grid;
    gap: var(--space-200);
  }

  .form-field.dense {
    gap: var(--space-100);
  }

  .form-field-label {
    align-items: center;
    display: flex;
    gap: var(--space-150);
  }

  .form-field-label :global(.tooltip-trigger) {
    padding: 0;
  }

  .form-field-label :global(.tooltip-trigger svg) {
    height: var(--icon-size-small);
    width: var(--icon-size-small);
  }

  .form-field-error {
    color: var(--crit-main);
    font-size: var(--font-size-small);
    margin: 0;
  }
</style>
