<script lang="ts">
  import ActionMenu from './ActionMenu.svelte';
  import ActionMenuItem from './ActionMenuItem.svelte';
  import ActionMenuSeparator from './ActionMenuSeparator.svelte';
  import ActionMenuSub from './ActionMenuSub.svelte';

  interface Props {
    onPick: () => void;
  }

  let { onPick }: Props = $props();
</script>

<ActionMenu label="Room options">
  {#snippet trigger({ props })}
    <button {...props} type="button" class="probe-trigger">Room options</button>
  {/snippet}
  <ActionMenuItem onSelect={onPick}>Mark as read</ActionMenuItem>
  <ActionMenuSeparator />
  <ActionMenuSub label="Notifications">
    {#snippet trigger()}Notifications{/snippet}
    <ActionMenuItem checked onSelect={onPick}>All messages</ActionMenuItem>
  </ActionMenuSub>
</ActionMenu>
