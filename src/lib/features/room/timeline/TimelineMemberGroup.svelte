<script lang="ts">
  import type { Snippet } from 'svelte';
  import { cubicOut } from 'svelte/easing';
  import { slide } from 'svelte/transition';
  import CaretDownIcon from 'phosphor-svelte/lib/CaretDownIcon';

  import type { MemberView, TimelineItemView } from '#src/generated/protocol';

  import { currentLocale, i18n } from '#lib/i18n.js';
  import { motionMs, MOTION_MS } from '#lib/ui/motion.js';
  import ResponsiveDialog from '#lib/ui/primitives/ResponsiveDialog.svelte';

  import { memberGroupSegments, memberGroupSummary } from '../members/member-groups';
  import MemberUserList from '../members/MemberUserList.svelte';
  import StateEventSubjectName from '../members/StateEventSubjectName.svelte';

  interface Props {
    items: readonly TimelineItemView[];
    renderItem: Snippet<[TimelineItemView]>;
    members?: readonly MemberView[];
    onSenderProfile?: (userId: string, anchor: HTMLElement) => void;
  }

  let { items, renderItem, members = [], onSenderProfile }: Props = $props();
  const eventsId = $props.id();
  let expanded = $state(false);
  let toggleLabel = $derived(
    $i18n.t(`timeline.memberGroup.${expanded ? 'hideEvents' : 'showEvents'}`, {
      count: items.length,
    })
  );
  let segments = $derived(memberGroupSegments(items));
  let tokens = $derived(memberGroupSummary(segments, $i18n.t, currentLocale()));
  let open = $state(false);
  let openSegment = $state(0);
  let listed = $derived(segments.at(openSegment));
  let title = $derived(
    listed
      ? $i18n.t(`timeline.memberGroup.heading.${listed.category}`)
      : $i18n.t('timeline.members')
  );
</script>

{#snippet list(desktop: boolean)}
  <div class="member-group-dialog" class:sheet={!desktop}>
    <h2>{title}</h2>
    <MemberUserList
      {title}
      userIds={listed?.users.map((user) => user.userId) ?? []}
      {members}
      onMemberProfile={onSenderProfile}
      showHeader={false}
    />
  </div>
{/snippet}

<p class="member-group">
  <button
    class="state-icon expand-events"
    type="button"
    aria-label={toggleLabel}
    title={toggleLabel}
    aria-expanded={expanded}
    aria-controls={eventsId}
    onclick={() => {
      expanded = !expanded;
    }}
  >
    <CaretDownIcon aria-hidden="true" />
  </button>
  <span
    >{#each tokens as token, index (index)}{#if token.kind === 'text'}{token.text}{:else if token.kind === 'user'}{#if onSenderProfile}<StateEventSubjectName
            userId={token.userId}
            name={token.name}
            onProfile={onSenderProfile}
          />{:else}{token.name}{/if}{:else}<button
          class="others"
          type="button"
          onclick={() => {
            openSegment = token.segment;
            open = true;
          }}>{$i18n.t('timeline.memberGroup.others', { count: token.count })}</button
        >{/if}{/each}</span
  >
</p>

<div id={eventsId} inert={!expanded}>
  {#if expanded}
    <div
      class="member-group-events"
      transition:slide={{ duration: motionMs(MOTION_MS.fast), easing: cubicOut }}
    >
      {#each items as item (item.id)}
        {@render renderItem(item)}
      {/each}
    </div>
  {/if}
</div>

{#if open}
  <ResponsiveDialog
    bind:open
    label={title}
    closeLabel={$i18n.t('timeline.closeMembers')}
    children={list}
  />
{/if}

<style>
  .member-group {
    align-items: center;
    color: var(--surface-var-on-container);
    display: flex;
    font-size: var(--font-size-body);
    gap: var(--timeline-row-gap);
    line-height: var(--line-height-body);
    margin: 0;
    opacity: var(--opacity-p300);
  }

  .state-icon {
    align-items: center;
    display: flex;
    flex: 0 0 var(--avatar-size-small);
    justify-content: center;
  }

  .state-icon :global(svg) {
    height: var(--icon-size-small);
    width: var(--icon-size-small);
  }

  .expand-events {
    background: none;
    border: 0;
    color: inherit;
    cursor: pointer;
    min-height: var(--space-600);
    padding: 0;
  }

  .expand-events[aria-expanded='false'] :global(svg) {
    transform: rotate(-90deg);
  }

  @media (prefers-reduced-motion: no-preference) {
    .expand-events :global(svg) {
      transition: transform var(--duration-fast) var(--ease-smooth-out);
    }
  }

  .expand-events:is(:hover, :focus-visible) {
    background: var(--surface-var-container-hover);
    border-radius: var(--radii-200);
  }

  .expand-events:focus-visible {
    outline: var(--focus-ring-width) solid var(--focus-ring);
    outline-offset: var(--space-050);
  }

  .member-group-events {
    display: grid;
    gap: var(--space-100);
    margin-block-start: var(--space-100);
  }

  .others {
    background: none;
    border: 0;
    color: inherit;
    cursor: pointer;
    font: inherit;
    font-weight: var(--font-weight-bold);
    padding: 0;
  }

  .others:is(:hover, :focus-visible) {
    text-decoration: underline;
    text-underline-offset: 2px;
  }

  .member-group-dialog {
    display: grid;
    gap: var(--space-300);
    width: min(22rem, calc(100vw - 2rem));
  }

  .member-group-dialog.sheet {
    padding: 0 var(--space-400);
    width: auto;
  }

  h2 {
    font-size: var(--font-size-heading);
    margin: 0;
  }
</style>
