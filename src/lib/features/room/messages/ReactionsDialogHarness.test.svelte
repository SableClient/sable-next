<script lang="ts">
  import type { ComponentProps } from 'svelte';

  import ReactionsDialog from './ReactionsDialog.svelte';

  let { dialog }: { dialog: ComponentProps<typeof ReactionsDialog> } = $props();
  const dialogProps = $derived(dialog);
  // Like the dialog host: the entry outlives each change to its reactions.
  const entry = $state<{ active?: string }>({});
</script>

<ReactionsDialog {...dialogProps} active={entry.active} />
