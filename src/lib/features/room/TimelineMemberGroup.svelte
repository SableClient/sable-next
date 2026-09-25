<script lang="ts">
  import UsersIcon from 'phosphor-svelte/lib/UsersIcon';

  import type { MemberView, TimelineItemView } from '#src/generated/protocol';

  import { currentLocale, i18n } from '#lib/i18n.js';
  import { BREAKPOINTS } from '#lib/ui/breakpoints.js';
  import { createMediaQuery } from '#lib/ui/media-query.svelte.js';
  import BottomSheet from '#lib/ui/primitives/BottomSheet.svelte';
  import DialogFrame from '#lib/ui/primitives/DialogFrame.svelte';

  import { memberGroupSegments, memberGroupSummary } from './member-groups';
  import MemberUserList from './MemberUserList.svelte';
  import StateEventSubjectName from './StateEventSubjectName.svelte';

  interface Props {
    items: readonly TimelineItemView[];
    members?: readonly MemberView[];
    onSenderProfile?: (userId: string, anchor: HTMLElement) => void;
  }

  let { items, members = [], onSenderProfile }: Props = $props();
  const appLayout = createMediaQuery(BREAKPOINTS.appLayout);
  let desktop = $derived(appLayout.matches);
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

{#snippet list()}
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
  <span class="state-icon" aria-hidden="true"><UsersIcon /></span>
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

{#if open}
  {#if desktop}
    <DialogFrame bind:open variant="verification" label={title}>
      {@render list()}
    </DialogFrame>
  {:else}
    <BottomSheet bind:open label={title} closeLabel={$i18n.t('timeline.closeMembers')}>
      {@render list()}
    </BottomSheet>
  {/if}
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
