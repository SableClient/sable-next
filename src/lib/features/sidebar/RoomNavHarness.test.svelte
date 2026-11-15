<script lang="ts">
  import TooltipProvider from '#lib/ui/primitives/TooltipProvider.svelte';
  import RoomNav from './RoomNav.svelte';

  interface Props {
    onNavigate?: (href: string) => void;
    width?: number;
    collapsed?: boolean;
    roomId?: string;
    height?: number;
  }

  let { onNavigate, width, collapsed, roomId, height }: Props = $props();
</script>

<TooltipProvider>
  {#if height === undefined}
    <RoomNav {onNavigate} {width} {collapsed} {roomId} />
  {:else}
    <div style:display="flex" style:flex-direction="column" style:height="{height}px">
      <RoomNav {onNavigate} {width} {collapsed} {roomId} />
    </div>
  {/if}
</TooltipProvider>
