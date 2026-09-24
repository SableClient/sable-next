<script lang="ts">
  import CheckIcon from 'phosphor-svelte/lib/CheckIcon';
  import LinkIcon from 'phosphor-svelte/lib/LinkIcon';

  import { i18n } from '#lib/i18n.js';
  import { settingsAnchorLink } from './settings-anchor-link.js';

  interface Props {
    anchor: string;
  }

  let { anchor }: Props = $props();
  const link = settingsAnchorLink();
  let copied = $state(false);
  let timer: ReturnType<typeof setTimeout> | undefined;

  async function copy(build: (anchor: string) => string): Promise<void> {
    await navigator.clipboard.writeText(build(anchor));
    copied = true;
    clearTimeout(timer);
    timer = setTimeout(() => {
      copied = false;
    }, 2000);
  }
</script>

{#if link}
  <button
    type="button"
    class="anchor-link"
    aria-label={$i18n.t(copied ? 'settings.linkCopied' : 'settings.copyLink')}
    onclick={() => void copy(link)}
  >
    {#if copied}<CheckIcon />{:else}<LinkIcon />{/if}
  </button>
{/if}

<style>
  .anchor-link {
    align-items: center;
    background: transparent;
    border: 0;
    border-radius: var(--radius-inner);
    color: var(--surface-var-on-container);
    cursor: pointer;
    display: inline-flex;
    flex: 0 0 auto;
    height: var(--icon-size-large);
    justify-content: center;
    padding: 0;
    width: var(--icon-size-large);
  }

  .anchor-link:hover {
    background: var(--surface-container-hover);
    color: inherit;
  }

  .anchor-link:focus-visible {
    outline: var(--focus-ring-width) solid var(--focus-ring);
    outline-offset: var(--focus-ring-offset);
  }

  .anchor-link :global(svg) {
    height: var(--icon-size-small);
    width: var(--icon-size-small);
  }

  @media (hover: hover) {
    .anchor-link {
      opacity: 0;
    }

    :global(:hover) > .anchor-link,
    .anchor-link:focus-visible {
      opacity: 1;
    }
  }
</style>
