<script lang="ts">
  import CheckIcon from 'phosphor-svelte/lib/CheckIcon';
  import LinkIcon from 'phosphor-svelte/lib/LinkIcon';

  import { i18n } from '#lib/i18n.js';
  import { longPress } from '#lib/ui/long-press.svelte.js';
  import { toasts } from '#lib/ui/toasts.svelte.js';
  import { settingsAnchors } from './settings-anchors.js';

  interface Props {
    anchor: string;
  }

  const HOSTS = '.setting-row, .settings-section-header, .settings-heading-row';

  let { anchor }: Props = $props();
  const link = settingsAnchors()?.link;
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

  function pressToCopy(build: (anchor: string) => string) {
    return (button: HTMLElement): (() => void) | undefined => {
      const host = button.closest(HOSTS);
      if (!host) return undefined;
      return longPress({
        onPress: () => {
          void copy(build).then(() => toasts.info($i18n.t('settings.linkCopied')));
        },
      })(host);
    };
  }
</script>

{#if link}
  <button
    type="button"
    class="anchor-link"
    aria-label={$i18n.t(copied ? 'settings.linkCopied' : 'settings.copyLink')}
    onclick={() => void copy(link)}
    {@attach pressToCopy(link)}
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

  @media (pointer: coarse) {
    .anchor-link {
      display: none;
    }

    :global(:is(.setting-row, .settings-section-header, .settings-heading-row):has(.anchor-link)) {
      -webkit-touch-callout: none;
      user-select: none;
    }
  }

  @media (hover: hover) {
    .anchor-link {
      opacity: 0;
    }

    :global(
        :is(.setting-row, .settings-heading-row, .settings-section-title):is(:hover, :focus-within)
      )
      .anchor-link {
      opacity: 1;
    }
  }
</style>
