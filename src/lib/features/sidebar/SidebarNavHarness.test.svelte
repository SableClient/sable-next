<script lang="ts">
  import TooltipProvider from '#lib/ui/primitives/TooltipProvider.svelte';
  import SidebarNav from './SidebarNav.svelte';

  interface Props {
    mobile?: boolean;
  }

  let { mobile }: Props = $props();
</script>

<TooltipProvider>
  <SidebarNav {mobile} />
</TooltipProvider>
