<script lang="ts">
  import TypingDots from '#lib/ui/primitives/TypingDots.svelte';

  interface Props {
    label: string | null;
  }

  let { label }: Props = $props();
</script>

<div class="typing" aria-live="polite" role="status">
  {#if label}
    <TypingDots />
    <span class="label">{label}</span>
  {/if}
</div>

<style>
  .typing {
    align-items: center;
    color: var(--sable-surface-var-on-container);
    display: flex;
    font-size: var(--font-size-small);
    gap: var(--space-150);
    line-height: 1.125rem;
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
  }

  .label {
    overflow: hidden;
    text-overflow: ellipsis;
  }
</style>
