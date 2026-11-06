<script lang="ts">
  import type { Snippet } from 'svelte';
  import ResponsiveDialog from './ResponsiveDialog.svelte';
  import IconButton from './IconButton.svelte';
  import { i18n } from '#lib/i18n.ts';
  import XIcon from 'phosphor-svelte/lib/XIcon';

  interface Props {
    open?: boolean;
    label: string;
    closeLabel: string;
    header: Snippet;
    body: Snippet<[boolean]>;
  }

  let { open = $bindable(false), label, closeLabel, header, body }: Props = $props();
</script>

<ResponsiveDialog bind:open {label} {closeLabel}>
  {#snippet children(desktop)}
    <div class={[{ sheet: !desktop }]}>
      <div class="title">
        {@render header()}
        {#if desktop}
          <IconButton
            variant="ghost"
            size="small"
            class="close"
            label={i18n.t('common.close')}
            onclick={() => {
              open = false;
            }}
          >
            <XIcon />
          </IconButton>
        {/if}
      </div>
      {@render body(desktop)}
    </div>
  {/snippet}
</ResponsiveDialog>

<style>
  .title {
    align-items: center;
    display: flex;

    & > :global(svg) {
      height: var(--icon-size-medium);
      margin-right: var(--space-200);
      width: var(--icon-size-medium);
    }

    :global(h2) {
      margin: 0;
    }

    :global(.close) {
      margin-left: auto;
    }
  }

  .sheet {
    padding: 0 var(--space-400);
    width: auto;
  }
</style>
