<script lang="ts">
  import { i18n } from '#lib/i18n.js';
  import DialogFrame from '#lib/ui/primitives/DialogFrame.svelte';

  import { formatBinding } from './binding.js';
  import { isMacPlatform } from './global-shortcuts.js';
  import { SHORTCUTS, type ShortcutDefinition } from './shortcuts.js';

  interface Props {
    open?: boolean;
  }

  let { open = $bindable(false) }: Props = $props();

  const categories: Array<{ id: ShortcutDefinition['category']; labelKey: string }> = [
    { id: 'navigation', labelKey: 'shortcuts.categoryNavigation' },
    { id: 'general', labelKey: 'shortcuts.categoryGeneral' },
  ];

  let isMac = $derived(isMacPlatform());
</script>

<DialogFrame bind:open variant="verification" label={$i18n.t('shortcuts.helpTitle')}>
  <div class="help">
    <h2>{$i18n.t('shortcuts.helpTitle')}</h2>
    {#each categories as category (category.id)}
      {@const items = SHORTCUTS.filter((shortcut) => shortcut.category === category.id)}
      <section aria-labelledby="shortcuts-{category.id}">
        <h3 id="shortcuts-{category.id}">{$i18n.t(category.labelKey)}</h3>
        <ul>
          {#each items as shortcut (shortcut.id)}
            <li>
              <span class="label">{$i18n.t(shortcut.labelKey)}</span>
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
    gap: var(--space-3);
    width: min(28rem, calc(100vw - 2rem));
  }

  h2 {
    font-size: var(--font-size-heading);
    line-height: var(--line-height-heading);
    margin: 0;
  }

  h3 {
    color: var(--sable-surface-var-on-container);
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
    background: var(--sable-surface-var-container);
    border-radius: calc(var(--radius) - 0.25rem);
    font-family: var(--font-family-mono);
    font-size: var(--font-size-small);
    padding: var(--space-100) var(--space-150);
  }
</style>
