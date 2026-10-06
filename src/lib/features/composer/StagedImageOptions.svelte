<script lang="ts">
  import MapPinIcon from 'phosphor-svelte/lib/MapPinIcon';
  import type { Snippet } from 'svelte';

  import { i18n } from '#lib/i18n.js';
  import type { ImageMetadata } from '#lib/settings/preferences.svelte.js';
  import ActionMenu from '#lib/ui/primitives/ActionMenu.svelte';
  import ActionMenuItem from '#lib/ui/primitives/ActionMenuItem.svelte';
  import ActionMenuSub from '#lib/ui/primitives/ActionMenuSub.svelte';

  import type { StagedFile } from './composer-files';

  interface Props {
    item: StagedFile;
    onSetMetadata: (id: number, metadata: ImageMetadata) => void;
    trigger: Snippet<[{ props: Record<string, unknown> }]>;
  }

  let { item, onSetMetadata, trigger }: Props = $props();

  const METADATA_CHOICES: readonly { value: ImageMetadata; label: string }[] = [
    { value: 'location', label: 'settings.imageMetadataLocation' },
    { value: 'all', label: 'settings.imageMetadataAll' },
    { value: 'keep', label: 'settings.imageMetadataKeep' },
  ];
</script>

<ActionMenu label={$i18n.t('composer.imageOptions', { name: item.file.name })} {trigger}>
  <ActionMenuSub label={$i18n.t('composer.metadataGroup')}>
    {#snippet trigger()}
      <MapPinIcon aria-hidden="true" />
      {$i18n.t('composer.metadataGroup')}
    {/snippet}
    {#each METADATA_CHOICES as choice (choice.value)}
      <ActionMenuItem
        checked={item.metadata === choice.value}
        onSelect={() => {
          onSetMetadata(item.id, choice.value);
        }}
      >
        <span class="menu-check" aria-hidden="true">
          {item.metadata === choice.value ? '✓' : ''}
        </span>
        {$i18n.t(choice.label)}
      </ActionMenuItem>
    {/each}
  </ActionMenuSub>
</ActionMenu>
