<script lang="ts">
  import { i18n } from '#lib/i18n.js';
  import { preferences, setPreference } from '#lib/settings/preferences.svelte.js';
  import type { CursorAnchor } from '#lib/ui/cursor-anchor.js';
  import ActionMenu from '#lib/ui/primitives/ActionMenu.svelte';
  import ActionMenuCheckItem from '#lib/ui/primitives/ActionMenuCheckItem.svelte';
  import ActionMenuItem from '#lib/ui/primitives/ActionMenuItem.svelte';
  import ActionMenuSeparator from '#lib/ui/primitives/ActionMenuSeparator.svelte';

  interface Props {
    open: boolean;
    anchor: CursorAnchor | null;
    foldersOpen: boolean;
    onCollapseFolders?: () => void;
  }

  let { open = $bindable(), anchor, foldersOpen, onCollapseFolders }: Props = $props();

  const displayToggles = [
    { key: 'showUnreadCounts', label: 'settings.showUnreadCounts' },
    { key: 'badgeCountDMsOnly', label: 'settings.badgeCountDMsOnly' },
    { key: 'showPingCounts', label: 'settings.showPingCounts' },
  ] as const;
  const viewToggles = [
    { key: 'showHome', label: 'settings.showHome' },
    { key: 'uniformIcons', label: 'settings.uniformIcons' },
  ] as const;
</script>

<ActionMenu bind:open label={i18n.t('nav.displayOptions')} {anchor} side="right" align="start">
  {#each displayToggles as toggle (toggle.key)}
    {@const on = preferences[toggle.key]}
    <ActionMenuCheckItem
      kind="checkbox"
      closeOnSelect={false}
      checked={on}
      label={i18n.t(toggle.label)}
      onSelect={() => {
        setPreference(toggle.key, !on);
      }}
    />
  {/each}

  <ActionMenuSeparator />

  {#each viewToggles as toggle (toggle.key)}
    {@const on = preferences[toggle.key]}
    <ActionMenuCheckItem
      kind="checkbox"
      closeOnSelect={false}
      checked={on}
      label={i18n.t(toggle.label)}
      onSelect={() => {
        setPreference(toggle.key, !on);
      }}
    />
  {/each}

  {#if onCollapseFolders}
    <ActionMenuSeparator />
    <ActionMenuItem disabled={!foldersOpen} onSelect={onCollapseFolders}>
      <span class="menu-check" aria-hidden="true"></span>
      <span>{i18n.t('nav.folderCollapseAll')}</span>
    </ActionMenuItem>
  {/if}
</ActionMenu>
