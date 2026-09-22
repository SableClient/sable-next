<script lang="ts">
  import type { UrlPreviewView } from '#src/generated/protocol';

  import LinkPreviewCard from '../LinkPreviewCard.svelte';
  import { findEmbed } from './providers';

  interface Props {
    url: string;
    encrypted: boolean | null;
    bundled?: UrlPreviewView | null;
  }

  let { url, encrypted, bundled = null }: Props = $props();
  let Embed = $derived(findEmbed(url, encrypted));
</script>

{#if Embed}
  <Embed {url} />
{:else}
  <LinkPreviewCard {url} {encrypted} {bundled} />
{/if}
