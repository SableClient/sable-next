<script lang="ts">
  import ChecksIcon from 'phosphor-svelte/lib/ChecksIcon';
  import { i18n } from '#lib/i18n.js';
  import type { CursorAnchor } from '#lib/ui/cursor-anchor.js';
  import ActionMenu from '#lib/ui/primitives/ActionMenu.svelte';
  import ActionMenuItem from '#lib/ui/primitives/ActionMenuItem.svelte';

  interface Props {
    open: boolean;
    anchor: CursorAnchor | null;
    markReadDisabled: boolean;
    onMarkRead: () => void;
  }

  let { open = $bindable(), anchor, markReadDisabled, onMarkRead }: Props = $props();
</script>

<ActionMenu bind:open label={i18n.t('nav.listOptions')} {anchor} side="right" align="start">
  <ActionMenuItem disabled={markReadDisabled} onSelect={onMarkRead}>
    <ChecksIcon />
    {i18n.t('common.markAsRead')}
  </ActionMenuItem>
</ActionMenu>
