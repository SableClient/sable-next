<script lang="ts">
  import { cubicOut } from 'svelte/easing';
  import { scale } from 'svelte/transition';
  import type { MemberView } from '#src/generated/protocol';

  import { i18n } from '#lib/i18n.js';
  import { createMediaQuery } from '#lib/ui/media-query.svelte.js';
  import { MOTION_MS, motionMs, shouldReduceMotion } from '#lib/ui/motion.js';
  import Avatar from '#lib/ui/primitives/Avatar.svelte';
  import Tooltip from '#lib/ui/primitives/Tooltip.svelte';

  import { memberAvatar, memberName } from '../members/members.js';
  import ReadReceiptFace from './ReadReceiptFace.svelte';

  const MAX_FACES = 3;
  const HOVER_FALLOFF = 0.45;
  const HOVER_SCALE = 1.05;

  interface Props {
    readers: readonly string[];
    timestamps?: Readonly<Record<string, number>>;
    members: readonly MemberView[];
    expanded?: boolean;
    onOpen: (anchor: HTMLButtonElement) => void;
    onProfile?: (userId: string, anchor: HTMLElement) => void;
  }

  let { readers, timestamps = {}, members, expanded = false, onOpen, onProfile }: Props = $props();

  const coarse = createMediaQuery('(pointer: coarse)');
  let root = $state<HTMLElement | null>(null);
  let seen = $derived(
    readers.map((userId) => ({
      userId,
      name: memberName(members, userId),
      avatar: memberAvatar(members, userId),
    }))
  );
  let faces = $derived(seen.slice(0, MAX_FACES));
  let overflow = $derived(Math.max(0, readers.length - MAX_FACES));
  let names = $derived(seen.map((reader) => reader.name).join(', '));
  let overflowNames = $derived(
    seen
      .slice(MAX_FACES)
      .map((reader) => reader.name)
      .join(', ')
  );

  function setShifts(activeIdx: number | null): void {
    if (!root || shouldReduceMotion()) return;
    const avatars = [...root.querySelectorAll<HTMLElement>('.t-avatar')];

    avatars.forEach((el, i) => {
      if (activeIdx === null) {
        el.style.setProperty('--shift', '0');
        el.style.setProperty('--scale-active', '1');
        el.style.setProperty('--z', '0');
        return;
      }
      const d = Math.abs(i - activeIdx);
      el.style.setProperty(
        '--shift',
        `calc(-1 * var(--space-100) * ${(HOVER_FALLOFF ** d).toFixed(3)})`
      );
      el.style.setProperty('--scale-active', i === activeIdx ? String(HOVER_SCALE) : '1');
      el.style.setProperty('--z', String(avatars.length - d));
    });
  }
</script>

{#snippet faceRow(interactive: boolean)}
  {#each faces as reader, index (reader.userId)}
    <span
      class="face-slot"
      transition:scale={{ duration: motionMs(MOTION_MS.fast), start: 0.96, easing: cubicOut }}
    >
      {#if interactive}
        <ReadReceiptFace
          userId={reader.userId}
          name={reader.name}
          avatar={reader.avatar}
          timestamp={timestamps[reader.userId]}
          {onProfile}
          onHover={() => setShifts(index)}
        />
      {:else}
        <Avatar class="receipt-face" src={reader.avatar} name={reader.name} id={reader.userId} />
      {/if}
    </span>
  {/each}
{/snippet}

{#if readers.length > 0}
  {#if coarse.matches}
    <button
      class="read-receipt-stack chip selection-open"
      type="button"
      aria-label={$i18n.t('timeline.seenByNames', { names })}
      aria-haspopup="dialog"
      aria-expanded={expanded}
      onclick={(event) => onOpen(event.currentTarget)}
    >
      <span class="faces">
        {@render faceRow(false)}
        {#if overflow > 0}
          <span class="overflow">+{overflow}</span>
        {/if}
      </span>
    </button>
  {:else}
    <div
      class="read-receipt-stack faces"
      role="group"
      aria-label={$i18n.t('timeline.seenBy')}
      bind:this={root}
      onmouseleave={() => setShifts(null)}
    >
      {@render faceRow(true)}
      {#if overflow > 0}
        <Tooltip label={overflowNames} multiline>
          {#snippet trigger({ props })}
            <button
              {...props}
              class={['t-avatar', 'overflow', 'selection-open']}
              type="button"
              aria-label={$i18n.t('timeline.seenByNames', { names: overflowNames })}
              aria-haspopup="dialog"
              aria-expanded={expanded}
              onmouseenter={() => setShifts(faces.length)}
              onclick={(event) => onOpen(event.currentTarget)}
            >
              +{overflow}
            </button>
          {/snippet}
        </Tooltip>
      {/if}
    </div>
  {/if}
{/if}

<style>
  .read-receipt-stack {
    --stack-ring: var(--bg-container);

    align-items: center;
    display: inline-flex;
  }

  .chip {
    background: transparent;
    border: var(--border-width) solid transparent;
    border-radius: var(--radius-pill);
    color: var(--sec-main);
    cursor: pointer;
    font: inherit;
    height: var(--size-x300);
    max-width: 100%;
    padding: 0 var(--space-150);
    position: relative;
    white-space: nowrap;
  }

  .chip::after {
    content: '';
    inset: -0.25rem 0;
    position: absolute;
  }

  .chip:hover,
  .chip[aria-expanded='true'] {
    --stack-ring: var(--bg-container-hover);

    background: var(--bg-container-hover);
    border-color: var(--bg-container-line);
    color: var(--bg-on-container);
  }

  .chip:focus-visible {
    outline: var(--focus-ring-width) solid var(--focus-ring);
    outline-offset: 0.15rem;
  }

  .faces,
  .face-slot {
    align-items: center;
    display: inline-flex;
  }

  .faces {
    padding-left: var(--space-050);
  }

  .faces > :global(* + *) {
    margin-left: calc(-1 * var(--space-150));
  }

  :global(.read-receipt-stack .t-avatar) {
    transform: translateY(var(--shift, 0)) scale(var(--scale-active, 1));
    transform-origin: center;
    transition: transform var(--duration-medium) var(--ease-smooth-out);
    will-change: transform;
    z-index: var(--z, 0);
  }

  @media (prefers-reduced-motion: reduce) {
    :global(.read-receipt-stack .t-avatar) {
      transform: none;
      transition: none;
    }
  }

  :global(html[data-reduced-motion='on'] .read-receipt-stack .t-avatar) {
    transform: none;
    transition: none;
  }

  :global(.avatar-root.receipt-face) {
    --avatar-size: 1.125rem;

    background: var(--stack-ring);
    box-shadow: 0 0 0 0.125rem var(--stack-ring);
    font-size: var(--font-size-small);
  }

  .overflow {
    align-items: center;
    background: var(--surface-var-container);
    border: 0;
    border-radius: var(--radius-pill);
    box-shadow: 0 0 0 0.125rem var(--stack-ring);
    color: var(--surface-var-on-container);
    cursor: pointer;
    display: inline-flex;
    font: inherit;
    font-size: var(--font-size-small);
    font-variant-numeric: tabular-nums;
    height: 1.125rem;
    justify-content: center;
    line-height: 1;
    min-width: 1.125rem;
    padding: 0 var(--space-050);
    position: relative;
  }

  .chip .overflow {
    cursor: inherit;
  }

  button.overflow::after {
    border-radius: inherit;
    content: '';
    inset: -0.35rem 0;
    position: absolute;
  }

  button.overflow:hover {
    background: var(--bg-container-hover);
    color: var(--bg-on-container);
  }

  button.overflow:focus-visible {
    outline: var(--focus-ring-width) solid var(--focus-ring);
    outline-offset: 0.15rem;
  }
</style>
