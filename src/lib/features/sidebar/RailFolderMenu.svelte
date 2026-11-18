<script lang="ts">
  import CaretUpIcon from 'phosphor-svelte/lib/CaretUpIcon';
  import ChecksIcon from 'phosphor-svelte/lib/ChecksIcon';
  import FolderOpenIcon from 'phosphor-svelte/lib/FolderOpenIcon';
  import ImageIcon from 'phosphor-svelte/lib/ImageIcon';
  import PencilSimpleIcon from 'phosphor-svelte/lib/PencilSimpleIcon';
  import { i18n } from '#lib/i18n.js';
  import type { SidebarFolder } from '#lib/spaces/sidebar-layout.js';
  import type { CursorAnchor } from '#lib/ui/cursor-anchor.js';
  import ActionMenu from '#lib/ui/primitives/ActionMenu.svelte';
  import ActionMenuItem from '#lib/ui/primitives/ActionMenuItem.svelte';
  import ActionMenuSeparator from '#lib/ui/primitives/ActionMenuSeparator.svelte';

  interface Props {
    open: boolean;
    anchor: CursorAnchor | null;
    folder: SidebarFolder;
    foldersOpen: boolean;
    onMarkRead?: (folder: SidebarFolder) => void;
    onRename?: (folder: SidebarFolder) => void;
    onChangeIcon?: (folder: SidebarFolder) => void;
    onUngroup?: (folderId: string) => void;
    onCollapseFolders?: () => void;
  }

  let {
    open = $bindable(),
    anchor,
    folder,
    foldersOpen,
    onMarkRead,
    onRename,
    onChangeIcon,
    onUngroup,
    onCollapseFolders,
  }: Props = $props();
</script>

<ActionMenu bind:open label={i18n.t('nav.listOptions')} {anchor} side="right" align="start">
  <ActionMenuItem
    onSelect={() => {
      onMarkRead?.(folder);
    }}
  >
    <ChecksIcon />
    {i18n.t('common.markAsRead')}
  </ActionMenuItem>
  <ActionMenuSeparator />
  <ActionMenuItem
    onSelect={() => {
      onRename?.(folder);
    }}
  >
    <PencilSimpleIcon />
    {i18n.t('nav.folderRename')}
  </ActionMenuItem>
  {#if onChangeIcon}
    <ActionMenuItem
      onSelect={() => {
        onChangeIcon(folder);
      }}
    >
      <ImageIcon />
      {i18n.t('nav.changeIcon')}
    </ActionMenuItem>
  {/if}
  <ActionMenuItem
    onSelect={() => {
      onUngroup?.(folder.id);
    }}
  >
    <FolderOpenIcon />
    {i18n.t('nav.folderUngroup')}
  </ActionMenuItem>
  {#if onCollapseFolders}
    <ActionMenuItem disabled={!foldersOpen} onSelect={onCollapseFolders}>
      <CaretUpIcon />
      {i18n.t('nav.folderCollapseAll')}
    </ActionMenuItem>
  {/if}
</ActionMenu>
