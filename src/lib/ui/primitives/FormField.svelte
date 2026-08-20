<script lang="ts">
  import type { Snippet } from 'svelte';

  import Label from './Label.svelte';

  interface Props {
    fieldId: string;
    label: string;
    error?: string | null;
    children: Snippet;
  }

  let { fieldId, label, error = null, children }: Props = $props();
</script>

<div class="form-field">
  <Label for={fieldId}>{label}</Label>
  {@render children()}
  {#if error}<p class="form-field-error error" role="alert">{error}</p>{/if}
</div>

<style>
  .form-field {
    display: grid;
    gap: var(--space-1);
  }

  .form-field-error {
    color: var(--sable-crit-main);
    font-size: var(--font-size-small);
    margin: 0;
  }
</style>
