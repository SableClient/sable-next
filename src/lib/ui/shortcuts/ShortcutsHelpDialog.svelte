<script lang="ts">
  import XIcon from 'phosphor-svelte/lib/XIcon';
  import { i18n } from '#lib/i18n.js';
  import DialogFrame from '#lib/ui/primitives/DialogFrame.svelte';
  import IconButton from '#lib/ui/primitives/IconButton.svelte';

  import { formatBinding } from './binding.js';
  import { isMacPlatform } from './global-shortcuts.js';
  import { effectiveShortcuts } from './bindings.svelte.js';
  import { SHORTCUT_CATEGORIES } from './shortcuts.js';

  interface Props {
    open?: boolean;
  }

  let { open = $bindable(false) }: Props = $props();

  let shortcuts = $derived(effectiveShortcuts());

  let isMac = $derived(isMacPlatform());
</script>

<DialogFrame bind:open variant="verification" label={i18n.t('shortcuts.helpTitle')}>
  <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
  <div class="help" tabindex="0">
    <div class="help-header">
      <h2>{i18n.t('shortcuts.helpTitle')}</h2>
      <IconButton
        variant="ghost"
        size="small"
        label={i18n.t('common.close')}
        onclick={() => {
          open = false;
        }}
      >
        <XIcon />
      </IconButton>
    </div>
    {#each SHORTCUT_CATEGORIES as category (category.id)}
      {@const items = shortcuts.filter((shortcut) => shortcut.category === category.id)}
      <section aria-labelledby="shortcuts-{category.id}">
        <h3 id="shortcuts-{category.id}">{i18n.t(category.labelKey)}</h3>
        <ul>
          {#each items as shortcut (shortcut.id)}
            <li>
              <span class="label">{i18n.t(shortcut.labelKey)}</span>
              <kbd>{formatBinding(shortcut.binding, isMac)}</kbd>
            </li>
          {/each}
        </ul>
      </section>
    {/each}
  </div>
</DialogFrame>

<style>
  .help {
    display: grid;
    gap: var(--space-400);
    width: min(28rem, calc(100vw - 2rem));
  }

  .help-header {
    align-items: center;
    display: flex;
    justify-content: space-between;
  }

  h2 {
    font-size: var(--font-size-heading);
    line-height: var(--line-height-heading);
    margin: 0;
  }

  h3 {
    color: var(--surface-var-on-container);
    font-size: var(--font-size-small);
    margin: 0 0 var(--space-100);
    text-transform: uppercase;
  }

  ul {
    display: grid;
    gap: var(--space-100);
    list-style: none;
    margin: 0;
    padding: 0;
  }

  li {
    align-items: center;
    display: flex;
    justify-content: space-between;
    min-height: var(--control-height-500);
  }

  kbd {
    background: var(--surface-var-container);
    border-radius: var(--radii-300);
    font-family: var(--font-family-mono);
    font-size: var(--font-size-small);
    font-variant-ligatures: none;
    padding: var(--space-100) var(--space-150);
  }
</style>
