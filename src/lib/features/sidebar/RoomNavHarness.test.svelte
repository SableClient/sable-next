<script lang="ts">
  import TooltipProvider from '#lib/ui/primitives/TooltipProvider.svelte';
  import RoomNav from './RoomNav.svelte';

  interface Props {
    onNavigate?: (href: string) => void;
    width?: number;
    collapsed?: boolean;
  }

  let { onNavigate, width, collapsed }: Props = $props();
</script>

<TooltipProvider>
  <RoomNav {onNavigate} {width} {collapsed} />
</TooltipProvider>
