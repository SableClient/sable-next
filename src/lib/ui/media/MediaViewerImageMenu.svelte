<script lang="ts">
  import { i18n } from '#lib/i18n.js';
  import type { CursorAnchor } from '#lib/ui/cursor-anchor.js';
  import ActionMenu from '#lib/ui/primitives/ActionMenu.svelte';
  import ActionMenuItem from '#lib/ui/primitives/ActionMenuItem.svelte';
  import CopyIcon from 'phosphor-svelte/lib/CopyIcon';
  import DownloadSimpleIcon from 'phosphor-svelte/lib/DownloadSimpleIcon';

  import type { MediaViewerActions } from './media-viewer-actions';

  interface Props {
    open: boolean;
    anchor: CursorAnchor | null;
    mediaActions: MediaViewerActions;
    downloadLabel: string;
  }

  let { open = $bindable(), anchor, mediaActions, downloadLabel }: Props = $props();
</script>

<ActionMenu
  bind:open
  label={i18n.t('viewer.imageMenu')}
  {anchor}
  side="bottom"
  align="start"
  preventScroll={false}
>
  <ActionMenuItem onSelect={() => void mediaActions.copyImage()}>
    <CopyIcon />
    {i18n.t('viewer.copyImage')}
  </ActionMenuItem>
  <ActionMenuItem onSelect={() => void mediaActions.save()}>
    <DownloadSimpleIcon />
    {downloadLabel}
  </ActionMenuItem>
</ActionMenu>
