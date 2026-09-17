<script lang="ts">
  import type { PackImageView } from '#src/generated/protocol';

  import { i18n } from '#lib/i18n.js';
  import { rememberReaction } from '#lib/emoji/recents.svelte.js';
  import { BREAKPOINTS } from '#lib/ui/breakpoints.js';
  import type { CursorAnchor } from '#lib/ui/cursor-anchor.js';
  import { createMediaQuery } from '#lib/ui/media-query.svelte.js';
  import BottomSheet from '#lib/ui/primitives/BottomSheet.svelte';
  import EmoteBoard from '#lib/ui/primitives/EmoteBoard.svelte';

  import ReactionPicker from './ReactionPicker.svelte';

  interface Props {
    open?: boolean;
    roomId: string;
    anchor?: HTMLElement | CursorAnchor | null;
    onPick: (key: string, sourcePack?: PackImageView['source_pack']) => void;
  }

  let { open = $bindable(false), roomId, anchor = null, onPick }: Props = $props();

  const appLayout = createMediaQuery(BREAKPOINTS.appLayout);
  let sheet = $derived(!appLayout.matches);

  function pick(key: string, sourcePack: PackImageView['source_pack'] = null): void {
    rememberReaction(key);
    open = false;
    onPick(key, sourcePack);
  }
</script>

{#if sheet}
  <BottomSheet
    bind:open
    label={$i18n.t('timeline.addReaction')}
    closeLabel={$i18n.t('timeline.closeMenu')}
    contentInset={false}
  >
    <EmoteBoard
      {roomId}
      variant="sheet"
      unicode
      stickers={false}
      onPick={(image: PackImageView) => {
        pick(image.url, image.source_pack);
      }}
      onPickUnicode={pick}
    />
  </BottomSheet>
{:else}
  <ReactionPicker
    bind:open
    label={$i18n.t('timeline.addReaction')}
    {roomId}
    {anchor}
    onPick={pick}
  />
{/if}
