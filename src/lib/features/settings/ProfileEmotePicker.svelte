<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { PackImageView } from '#src/generated/protocol';
  import { i18n } from '#lib/i18n.js';
  import EmoteBoard from '#lib/ui/primitives/EmoteBoard.svelte';
  import ResponsivePopover from '#lib/ui/primitives/ResponsivePopover.svelte';

  interface Props {
    open?: boolean;
    label: string;
    unicodeOnly?: boolean;
    onPick?: (image: PackImageView) => void;
    onPickUnicode: (emoji: string) => void;
    onCloseAutoFocus?: (event: Event) => void;
    footer?: Snippet;
    trigger: Snippet<[{ props: Record<string, unknown> }]>;
  }

  let {
    open = $bindable(false),
    label,
    unicodeOnly = false,
    onPick,
    onPickUnicode,
    onCloseAutoFocus,
    trigger,
    footer,
  }: Props = $props();
</script>

<ResponsivePopover
  bind:open
  class="profile-emote-picker"
  {label}
  closeLabel={i18n.t('common.close')}
  {onCloseAutoFocus}
  {trigger}
>
  {#snippet children(sheet)}
    <EmoteBoard
      roomId=""
      variant={sheet ? 'sheet' : 'popover'}
      unicode
      {unicodeOnly}
      stickers={false}
      onPick={(image, _usage, keepOpen) => {
        onPick?.(image);
        open = keepOpen;
      }}
      onPickUnicode={(emoji, keepOpen) => {
        onPickUnicode(emoji);
        open = keepOpen;
      }}
    />
    {#if footer}<div class="picker-footer">{@render footer()}</div>{/if}
  {/snippet}
</ResponsivePopover>

<style>
  .picker-footer {
    border-top: var(--border-width) solid var(--surface-container-line);
    padding: var(--space-100) var(--space-200);
  }

  :global(.responsive-popover.profile-emote-picker) {
    background: var(--surface-container);
    border: var(--border-width) solid var(--surface-container-line);
    border-radius: var(--radius);
    color: var(--surface-on-container);
    overflow: hidden;
    width: auto;
  }
</style>
