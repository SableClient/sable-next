<script lang="ts">
  import type { SearchHitView } from '#src/generated/protocol';

  import { i18n } from '#lib/i18n.js';
  import { formatFullTimestamp } from '#lib/ui/date-time.js';

  import MessagePreview from '../room/messages/MessagePreview.svelte';
  import { opensFrom } from '../room/messages/message-preview';
  import { markTerms } from './mark-terms';
  import SearchContextLine from './SearchContextLine.svelte';
  import SearchHitFallback from './SearchHitFallback.svelte';
  import type { SenderDirectory } from './sender-directory.svelte.js';

  interface Props {
    hit: SearchHitView;
    terms: string[];
    senders: SenderDirectory;
    userId: string | null;
    roomLabel: string;
    onOpen: () => void;
    onKeydown: (event: KeyboardEvent) => void;
  }

  let { hit, terms, senders, userId, roomLabel, onOpen, onKeydown }: Props = $props();

  let openLabel = $derived(
    i18n.t('search.openResultFrom', {
      sender: senders.identity(hit.sender).displayName,
      room: roomLabel,
      time: formatFullTimestamp(hit.origin_server_ts),
    })
  );
</script>

<li class="hit">
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <div
    class="hit-row"
    role="group"
    tabindex="-1"
    aria-label={openLabel}
    onclick={(event) => {
      if (opensFrom(event)) onOpen();
    }}
    onkeydown={onKeydown}
  >
    {#each hit.context_before as line, index (`${index}:${line.event_id}`)}
      <SearchContextLine {line} sender={senders.identity(line.sender).displayName} />
    {/each}
    <div class="hit-message" {@attach markTerms(terms)}>
      <MessagePreview
        roomId={hit.room_id}
        eventId={hit.event_id}
        loadPreviewProfile
        timeAction={{
          label: openLabel,
          run: onOpen,
        }}
      >
        {#snippet fallback()}
          <SearchHitFallback {hit} {terms} {openLabel} {senders} {userId} {onOpen} />
        {/snippet}
      </MessagePreview>
    </div>
    {#each hit.context_after as line, index (`${index}:${line.event_id}`)}
      <SearchContextLine {line} sender={senders.identity(line.sender).displayName} />
    {/each}
  </div>
</li>

<style>
  .hit {
    background: var(--surface-container);
    border-radius: var(--radius-inner);
    padding: var(--space-100) var(--space-200) var(--space-200) var(--space-600);
  }

  .hit:is(:hover, :focus-within) {
    background: var(--surface-container-hover);
    box-shadow: inset 0 0 0 var(--border-width) var(--surface-container-line);
  }

  :global(.search-view.panel) .hit {
    padding-inline-start: var(--space-500);
  }

  .hit-row {
    cursor: pointer;
    display: flex;
    flex-direction: column;
    min-width: 0;
    padding-block: var(--space-100);
  }

  .hit-row:focus-visible {
    outline: none;
  }

  .hit:has(.hit-row:focus-visible) {
    outline: var(--focus-ring-width) solid var(--focus-ring);
    outline-offset: calc(-1 * var(--focus-ring-width));
  }

  .hit :global(.message.mention-silent),
  .hit :global(.message.mention-loud) {
    margin-inline-start: calc(-1 * (var(--space-400) + var(--border-width) * 4));
    padding-inline-start: var(--space-400);
  }

  :global(::highlight(search-match)) {
    background: var(--primary-container);
    color: var(--primary-on-container);
  }

  .hit-message {
    container-type: inline-size;
  }

  @container (width < 30rem) {
    .hit-message :global(.sender-identity-pronouns) {
      display: none;
    }
  }
</style>
