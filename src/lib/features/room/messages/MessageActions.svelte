<script lang="ts">
  import IconContext from 'phosphor-svelte/lib/IconContext';
  import ReplyIcon from 'phosphor-svelte/lib/ArrowBendUpLeftIcon';
  import EditIcon from 'phosphor-svelte/lib/PencilSimpleIcon';
  import MoreIcon from 'phosphor-svelte/lib/DotsThreeIcon';
  import EmojiIcon from 'phosphor-svelte/lib/SmileyIcon';
  import { on } from 'svelte/events';

  import { i18n } from '#lib/i18n.js';
  import ActionMenu from '#lib/ui/primitives/ActionMenu.svelte';
  import ActionMenuItem from '#lib/ui/primitives/ActionMenuItem.svelte';
  import ActionMenuSeparator from '#lib/ui/primitives/ActionMenuSeparator.svelte';
  import IconButton from '#lib/ui/primitives/IconButton.svelte';
  import Tooltip from '#lib/ui/primitives/Tooltip.svelte';
  import { preferences } from '#lib/settings/preferences.svelte.js';
  import { shiftHeld } from '#lib/ui/shift-held.svelte.js';

  import MessageQuickReactions from './MessageQuickReactions.svelte';
  import ReactionPicker from './ReactionPicker.svelte';
  import { messageMenuRows, type MessageActions } from './message-menu-items';

  type Props = MessageActions & {
    roomId?: string;
    onPickerOpenChange?: (open: boolean) => void;
    onOverflowOpenChange?: (open: boolean) => void;
    /** Whether the message is hovered or focused, so Shift may expand its toolbar. */
    engaged?: boolean;
  };

  let {
    roomId = '',
    onPickerOpenChange,
    onOverflowOpenChange,
    engaged = true,
    ...actions
  }: Props = $props();

  let rows = $derived(messageMenuRows(actions));
  let inlineRows = $derived(rows.filter((row) => row.key !== 'reply' && row.key !== 'edit'));

  // Swapping the buttons would unmount an open menu, move a picker's anchor or drop
  // keyboard focus, so the form in place then is kept until those end.
  let popupOpen = $state(false);
  let focusInside = $state(false);
  let kept = $state<boolean | null>(null);
  let expanded = $derived(kept ?? (preferences.expandedMessageActions || (engaged && shiftHeld())));

  function hold(change: () => void): void {
    const was = popupOpen || focusInside;
    const current = expanded;
    change();
    if (!(popupOpen || focusInside)) kept = null;
    else if (!was) kept = current;
  }

  function trackPopup(forward?: (open: boolean) => void) {
    return (open: boolean) => {
      hold(() => (popupOpen = open));
      forward?.(open);
    };
  }

  function trackFocus(node: HTMLElement) {
    const offIn = on(node, 'focusin', (event) => {
      if (event.target instanceof Element && event.target.matches(':focus-visible'))
        hold(() => (focusInside = true));
    });
    const offOut = on(node, 'focusout', (event) => {
      if (!node.contains(event.relatedTarget as Node | null)) hold(() => (focusInside = false));
    });
    return () => {
      offIn();
      offOut();
    };
  }

  // Matches `--button-height` on `.message-action-button`; every toolbar button is square.
  const BUTTON_REM = 1.5;
  const QUICK_REACTIONS = 3;

  // Room for the inline buttons and the cost of each, in px; unlimited until measured.
  let room = $state(Infinity);
  let buttonCost = $state(0);
  let dividerCost = $state(0);
  let leadCount = $derived(
    (actions.onReact ? QUICK_REACTIONS + 1 : 0) +
      (actions.onReply ? 1 : 0) +
      (actions.onEdit ? 1 : 0)
  );

  let inlineCount = $derived.by(() => {
    const costs = inlineRows.map(
      (row, index) => buttonCost + (row.separated && index > 0 ? dividerCost : 0)
    );
    const tailRoom = room - leadCount * buttonCost;
    let used = costs.reduce((sum, cost) => sum + cost, 0);
    if (used <= tailRoom) return inlineRows.length;
    used = buttonCost;
    let count = 0;
    while (count < costs.length && used + costs[count] <= tailRoom) used += costs[count++];
    return count;
  });
  let shownRows = $derived(expanded ? inlineRows.slice(0, inlineCount) : []);
  let menuRows = $derived(expanded ? inlineRows.slice(inlineCount) : rows);

  function measure(node: HTMLElement) {
    const container = node.offsetParent;
    if (!container) return;
    const observer = new ResizeObserver(() => {
      if (container.clientWidth === 0) return;
      const style = getComputedStyle(node);
      const rem = parseFloat(getComputedStyle(document.documentElement).fontSize);
      const gap = parseFloat(style.columnGap) || 0;
      const border = parseFloat(style.borderInlineStartWidth) || 0;
      const frame = ((parseFloat(style.paddingInlineStart) || 0) + border) * 2;
      // Mirror the end inset at the start so the toolbar never meets the row's far edge.
      const inset = (parseFloat(style.insetInlineEnd) || 0) * 2;
      room = container.clientWidth - inset - frame + gap;
      buttonCost = BUTTON_REM * rem + gap;
      dividerCost = border + gap;
    });
    observer.observe(container);
    return () => observer.disconnect();
  }
</script>

<div class="message-actions" {@attach measure} {@attach trackFocus}>
  {#if actions.onReact}
    <MessageQuickReactions toolbar count={3} onReact={actions.onReact} divider={false} {roomId} />
    <ReactionPicker
      label={i18n.t('timeline.addReaction')}
      {roomId}
      onPick={actions.onReact}
      onOpenChange={trackPopup(onPickerOpenChange)}
      triggerClass="btn btn-ghost btn-icon icon-button icon-button-small message-action-button"
    >
      <EmojiIcon />
    </ReactionPicker>
  {/if}
  {#if actions.onReply}
    <IconButton
      class="message-action-button"
      size="small"
      variant="ghost"
      label={i18n.t('timeline.reply')}
      onclick={actions.onReply}
    >
      <ReplyIcon class="mirror-rtl" />
    </IconButton>
  {/if}
  {#if actions.onEdit}
    <IconButton
      class="message-action-button"
      size="small"
      variant="ghost"
      label={i18n.t('timeline.editMessage')}
      onclick={actions.onEdit}
    >
      <EditIcon />
    </IconButton>
  {/if}
  {#if shownRows.length + menuRows.length > 0}
    <div class="message-actions-tail">
      {#each shownRows as row, index (row.key)}
        {@const RowIcon = row.icon}
        {@const label = i18n.t(row.label)}
        {#if row.separated && index > 0}
          <span class="message-action-divider" aria-hidden="true"></span>
        {/if}
        <Tooltip {label}>
          {#snippet trigger({ props })}
            <IconButton
              {...props}
              class={['message-action-button', { destructive: row.destructive }]}
              size="small"
              variant="ghost"
              {label}
              onclick={() => row.run()}
            >
              <RowIcon class={row.mirrored ? 'mirror-rtl' : undefined} />
            </IconButton>
          {/snippet}
        </Tooltip>
      {/each}
      {#if menuRows.length > 0}
        <ActionMenu
          class="message-menu"
          label={i18n.t('timeline.moreActions')}
          onOpenChange={trackPopup(onOverflowOpenChange)}
        >
          {#snippet trigger({ props })}
            <IconButton
              {...props}
              size="small"
              variant="ghost"
              class="message-action-button selection-open"
              label={i18n.t('timeline.moreActions')}
            >
              <MoreIcon />
            </IconButton>
          {/snippet}
          <IconContext values={{ 'aria-hidden': 'true' }}>
            {#each menuRows as row, index (row.key)}
              {@const RowIcon = row.icon}
              {#if row.separated && index > 0}
                <ActionMenuSeparator />
              {/if}
              <ActionMenuItem
                class="menu-item-trailing-icon"
                destructive={row.destructive}
                onSelect={row.run}
              >
                <RowIcon class={row.mirrored ? 'mirror-rtl' : undefined} />
                <span>{i18n.t(row.label)}</span>
              </ActionMenuItem>
            {/each}
          </IconContext>
        </ActionMenu>
      {/if}
    </div>
  {/if}
</div>

<style>
  .message-actions {
    --radius-outer: var(--radius);
    --radius-padding: var(--space-050);
    --radius-inner: max(0px, calc(var(--radius-outer) - var(--radius-padding)));

    align-items: center;
    background: var(--surface-var-container);
    border: var(--border-width) solid var(--surface-var-container-line);
    border-radius: var(--radius-outer);
    color: var(--surface-var-on-container);
    inset-inline-end: var(--space-300);
    bottom: calc(100% - var(--space-200));
    box-shadow: var(--shadow-float);
    display: flex;
    gap: var(--space-050);
    opacity: 0;
    padding: var(--radius-padding);
    pointer-events: none;
    position: absolute;
    z-index: 3;
  }

  .message-actions :global(.message-action-button) {
    --button-height: 1.5rem;

    border-radius: var(--radius-inner);
    color: var(--surface-var-on-container);
    position: relative;
  }

  .message-actions :global(.message-action-button::after) {
    content: '';
    inset: calc(var(--space-200) * -1) -1px;
    position: absolute;
  }

  .message-actions-tail {
    align-items: center;
    display: flex;
    gap: inherit;
  }

  .message-actions :global(.message-action-button.destructive) {
    color: var(--crit-main);
  }

  .message-action-divider {
    align-self: stretch;
    background: var(--surface-var-container-line);
    inline-size: var(--border-width);
    margin-block: var(--space-050);
  }

  .message-actions :global(button:focus-visible) {
    outline: var(--focus-ring-width) solid var(--focus-ring);
    outline-offset: -1px;
  }

  @media (prefers-reduced-motion: no-preference) {
    .message-actions {
      transition: opacity var(--motion-normal) var(--motion-easing-standard);
    }
  }

  @media (any-hover: hover) and (any-pointer: fine) {
    .message-actions :global(button:hover) {
      background: var(--surface-var-container-hover);
      color: var(--surface-var-on-container);
    }

    .message-actions :global(.message-action-button.destructive:hover) {
      background: var(--crit-container);
      color: var(--crit-on-container);
    }
  }
</style>
