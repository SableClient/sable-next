<script lang="ts">
  import type { SearchHitView } from '#src/generated/protocol';

  import { splitDisplayNamePronouns, withDisplayNamePronouns } from '#lib/personas/pronouns.js';
  import { preferences } from '#lib/settings/preferences.svelte.js';
  import { formatFullTimestamp, formatMessageTimestamp } from '#lib/ui/date-time.js';
  import Avatar from '#lib/ui/primitives/Avatar.svelte';
  import Tooltip from '#lib/ui/primitives/Tooltip.svelte';

  import SenderName from '../room/members/SenderName.svelte';
  import { senderDisplayColors } from '../room/members/members';
  import { snippetAround } from './highlight';
  import type { SenderDirectory } from './sender-directory.svelte.js';

  interface Props {
    hit: SearchHitView;
    terms: string[];
    openLabel: string;
    senders: SenderDirectory;
    userId: string | null;
    onOpen: () => void;
  }

  let { hit, terms, openLabel, senders, userId, onOpen }: Props = $props();

  let snippet = $derived(snippetAround(hit.body, terms));
  let fullTimestamp = $derived(formatFullTimestamp(hit.origin_server_ts));
  let sender = $derived(senders.identity(hit.sender));
  let profile = $derived(senders.profile(hit.sender));
  let name = $derived(sender.displayName);
  let parsedName = $derived(
    preferences.showPronouns && preferences.showPronounPills
      ? splitDisplayNamePronouns(name)
      : { name, pronouns: [] }
  );
</script>

<span class="hit-fallback">
  <Avatar id={hit.sender} src={sender.avatarUrl} {name} size="small" />
  <span class="hit-text">
    <span class="hit-meta">
      <SenderName
        displayName={parsedName.name}
        colors={senderDisplayColors(hit.sender, profile, null, hit.sender === userId)}
        pronouns={preferences.showPronouns && preferences.showPronounPills
          ? withDisplayNamePronouns(profile?.pronouns ?? [], parsedName.pronouns)
          : []}
      />
      <Tooltip label={fullTimestamp}>
        {#snippet trigger({ props })}
          <button
            {...props}
            class="hit-time-action"
            type="button"
            aria-label={openLabel}
            onclick={onOpen}
          >
            <time datetime={new Date(hit.origin_server_ts).toISOString()}>
              {formatMessageTimestamp(hit.origin_server_ts)}
            </time>
          </button>
        {/snippet}
      </Tooltip>
    </span>
    <span class="hit-body">
      {#if snippet.clippedStart}…{/if}
      {#each snippet.segments as segment, index (index)}
        {#if segment.match}<mark>{segment.text}</mark>{:else}{segment.text}{/if}
      {/each}
      {#if snippet.clippedEnd}…{/if}
    </span>
  </span>
</span>

<style>
  .hit-fallback {
    align-items: flex-start;
    display: flex;
    gap: var(--space-300);
  }

  .hit-text {
    display: flex;
    flex-direction: column;
    gap: var(--space-050);
    min-width: 0;
  }

  .hit-meta {
    color: var(--surface-var-on-container);
    display: flex;
    font-size: var(--font-size-small);
    gap: var(--space-200);
  }

  .hit-time-action {
    background: none;
    border: 0;
    color: inherit;
    cursor: pointer;
    flex: none;
    font: inherit;
    padding: 0;
    white-space: nowrap;
  }

  .hit-time-action:hover {
    text-decoration: underline;
  }

  .hit-body mark {
    background: var(--primary-container);
    border-radius: var(--radius-inner);
    color: var(--primary-on-container);
  }

  .hit-body {
    -webkit-box-orient: vertical;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    overflow: hidden;
  }
</style>
