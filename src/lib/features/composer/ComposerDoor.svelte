<script lang="ts">
  import { currentDirection } from '#lib/language.svelte.js';
  import '#lib/ui/primitives/menu.css';
  import { DropdownMenu } from 'bits-ui';
  import CameraIcon from 'phosphor-svelte/lib/CameraIcon';
  import ImageIcon from 'phosphor-svelte/lib/ImageIcon';
  import ChartBarIcon from 'phosphor-svelte/lib/ChartBarIcon';
  import ClockIcon from 'phosphor-svelte/lib/ClockIcon';
  import MapPinIcon from 'phosphor-svelte/lib/MapPinIcon';
  import MicrophoneIcon from 'phosphor-svelte/lib/MicrophoneIcon';
  import PaperclipIcon from 'phosphor-svelte/lib/PaperclipIcon';
  import PlusIcon from 'phosphor-svelte/lib/PlusIcon';
  import VideoCameraIcon from 'phosphor-svelte/lib/VideoCameraIcon';

  import { i18n } from '#lib/i18n.js';
  import BottomSheet from '#lib/ui/primitives/BottomSheet.svelte';
  import Tooltip from '#lib/ui/primitives/Tooltip.svelte';
  import { overlayLayer } from '#lib/ui/overlay-layer.js';
  import { collisionPadding } from '#lib/ui/titlebar-inset.svelte.js';
  import type { Component, Snippet } from 'svelte';

  import RecentMediaStrip from './RecentMediaStrip.svelte';

  interface Props {
    desktop: boolean;
    disabled?: boolean;
    onPick: (accept: string) => void;
    onCapture?: (accept: string) => void;
    onFiles?: (files: File[]) => void;
    onPoll?: () => void;
    onLocation?: () => void;
    onSchedule?: () => void;
    onVoice?: () => void;
    onBeforeOpen?: () => void;
    extras?: Partial<Record<'persona', Snippet<[onReorder: () => void]>>>;
  }

  let {
    desktop,
    disabled = false,
    onPick,
    onCapture,
    onFiles,
    onPoll,
    onLocation,
    onSchedule,
    onVoice,
    onBeforeOpen,
    extras = undefined,
  }: Props = $props();
  let open = $state(false);

  const media = 'image/*,video/*';
  const any = '*';
</script>

{#snippet action(label: string, Icon: Component, run: () => void)}
  <button
    type="button"
    class="door-action"
    onclick={() => {
      open = false;
      run();
    }}
  >
    <span class="door-action-icon"><Icon /></span>
    {label}
  </button>
{/snippet}

{#if extras}
  {#each Object.entries(extras) as [id, extra] (id)}
    {@render extra(() => {})}
  {/each}
{/if}
{#if desktop}
  <DropdownMenu.Root dir={currentDirection()}>
    <Tooltip label={i18n.t('composer.insert')}>
      {#snippet trigger({ props })}
        <DropdownMenu.Trigger
          {...props}
          class="composer-door selection-open"
          {disabled}
          aria-label={i18n.t('composer.insert')}
        >
          <PlusIcon />
        </DropdownMenu.Trigger>
      {/snippet}
    </Tooltip>
    <DropdownMenu.Portal>
      <DropdownMenu.Content
        dir={currentDirection()}
        class="menu-surface composer-menu"
        {...overlayLayer()}
        side="top"
        align="start"
        sideOffset={8}
        collisionPadding={collisionPadding()}
      >
        <DropdownMenu.Item
          class="menu-item"
          onclick={() => {
            onPick(media);
          }}
        >
          <ImageIcon />
          {i18n.t('composer.photoOrVideo')}
        </DropdownMenu.Item>
        <DropdownMenu.Item
          class="menu-item"
          onclick={() => {
            onPick(any);
          }}
        >
          <PaperclipIcon />
          {i18n.t('composer.attachFile')}
        </DropdownMenu.Item>
        {#if onVoice}
          <DropdownMenu.Item class="menu-item" onclick={onVoice}>
            <MicrophoneIcon />
            {i18n.t('composer.voiceRecord')}
          </DropdownMenu.Item>
        {/if}
        {#if onPoll}
          <DropdownMenu.Item class="menu-item" onclick={onPoll}>
            <ChartBarIcon />
            {i18n.t('composer.poll')}
          </DropdownMenu.Item>
        {/if}
        {#if onLocation}
          <DropdownMenu.Item class="menu-item" onclick={onLocation}>
            <MapPinIcon />
            {i18n.t('composer.location')}
          </DropdownMenu.Item>
        {/if}
        {#if onSchedule}
          <DropdownMenu.Item class="menu-item" onclick={onSchedule}>
            <ClockIcon />
            {i18n.t('composer.scheduleMessage')}
          </DropdownMenu.Item>
        {/if}
      </DropdownMenu.Content>
    </DropdownMenu.Portal>
  </DropdownMenu.Root>
{:else}
  <button
    type="button"
    class="composer-door selection-open"
    {disabled}
    data-state={open ? 'open' : 'closed'}
    aria-label={i18n.t('composer.insert')}
    onpointerdown={() => {
      onBeforeOpen?.();
      open = true;
    }}
    onclick={() => {
      open = true;
    }}
  >
    <PlusIcon />
  </button>
  <BottomSheet
    bind:open
    label={i18n.t('composer.insert')}
    closeLabel={i18n.t('composer.closeInsert')}
  >
    <div class="door-sheet">
      {#if onFiles}
        <RecentMediaStrip
          onFile={(file) => {
            open = false;
            onFiles([file]);
          }}
        />
      {/if}
      <div class="door-actions scrollbar-hidden" data-sheet-no-drag>
        {@render action(i18n.t('composer.doorPhotos'), ImageIcon, () => {
          onPick(media);
        })}
        {#if onCapture}
          {@render action(i18n.t('composer.doorCamera'), CameraIcon, () => {
            onCapture('image/*');
          })}
          {@render action(i18n.t('composer.doorVideo'), VideoCameraIcon, () => {
            onCapture('video/*');
          })}
        {/if}
        {@render action(i18n.t('composer.doorFile'), PaperclipIcon, () => {
          onPick(any);
        })}
        {#if onVoice}
          {@render action(i18n.t('composer.doorVoice'), MicrophoneIcon, onVoice)}
        {/if}
        {#if onPoll}
          {@render action(i18n.t('composer.poll'), ChartBarIcon, onPoll)}
        {/if}
        {#if onLocation}
          {@render action(i18n.t('composer.location'), MapPinIcon, onLocation)}
        {/if}
        {#if onSchedule}
          {@render action(i18n.t('composer.doorSchedule'), ClockIcon, onSchedule)}
        {/if}
      </div>
    </div>
  </BottomSheet>
{/if}

<style>
  .door-sheet {
    display: grid;
    gap: var(--space-300);
    padding-bottom: var(--space-300);
  }

  .door-actions {
    display: flex;
    gap: var(--space-200);
    overflow-x: auto;
    padding: 0 var(--space-300);
    touch-action: pan-x;
  }

  .door-action {
    align-items: center;
    background: transparent;
    border: 0;
    color: inherit;
    cursor: pointer;
    display: flex;
    flex: 0 0 auto;
    flex-direction: column;
    font: inherit;
    font-size: var(--font-size-small);
    gap: var(--space-100);
    padding: 0;
    width: 4.5rem;
  }

  .door-action-icon {
    align-items: center;
    background: var(--surface-container-hover);
    border-radius: 999px;
    display: flex;
    height: 3.25rem;
    justify-content: center;
    width: 100%;
  }

  .door-action-icon :global(svg) {
    color: var(--surface-var-on-container);
    height: var(--icon-size-medium);
    width: var(--icon-size-medium);
  }

  @media (any-hover: hover) and (any-pointer: fine) {
    :global(.composer-door:hover) {
      background: var(--surface-container-hover);
    }
  }

  :global(.composer-door) {
    align-items: center;
    background: transparent;
    border: 0;
    border-radius: var(--radius);
    color: var(--surface-var-on-container);
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

  :global(.composer-door:disabled) {
    color: var(--sec-main);
    cursor: default;
  }

  :global(.composer-door svg) {
    display: block;
    height: var(--icon-size-small);
    width: var(--icon-size-small);
  }

  :global(.menu-surface.composer-menu) {
    --radius-outer: var(--radii-500);
    --radius-padding: var(--space-150);
    --radius-inner: max(0px, calc(var(--radius-outer) - var(--radius-padding)));

    background: var(--surface-container);
    border: var(--border-width) solid var(--surface-container-line);
    border-radius: var(--radius-outer);
    box-shadow: var(--shadow-float);
    display: grid;
    gap: var(--space-100);
    padding: var(--radius-padding);
    width: min(15rem, calc(100vw - 2rem));
  }

  :global(.composer-menu .menu-item > svg) {
    color: var(--surface-var-on-container);
  }

  @media (prefers-reduced-motion: no-preference) {
    :global(.composer-door) {
      transition: background-color var(--motion-normal) var(--motion-easing-standard);
    }
  }
</style>
