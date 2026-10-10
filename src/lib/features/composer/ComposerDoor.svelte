<script lang="ts">
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
  import Button from '#lib/ui/primitives/Button.svelte';
  import Tooltip from '#lib/ui/primitives/Tooltip.svelte';
  import { overlayLayer } from '#lib/ui/overlay-layer.js';

  interface Props {
    desktop: boolean;
    disabled?: boolean;
    onPick: (accept: string) => void;
    onCapture?: (accept: string) => void;
    onPoll?: () => void;
    onLocation?: () => void;
    onSchedule?: () => void;
    onVoice?: () => void;
    onBeforeOpen?: () => void;
  }

  let {
    desktop,
    disabled = false,
    onPick,
    onCapture,
    onPoll,
    onLocation,
    onSchedule,
    onVoice,
    onBeforeOpen,
  }: Props = $props();
  let open = $state(false);

  const media = 'image/*,video/*';
  const any = '*';
</script>

{#if desktop}
  <DropdownMenu.Root>
    <Tooltip label={$i18n.t('composer.insert')}>
      {#snippet trigger({ props })}
        <DropdownMenu.Trigger
          {...props}
          class="composer-door selection-open"
          {disabled}
          aria-label={$i18n.t('composer.insert')}
        >
          <PlusIcon />
        </DropdownMenu.Trigger>
      {/snippet}
    </Tooltip>
    <DropdownMenu.Portal>
      <DropdownMenu.Content
        class="menu-surface composer-menu"
        {...overlayLayer()}
        side="top"
        align="start"
        sideOffset={8}
      >
        <DropdownMenu.Item
          class="menu-item"
          onclick={() => {
            onPick(media);
          }}
        >
          <ImageIcon />
          {$i18n.t('composer.photoOrVideo')}
        </DropdownMenu.Item>
        <DropdownMenu.Item
          class="menu-item"
          onclick={() => {
            onPick(any);
          }}
        >
          <PaperclipIcon />
          {$i18n.t('composer.attachFile')}
        </DropdownMenu.Item>
        {#if onVoice}
          <DropdownMenu.Item class="menu-item" onclick={onVoice}>
            <MicrophoneIcon />
            {$i18n.t('composer.voiceRecord')}
          </DropdownMenu.Item>
        {/if}
        {#if onPoll}
          <DropdownMenu.Item class="menu-item" onclick={onPoll}>
            <ChartBarIcon />
            {$i18n.t('composer.poll')}
          </DropdownMenu.Item>
        {/if}
        {#if onLocation}
          <DropdownMenu.Item class="menu-item" onclick={onLocation}>
            <MapPinIcon />
            {$i18n.t('composer.location')}
          </DropdownMenu.Item>
        {/if}
        {#if onSchedule}
          <DropdownMenu.Item class="menu-item" onclick={onSchedule}>
            <ClockIcon />
            {$i18n.t('composer.scheduleMessage')}
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
      {#if onCapture}
        <Button
          variant="ghost"
          class="door-action"
          onclick={() => {
            open = false;
            onCapture('image/*');
          }}
        >
          <CameraIcon />
          {$i18n.t('composer.takePhoto')}
        </Button>
        <Button
          variant="ghost"
          class="door-action"
          onclick={() => {
            open = false;
            onCapture('video/*');
          }}
        >
          <VideoCameraIcon />
          {$i18n.t('composer.recordVideo')}
        </Button>
      {/if}
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
      {#if onVoice}
        <Button
          variant="ghost"
          class="door-action"
          onclick={() => {
            open = false;
            onVoice();
          }}
        >
          <MicrophoneIcon />
          {$i18n.t('composer.voiceRecord')}
        </Button>
      {/if}
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
          {$i18n.t('composer.scheduleMessage')}
        </Button>
      {/if}
    </div>
  </BottomSheet>
{/if}

<style>
  .door-sheet {
    display: grid;
    gap: var(--space-100);
    padding: 0 var(--space-300) var(--space-300);
  }

  :global(.btn.door-action) {
    background: transparent;
    border-color: transparent;
    border-radius: var(--radius);
    color: inherit;
    gap: var(--space-300);
    justify-content: flex-start;
    min-height: 3rem;
    padding: 0 var(--space-300);
    text-align: left;
    width: 100%;
  }

  @media (any-hover: hover) and (any-pointer: fine) {
    :global(.door-action:hover:not(:disabled)) {
      background: var(--surface-container-hover);
    }

    :global(.composer-door:hover) {
      background: var(--surface-container-hover);
    }
  }

  :global(.door-action svg) {
    color: var(--surface-var-on-container);
    height: var(--icon-size-medium);
    width: var(--icon-size-medium);
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
