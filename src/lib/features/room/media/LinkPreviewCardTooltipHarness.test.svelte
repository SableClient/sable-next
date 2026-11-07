<script lang="ts">
  import TooltipProvider from '#lib/ui/primitives/TooltipProvider.svelte';

  import LinkPreviewCard from './LinkPreviewCard.svelte';

  interface Props {
    url: string;
  }

  let { url }: Props = $props();
</script>

<TooltipProvider>
  <LinkPreviewCard {url} encrypted={false} />
</TooltipProvider>
