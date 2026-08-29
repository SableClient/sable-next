<script lang="ts">
  import '#lib/ui/primitives/menu.css';
  import { DropdownMenu } from 'bits-ui';
  import ImageIcon from 'phosphor-svelte/lib/ImageIcon';
  import ChartBarIcon from 'phosphor-svelte/lib/ChartBarIcon';
  import ClockIcon from 'phosphor-svelte/lib/ClockIcon';
  import MapPinIcon from 'phosphor-svelte/lib/MapPinIcon';
  import PaperclipIcon from 'phosphor-svelte/lib/PaperclipIcon';
  import PlusIcon from 'phosphor-svelte/lib/PlusIcon';

  import { i18n } from '#lib/i18n.js';
  import BottomSheet from '#lib/ui/primitives/BottomSheet.svelte';
  import Button from '#lib/ui/primitives/Button.svelte';

  interface Props {
    desktop: boolean;
    disabled?: boolean;
    onPick: (accept: string) => void;
    onPoll?: () => void;
    onLocation?: () => void;
    onSchedule?: () => void;
    onBeforeOpen?: () => void;
  }

  let {
    desktop,
    disabled = false,
    onPick,
    onPoll,
    onLocation,
    onSchedule,
    onBeforeOpen,
  }: Props = $props();
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
      <DropdownMenu.Content
        class="sable-menu composer-menu"
        side="top"
        align="start"
        sideOffset={8}
      >
        <DropdownMenu.Item
          class="sable-menu-item"
          onclick={() => {
            onPick(media);
          }}
        >
          <ImageIcon />
          {$i18n.t('composer.photoOrVideo')}
        </DropdownMenu.Item>
        <DropdownMenu.Item
          class="sable-menu-item"
          onclick={() => {
            onPick(any);
          }}
        >
          <PaperclipIcon />
          {$i18n.t('composer.attachFile')}
        </DropdownMenu.Item>
        {#if onPoll}
          <DropdownMenu.Item class="sable-menu-item" onclick={onPoll}>
            <ChartBarIcon />
            {$i18n.t('composer.poll')}
          </DropdownMenu.Item>
        {/if}
        {#if onLocation}
          <DropdownMenu.Item class="sable-menu-item" onclick={onLocation}>
            <MapPinIcon />
            {$i18n.t('composer.location')}
          </DropdownMenu.Item>
        {/if}
        {#if onSchedule}
          <DropdownMenu.Item class="sable-menu-item" onclick={onSchedule}>
            <ClockIcon />
            {$i18n.t('composer.schedule')}
          </DropdownMenu.Item>
        {/if}
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
      {#if onPoll}
        <Button
          variant="ghost"
          class="door-action"
          onclick={() => {
            open = false;
            onPoll();
          }}
        >
          <ChartBarIcon />
          {$i18n.t('composer.poll')}
        </Button>
      {/if}
      {#if onLocation}
        <Button
          variant="ghost"
          class="door-action"
          onclick={() => {
            open = false;
            onLocation();
          }}
        >
          <MapPinIcon />
          {$i18n.t('composer.location')}
        </Button>
      {/if}
      {#if onSchedule}
        <Button
          variant="ghost"
          class="door-action"
          onclick={() => {
            open = false;
            onSchedule();
          }}
        >
          <ClockIcon />
          {$i18n.t('composer.schedule')}
        </Button>
      {/if}
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
    border: var(--border-width) solid var(--sable-bg-container-line);
    border-radius: var(--radius);
    box-shadow: var(--shadow-float);
    display: grid;
    gap: 0.25rem;
    padding: 0.375rem;
    width: min(15rem, calc(100vw - 2rem));
    z-index: var(--layer-popover);
  }

  :global(.composer-menu .sable-menu-item > svg) {
    color: var(--sable-surface-var-on-container);
  }

  @media (prefers-reduced-motion: no-preference) {
    :global(.composer-door) {
      transition: background-color var(--motion-normal) var(--motion-easing-standard);
    }
  }
</style>
