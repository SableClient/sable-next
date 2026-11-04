<script lang="ts">
  import TooltipProvider from '#lib/ui/primitives/TooltipProvider.svelte';
  import RoomNav from './RoomNav.svelte';

  interface Props {
    onNavigate?: (href: string) => void;
    width?: number;
    collapsed?: boolean;
    roomId?: string;
  }

  let { onNavigate, width, collapsed, roomId }: Props = $props();
</script>

<TooltipProvider>
  <RoomNav {onNavigate} {width} {collapsed} {roomId} />
</TooltipProvider>
