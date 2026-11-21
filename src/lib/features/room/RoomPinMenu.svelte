<script lang="ts">
  import PushPinIcon from 'phosphor-svelte/lib/PushPinIcon';
  import XIcon from 'phosphor-svelte/lib/XIcon';
  import IconContext from 'phosphor-svelte/lib/IconContext';
  import type { MemberView } from '#src/generated/protocol';

  import { i18n } from '#lib/i18n.js';
  import ActionMenu from '#lib/ui/primitives/ActionMenu.svelte';
  import IconButton from '#lib/ui/primitives/IconButton.svelte';
  import PanelHeaderButton from '#lib/ui/primitives/PanelHeaderButton.svelte';

  import { useRoomPins } from './room-pins.svelte.js';
  import RoomPinList from './RoomPinList.svelte';

  interface Props {
    roomId: string;
    members: readonly MemberView[];
    canPin: boolean;
    open?: boolean;
    triggerHidden?: boolean;
    onJump: (eventId: string) => void;
  }

  let {
    roomId,
    members,
    canPin,
    open = $bindable(false),
    triggerHidden = false,
    onJump,
  }: Props = $props();
  const pins = useRoomPins();
</script>

{#snippet pinTrigger({ props }: { props: Record<string, unknown> })}
  <PanelHeaderButton {...props} class="pin-button selection-open" label={i18n.t('room.pinsTitle')}>
    <PushPinIcon weight={open ? 'fill' : 'regular'} />
    {#if pins.pinnedIds.length > 0}
      <span class={['pin-badge', { unread: pins.unread > 0 }]} aria-hidden="true"
        >{pins.pinnedIds.length}</span
      >
    {/if}
  </PanelHeaderButton>
{/snippet}

<ActionMenu
  bind:open
  label={i18n.t('room.pinsTitle')}
  class="pin-menu"
  side="bottom"
  align="center"
  sideOffset={4}
  trigger={triggerHidden ? undefined : pinTrigger}
  onOpenChange={(next) => {
    if (!next && roomId) void pins.refresh(roomId);
  }}
>
  <header class="pin-header">
    <h2>{i18n.t('room.pinsTitle')}</h2>
    <IconContext values={{ 'aria-hidden': 'true' }}>
      <IconButton
        variant="ghost"
        size="small"
        label={i18n.t('room.pinsClose')}
        onclick={() => {
          open = false;
        }}
      >
        <XIcon />
      </IconButton>
    </IconContext>
  </header>

  <RoomPinList
    {roomId}
    {members}
    {canPin}
    {onJump}
    onClose={() => {
      open = false;
    }}
  />
</ActionMenu>

<style>
  :global(.menu-surface.pin-menu) {
    --menu-max-height: min(28rem, 70dvh, var(--bits-floating-available-height, 100dvh));

    gap: var(--space-200);
    width: min(28rem, calc(100vw - var(--space-500)));
  }

  :global(.pin-menu > .menu-scroll-content) {
    grid-template-rows: auto minmax(0, 1fr);
    overflow: hidden;
  }

  :global(.pin-button) {
    position: relative;
  }

  .pin-badge {
    background: var(--surface-container-active);
    border-radius: var(--radius-pill);
    color: var(--surface-on-container);
    font-size: var(--font-size-small);
    font-weight: var(--font-weight-bold);
    inset-inline-start: 0;
    line-height: 1;
    min-width: 1rem;
    padding: var(--space-050) var(--space-100);
    position: absolute;
    text-align: center;
    top: 0;
  }

  .pin-badge.unread {
    background: var(--primary-main);
    color: var(--primary-on-main);
  }

  .pin-header {
    align-items: center;
    display: flex;
    gap: var(--space-300);
    justify-content: space-between;
    padding: var(--space-200) var(--space-200) var(--space-200) var(--space-300);
  }

  .pin-header h2 {
    font-size: var(--font-size-heading);
    line-height: var(--line-height-heading);
    margin: 0;
  }
</style>
