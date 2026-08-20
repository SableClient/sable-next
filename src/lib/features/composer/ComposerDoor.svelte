<script lang="ts">
  import { DropdownMenu } from 'bits-ui';
  import ImageIcon from 'phosphor-svelte/lib/ImageIcon';
  import PaperclipIcon from 'phosphor-svelte/lib/PaperclipIcon';
  import PlusIcon from 'phosphor-svelte/lib/PlusIcon';

  import { i18n } from '$lib/i18n';
  import BottomSheet from '$lib/ui/primitives/BottomSheet.svelte';
  import Button from '$lib/ui/primitives/Button.svelte';

  interface Props {
    desktop: boolean;
    disabled?: boolean;
    onPick: (accept: string) => void;
    onBeforeOpen?: () => void;
  }

  let { desktop, disabled = false, onPick, onBeforeOpen }: Props = $props();
  let open = $state(false);

  const media = 'image/*,video/*';
  const any = '*';
</script>

{#if desktop}
  <DropdownMenu.Root>
    <DropdownMenu.Trigger class="composer-door" {disabled} aria-label={$i18n.t('composer.insert')}>
      <PlusIcon />
    </DropdownMenu.Trigger>
    <DropdownMenu.Portal>
      <DropdownMenu.Content class="composer-menu" side="top" align="start" sideOffset={8}>
        <DropdownMenu.Item
          onclick={() => {
            onPick(media);
          }}
        >
          <ImageIcon />
          {$i18n.t('composer.photoOrVideo')}
        </DropdownMenu.Item>
        <DropdownMenu.Item
          onclick={() => {
            onPick(any);
          }}
        >
          <PaperclipIcon />
          {$i18n.t('composer.attachFile')}
        </DropdownMenu.Item>
      </DropdownMenu.Content>
    </DropdownMenu.Portal>
  </DropdownMenu.Root>
{:else}
  <button
    type="button"
    class="composer-door"
    {disabled}
    aria-label={$i18n.t('composer.insert')}
    onpointerdown={onBeforeOpen}
    onclick={() => {
      open = true;
    }}
  >
    <PlusIcon />
  </button>
  <BottomSheet
    bind:open
    label={$i18n.t('composer.insert')}
    closeLabel={$i18n.t('composer.closeInsert')}
  >
    <div class="door-sheet">
      <Button
        variant="ghost"
        class="door-action"
        onclick={() => {
          open = false;
          onPick(media);
        }}
      >
        <ImageIcon />
        {$i18n.t('composer.photoOrVideo')}
      </Button>
      <Button
        variant="ghost"
        class="door-action"
        onclick={() => {
          open = false;
          onPick(any);
        }}
      >
        <PaperclipIcon />
        {$i18n.t('composer.attachFile')}
      </Button>
    </div>
  </BottomSheet>
{/if}

<style>
  .door-sheet {
    display: grid;
    gap: 0.25rem;
    padding: 0 var(--space-2) var(--space-2);
  }

  :global(.door-action) {
    background: transparent;
    border-color: transparent;
    border-radius: var(--radius);
    color: inherit;
    gap: var(--space-2);
    min-height: 3rem;
    padding: 0 var(--space-2);
    text-align: left;
    width: 100%;
  }

  :global(.door-action:hover:not(:disabled)) {
    background: var(--sable-surface-container-hover);
  }

  :global(.door-action svg) {
    color: var(--sable-surface-var-on-container);
    height: var(--icon-size-medium);
    width: var(--icon-size-medium);
  }

  :global(.composer-door) {
    align-items: center;
    background: transparent;
    border: 0;
    border-radius: var(--radius);
    color: var(--sable-primary-main);
    cursor: pointer;
    display: flex;
    flex: 0 0 auto;
    height: var(--target);
    justify-content: center;
    position: relative;
    width: var(--target);
  }

  :global(.composer-door)::after {
    border-radius: inherit;
    content: '';
    inset: calc((var(--target) - var(--target-hit)) / 2);
    position: absolute;
  }

  :global(.composer-door:hover) {
    background: var(--sable-surface-container-hover);
  }

  :global(.composer-door[data-state='open']) {
    background: var(--sable-surface-container-active);
  }

  :global(.composer-door:disabled) {
    color: var(--sable-sec-main);
    cursor: default;
  }

  :global(.composer-door svg) {
    display: block;
    height: var(--icon-size-small);
    width: var(--icon-size-small);
  }

  :global(.composer-menu) {
    background: var(--sable-bg-container);
    border: 1px solid var(--sable-bg-container-line);
    border-radius: var(--radius);
    box-shadow: var(--shadow-float);
    display: grid;
    gap: 0.25rem;
    padding: 0.375rem;
    width: min(15rem, calc(100vw - 2rem));
    z-index: var(--layer-popover);
  }

  :global(.composer-menu [role='menuitem']) {
    align-items: center;
    background: transparent;
    border: 0;
    border-radius: calc(var(--radius) - 0.125rem);
    color: inherit;
    cursor: pointer;
    display: flex;
    gap: var(--space-1);
    padding: 0.5rem 0.625rem;
    text-align: left;
  }

  :global(.composer-menu [role='menuitem']:hover),
  :global(.composer-menu [role='menuitem'][data-highlighted]) {
    background: var(--sable-bg-container-hover);
  }

  :global(.composer-menu [role='menuitem'] svg) {
    color: var(--sable-surface-var-on-container);
    height: var(--icon-size-small);
    width: var(--icon-size-small);
  }

  @media (prefers-reduced-motion: no-preference) {
    :global(.composer-door) {
      transition: background-color var(--motion-normal) var(--motion-easing-standard);
    }
  }
</style>
