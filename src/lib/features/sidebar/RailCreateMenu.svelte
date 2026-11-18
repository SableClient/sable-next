<script lang="ts">
  import CompassIcon from 'phosphor-svelte/lib/CompassIcon';
  import HouseIcon from 'phosphor-svelte/lib/HouseIcon';
  import LinkIcon from 'phosphor-svelte/lib/LinkIcon';
  import PlusIcon from 'phosphor-svelte/lib/PlusIcon';
  import { resolve } from '$app/paths';
  import { i18n } from '#lib/i18n.js';
  import { openFindOrJoin } from '#lib/ui/find-or-join-state.svelte.js';
  import ActionMenu from '#lib/ui/primitives/ActionMenu.svelte';
  import ActionMenuItem from '#lib/ui/primitives/ActionMenuItem.svelte';

  interface Props {
    open: boolean;
    anchor: HTMLElement | null;
    onNavigate: (href: string) => void;
  }

  let { open = $bindable(), anchor, onNavigate }: Props = $props();

  const createEntries = [
    { href: resolve('create-room'), label: 'common.createRoom', icon: PlusIcon },
    { href: resolve('create-space'), label: 'common.createSpace', icon: HouseIcon },
    { href: null, label: 'nav.findOrJoin', icon: LinkIcon },
    { href: resolve('explore'), label: 'nav.explore', icon: CompassIcon },
  ] as const;
</script>

<ActionMenu bind:open label={i18n.t('nav.add')} {anchor} side="right" align="end">
  {#each createEntries as entry (entry.label)}
    <ActionMenuItem
      onSelect={() => {
        if (entry.href === null) openFindOrJoin();
        else onNavigate(entry.href);
      }}
    >
      <entry.icon />
      {i18n.t(entry.label)}
    </ActionMenuItem>
  {/each}
</ActionMenu>
