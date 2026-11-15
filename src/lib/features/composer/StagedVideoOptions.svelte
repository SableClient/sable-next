<script lang="ts">
  import type { Snippet } from 'svelte';

  import { i18n } from '#lib/i18n.js';
  import ActionMenu from '#lib/ui/primitives/ActionMenu.svelte';
  import ActionMenuItem from '#lib/ui/primitives/ActionMenuItem.svelte';

  import type { StagedFile } from '#lib/composer/composer-files.js';

  interface Props {
    item: StagedFile;
    onSetGif: (id: number, gif: boolean | undefined) => void;
    trigger: Snippet<[{ props: Record<string, unknown> }]>;
  }

  let { item, onSetGif, trigger }: Props = $props();

  const GIF_CHOICES: readonly { value: boolean | undefined; label: string }[] = [
    { value: undefined, label: 'composer.playAsAuto' },
    { value: true, label: 'composer.playAsGif' },
    { value: false, label: 'composer.playAsVideo' },
  ];
</script>

<ActionMenu label={i18n.t('composer.imageOptions', { name: item.file.name })} {trigger}>
  {#each GIF_CHOICES as choice (choice.label)}
    <ActionMenuItem
      checked={item.gif === choice.value}
      onSelect={() => {
        onSetGif(item.id, choice.value);
      }}
    >
      <span class="menu-check" aria-hidden="true">
        {item.gif === choice.value ? '✓' : ''}
      </span>
      <span>{i18n.t(choice.label)}</span>
    </ActionMenuItem>
  {/each}
</ActionMenu>
