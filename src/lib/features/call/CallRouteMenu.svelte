<script lang="ts">
  import CaretUpIcon from 'phosphor-svelte/lib/CaretUpIcon';

  import ActionMenu from '#lib/ui/primitives/ActionMenu.svelte';
  import ActionMenuItem from '#lib/ui/primitives/ActionMenuItem.svelte';
  import IconButton from '#lib/ui/primitives/IconButton.svelte';

  import type { CallAudioRoute } from './call-transport';

  interface Props {
    label: string;
    list: () => Promise<CallAudioRoute[]>;
    onSelect: (routeId: string) => void;
    open?: boolean;
  }

  let { label, list, onSelect, open = $bindable(false) }: Props = $props();

  let routes = $state<CallAudioRoute[]>([]);

  $effect(() => {
    if (!open) return;
    void list()
      .then((result) => (routes = result))
      .catch(() => (routes = []));
  });
</script>

<ActionMenu bind:open {label} side="top" align="center">
  {#snippet trigger({ props })}
    <IconButton {...props} variant="ghost" size="small" class="device-caret" {label}>
      <CaretUpIcon weight="bold" />
    </IconButton>
  {/snippet}
  {#each routes as route (route.id)}
    <ActionMenuItem checked={route.current} onSelect={() => onSelect(route.id)}>
      {route.name}
    </ActionMenuItem>
  {/each}
</ActionMenu>
