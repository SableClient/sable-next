<script lang="ts">
  import type { PackImageView } from '#src/generated/PackImageView';

  import { i18n } from '#lib/i18n.js';
  import { rememberReaction } from '#lib/emoji/recents.svelte.js';
  import BottomSheet from '#lib/ui/primitives/BottomSheet.svelte';
  import EmoteBoard from '#lib/ui/primitives/EmoteBoard.svelte';

  interface Props {
    open?: boolean;
    roomId: string;
    onPick: (key: string) => void;
  }

  let { open = $bindable(false), roomId, onPick }: Props = $props();

  function pick(key: string): void {
    rememberReaction(key);
    open = false;
    onPick(key);
  }
</script>

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
      pick(image.url);
    }}
    onPickUnicode={pick}
  />
</BottomSheet>
