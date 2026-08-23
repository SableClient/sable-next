<script lang="ts">
  import type { SearchHitView } from '#src/generated/SearchHitView';
  import type { SearchOrder } from '#src/generated/SearchOrder';
  import { onDestroy } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import XIcon from 'phosphor-svelte/lib/XIcon';

  import { useCoreClient } from '#lib/core/context.js';
  import { i18n } from '#lib/i18n.js';
  import { roomSectionPath } from '#lib/rooms/permalink.js';
  import { useRoomList } from '#lib/rooms/room-list.svelte.js';
  import AppPageShell from '#lib/ui/primitives/AppPageShell.svelte';
  import Button from '#lib/ui/primitives/Button.svelte';
  import '#lib/ui/primitives/form-control.css';

  import { formatDate, formatTime, initials, senderColor } from '../room/timeline-format';
  import Avatar from '#lib/ui/primitives/Avatar.svelte';
  import { MessageSearch } from './message-search.svelte.js';
  import { resolveRoomTarget, resolveUserTarget } from './resolve-targets';
  import { snippetAround } from './highlight';
  import ComposerAutocomplete from '../composer/ComposerAutocomplete.svelte';
  import type { Suggestion } from '../composer/autocomplete';
  import { applySuggestion, suggestionsFor } from './search-suggestions';
  import type { SearchToken } from './search-query';
  import { chipText, composeQuery, splitTokenField } from './token-field';
  import { SenderDirectory, type SenderIdentity } from './sender-directory.svelte.js';

  const core = useCoreClient();
  const roomList = useRoomList();
  const senders = new SenderDirectory(core);

  const search = new MessageSearch(core, () => ({
    roomId: (value) => resolveRoomTarget(roomList.rooms, value),
    userId: (value) => resolveUserTarget(knownSenders(), value),
  }));

  search.query = page.url.searchParams.get('q') ?? '';
  search.order = page.url.searchParams.get('order') === 'recent' ? 'recent' : 'rank';
  if (search.query !== '') search.schedule();

  onDestroy(() => {
    search.dispose();
  });

  let suggestionsOpen = $state(false);
  let activeSuggestion = $state(0);
  const listboxId = $props.id();
  const optionId = (index: number): string => `${listboxId}-${String(index)}`;

  let showOperatorList = $state(false);

  let suggestions = $derived(
    suggestionsOpen
      ? suggestionsFor(
          search.query,
          {
            rooms: roomList.rooms.map((room) => ({
              id: room.room_id,
              alias: room.canonical_alias,
              name: room.name,
              avatarUrl: room.avatar_url,
            })),
            senders: knownSenders(),
          },
          showOperatorList
        )
      : []
  );
  let field = $derived(splitTokenField(search.query, search.parsed));
  let input = $state<HTMLInputElement>();

  let terms = $derived([...search.parsed.text.split(/\s+/), ...search.parsed.phrases]);

  let status = $derived.by(() => {
    if (!search.runnable) return '';
    if (search.failed) return $i18n.t('search.failed');
    if (search.searching && search.hits.length === 0) return $i18n.t('search.searching');
    if (search.hits.length === 0) return $i18n.t('search.empty');
    return $i18n.t('search.count', { count: search.hits.length });
  });

  let recoveries = $derived.by(() => {
    const hints: string[] = [];
    const { tokens, phrases, exclude } = search.parsed;

    if (tokens.length > 0)
      hints.push(
        $i18n.t('search.recoveryFilter', {
          filters: tokens.map((token) => `${token.operator}:${token.value}`).join(', '),
        })
      );
    if (phrases.length > 0) hints.push($i18n.t('search.recoveryPhrase'));
    if (exclude.length > 0) hints.push($i18n.t('search.recoveryExclude'));
    hints.push($i18n.t('search.recoveryTerms'));
    return hints;
  });

  function knownSenders(): SenderIdentity[] {
    const fromRooms = roomList.rooms
      .map((room) => room.latest_event?.sender)
      .filter((userId): userId is string => userId != null);
    const userIds = [...senders.known().map((identity) => identity.userId), ...fromRooms];

    return userIds
      .filter((userId, index) => userIds.indexOf(userId) === index)
      .map((userId) => senders.identity(userId));
  }

  function accept(suggestion: Suggestion): void {
    search.query = applySuggestion(search.query, suggestion);
    suggestionsOpen = false;
    activeSuggestion = 0;
    runSearch();
  }

  function chipLabel(chip: SearchToken): string {
    if (chip.operator !== 'in') return chip.value;
    const roomId = resolveRoomTarget(roomList.rooms, chip.value);
    return roomId === undefined ? chip.value : roomName(roomId);
  }

  function dropChip(chip: SearchToken): void {
    const kept = field.chips
      .filter((entry) => entry.start !== chip.start)
      .map((entry) => chipText(search.query, entry));

    search.query = composeQuery(kept, field.draft);
    suggestionsOpen = false;
    input?.focus();
    runSearch();
  }

  function onKeydown(event: KeyboardEvent): void {
    if (event.isComposing) return;
    if (event.key === 'Backspace' && field.draft === '' && field.chips.length > 0) {
      event.preventDefault();
      dropChip(field.chips[field.chips.length - 1]);
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      if (suggestions.length > 0) suggestionsOpen = false;
      else if (search.query !== '') {
        search.query = '';
        runSearch();
      }
      return;
    }
    if (event.altKey && event.key === 'ArrowDown') {
      event.preventDefault();
      showOperatorList = true;
      suggestionsOpen = true;
      return;
    }
    if (event.key === 'Home' || event.key === 'End') {
      suggestionsOpen = false;
      return;
    }
    if (suggestions.length === 0) return;

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      activeSuggestion = (activeSuggestion + 1) % suggestions.length;
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      activeSuggestion = (activeSuggestion - 1 + suggestions.length) % suggestions.length;
    } else if (event.key === 'Enter' || event.key === 'Tab') {
      event.preventDefault();
      accept(suggestions[activeSuggestion]);
    }
  }

  function roomName(roomId: string): string {
    const room = roomList.rooms.find((entry) => entry.room_id === roomId);
    return room?.name ?? room?.canonical_alias ?? roomId;
  }

  function onInput(event: Event & { currentTarget: HTMLInputElement }): void {
    const element = event.currentTarget;
    const typed = element.value;
    const caret = element.selectionStart ?? typed.length;

    const chips = field.chips.map((chip) => chipText(search.query, chip));
    search.query = composeQuery(chips, typed);
    reconcileDraft(element, typed, caret);

    suggestionsOpen = true;
    showOperatorList = false;
    activeSuggestion = 0;
    runSearch();
  }

  function reconcileDraft(element: HTMLInputElement, typed: string, caret: number): void {
    const { draft } = field;
    if (element.value === draft) return;

    const position = Math.max(0, Math.min(draft.length, caret + draft.length - typed.length));
    element.value = draft;
    element.setSelectionRange(position, position);
  }

  function runSearch(): void {
    search.schedule();
    syncUrl();
  }

  function syncUrl(): void {
    const parts: string[] = [];
    if (search.query !== '') parts.push(`q=${encodeURIComponent(search.query)}`);
    if (search.order !== 'rank') parts.push(`order=${search.order}`);

    const encoded = parts.join('&');
    void goto(encoded === '' ? page.url.pathname : `${page.url.pathname}?${encoded}`, {
      replaceState: true,
      shallow: true,
    });
  }

  function chooseOrder(order: SearchOrder): void {
    search.setOrder(order);
    syncUrl();
  }

  async function openHit(hit: SearchHitView): Promise<void> {
    await goto(roomSectionPath(roomList.rooms, hit.room_id, hit.event_id));
  }

  const orders: { value: SearchOrder; label: string }[] = [
    { value: 'rank', label: $i18n.t('search.orderRank') },
    { value: 'recent', label: $i18n.t('search.orderRecent') },
  ];
</script>

<AppPageShell title={$i18n.t('search.title')} density="compact">
  <div class="search-view">
    <div class="orders" role="group" aria-label={$i18n.t('search.order')}>
      {#each orders as option (option.value)}
        <Button
          variant={search.order === option.value ? 'primary' : 'ghost'}
          size="small"
          aria-pressed={search.order === option.value}
          onclick={() => {
            chooseOrder(option.value);
          }}
        >
          {option.label}
        </Button>
      {/each}
    </div>

    <div class="field">
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div
        class="form-control token-field"
        onmousedown={(event) => {
          if (event.target !== event.currentTarget) return;
          event.preventDefault();
          input?.focus();
        }}
      >
        {#if field.chips.length > 0}
          <ul class="chips" aria-label={$i18n.t('search.activeFilters')}>
            {#each field.chips as chip (chip.start)}
              <li class="chip" class:negated={chip.negated}>
                <span class="chip-operator">{chip.negated ? '-' : ''}{chip.operator}:</span>
                <span class="chip-value">{chipLabel(chip)}</span>
                <button
                  class="chip-remove"
                  type="button"
                  aria-label={$i18n.t('search.removeFilter', {
                    filter: `${chip.negated ? '-' : ''}${chip.operator}:${chipLabel(chip)}`,
                  })}
                  onclick={() => {
                    dropChip(chip);
                  }}
                >
                  <XIcon />
                </button>
              </li>
            {/each}
          </ul>
        {/if}

        <input
          bind:this={input}
          class="token-input"
          value={field.draft}
          type="text"
          autocomplete="off"
          spellcheck="false"
          enterkeyhint="search"
          role="combobox"
          aria-expanded={suggestions.length > 0}
          aria-controls={listboxId}
          aria-autocomplete="list"
          aria-activedescendant={suggestions.length > 0
            ? `${listboxId}-${String(activeSuggestion)}`
            : undefined}
          placeholder={field.chips.length > 0 ? '' : $i18n.t('search.placeholder')}
          aria-label={$i18n.t('search.placeholder')}
          oninput={onInput}
          onkeydown={onKeydown}
          onfocus={() => {
            suggestionsOpen = true;
          }}
          onblur={() => {
            suggestionsOpen = false;
            showOperatorList = false;
          }}
        />
      </div>

      {#if suggestions.length > 0}
        <div class="search-autocomplete">
          <ComposerAutocomplete
            id={listboxId}
            {optionId}
            sigil=""
            heading={$i18n.t('search.suggestions')}
            {suggestions}
            active={activeSuggestion}
            onSelect={accept}
          />
        </div>
      {/if}
    </div>

    {#if search.parsed.unsupported.length > 0}
      <p class="notice">
        {$i18n.t('search.unsupported', { operators: search.parsed.unsupported.join(', ') })}
      </p>
    {/if}

    {#if search.unresolved.length > 0}
      <p class="notice">
        {$i18n.t('search.unresolved', {
          targets: search.unresolved.map((token) => `${token.operator}:${token.value}`).join(', '),
        })}
      </p>
    {/if}

    <p class="announcement" role="status" aria-live="polite">{status}</p>

    <div class="results">
      {#if !search.runnable}
        <p class="hint">{$i18n.t('search.hint')}</p>
      {:else if search.failed}
        <p class="hint">{$i18n.t('search.failed')}</p>
      {:else if search.searching && search.hits.length === 0}
        <p class="hint">{$i18n.t('search.searching')}</p>
      {:else if search.hits.length === 0}
        <div class="empty">
          <p>{$i18n.t('search.empty')}</p>
          <ul>
            {#each recoveries as recovery (recovery)}
              <li>{recovery}</li>
            {/each}
          </ul>
        </div>
      {:else}
        <p class="count">{$i18n.t('search.count', { count: search.hits.length })}</p>
        {#each search.groups as group (group.key)}
          <section class="group">
            <h2>{roomName(group.roomId)}</h2>
            <ul class="hit-list">
              {#each group.hits as hit (hit.event_id)}
                {@const snippet = snippetAround(hit.body, terms)}
                <li>
                  <button class="hit-row" type="button" onclick={() => void openHit(hit)}>
                    <Avatar
                      src={senders.identity(hit.sender).avatarUrl}
                      initials={initials(senders.identity(hit.sender).displayName)}
                      color={senderColor(hit.sender)}
                      size="small"
                    />
                    <span class="hit-text">
                      <span class="hit-meta">
                        <span class="hit-sender">{senders.identity(hit.sender).displayName}</span>
                        <time datetime={new Date(hit.origin_server_ts).toISOString()}>
                          {formatDate(hit.origin_server_ts)}
                          {formatTime(hit.origin_server_ts)}
                        </time>
                      </span>
                      <span class="hit-body">
                        {#if snippet.clippedStart}…{/if}
                        {#each snippet.segments as segment, index (index)}
                          {#if segment.match}<mark>{segment.text}</mark>{:else}{segment.text}{/if}
                        {/each}
                        {#if snippet.clippedEnd}…{/if}
                      </span>
                    </span>
                  </button>
                </li>
              {/each}
            </ul>
          </section>
        {/each}

        {#if !search.exhausted}
          <Button
            variant="ghost"
            size="small"
            disabled={search.searching}
            onclick={() => void search.loadMore()}
          >
            {search.searching ? $i18n.t('search.searching') : $i18n.t('search.loadMore')}
          </Button>
        {/if}
      {/if}
    </div>
  </div>
</AppPageShell>

<style>
  .search-view {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .field {
    position: relative;
  }

  .token-field {
    align-items: center;
    cursor: text;
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-tight);
    width: 100%;
  }

  .token-field:focus-within {
    border-color: var(--sable-primary-main);
    box-shadow: 0 0 0 var(--focus-ring-width) var(--sable-focus-ring);
  }

  .token-input {
    background: none;
    border: 0;
    color: inherit;
    flex: 1 1 8rem;
    font: inherit;
    min-width: 0;
    outline: none;
    padding: 0;
  }

  .chips {
    display: contents;
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .chip {
    align-items: center;
    background: var(--sable-sec-container);
    border: var(--border-width) solid var(--sable-sec-container-line);
    border-radius: var(--radius-pill);
    color: var(--sable-sec-on-container);
    display: inline-flex;
    font-size: var(--font-size-small);
    gap: 0.125rem;
    max-width: 100%;
    min-width: 0;
    padding-inline: 0.5rem 0.125rem;
  }

  .chip.negated {
    background: var(--sable-crit-container);
    border-color: var(--sable-crit-container-line);
    color: var(--sable-crit-on-container);
  }

  .chip-operator {
    flex: 0 0 auto;
    opacity: 0.75;
  }

  .chip-value {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .chip-remove {
    align-items: center;
    background: none;
    border: 0;
    border-radius: var(--radius-pill);
    color: inherit;
    cursor: pointer;
    display: flex;
    flex: 0 0 auto;
    font-size: inherit;
    padding: 0.125rem;
  }

  .chip-remove:hover,
  .chip-remove:focus-visible {
    background: var(--sable-sec-container-hover);
  }

  .chip.negated .chip-remove:hover,
  .chip.negated .chip-remove:focus-visible {
    background: var(--sable-crit-container-hover);
  }

  .search-autocomplete :global(.autocomplete) {
    bottom: auto;
    top: calc(100% + 0.25rem);
  }

  .empty ul {
    color: var(--sable-surface-var-on-container);
    font-size: var(--font-size-small);
    margin: 0.25rem 0 0;
    padding-left: 1.25rem;
  }

  .empty p {
    margin: 0;
  }

  .announcement {
    block-size: 1px;
    clip-path: inset(50%);
    inline-size: 1px;
    margin: 0;
    overflow: hidden;
    position: absolute;
    white-space: nowrap;
  }

  .count {
    color: var(--sable-surface-var-on-container);
    font-size: var(--font-size-small);
    margin: 0;
  }

  .orders {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem;
  }

  .notice,
  .hint {
    color: var(--sable-surface-var-on-container);
    font-size: var(--font-size-small);
    margin: 0;
  }

  .results {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .group h2 {
    color: var(--sable-surface-var-on-container);
    font-size: var(--font-size-small);
    margin: 0 0 0.25rem;
  }

  .hit-list {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .hit-row {
    align-items: flex-start;
    background: none;
    border: none;
    border-radius: var(--radius);
    color: inherit;
    cursor: pointer;
    display: flex;
    font: inherit;
    gap: 0.5rem;
    padding: 0.5rem;
    text-align: left;
    width: 100%;
  }

  .hit-row:hover,
  .hit-row:focus-visible {
    background: var(--sable-surface-var-container);
  }

  .hit-text {
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
    min-width: 0;
  }

  .hit-meta {
    color: var(--sable-surface-var-on-container);
    display: flex;
    font-size: var(--font-size-small);
    gap: 0.375rem;
  }

  .hit-sender {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .hit-body {
    -webkit-box-orient: vertical;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    overflow: hidden;
  }
</style>
