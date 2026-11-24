<script lang="ts">
  import { clamp } from '#lib/clamp.js';
  import { MediaQuery } from 'svelte/reactivity';
  import type { SearchHitView, SearchOrder } from '#src/generated/protocol';
  import { onDestroy, onMount, tick, untrack } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import XIcon from 'phosphor-svelte/lib/XIcon';

  import { useCoreClient } from '#lib/core/context.js';
  import { i18n } from '#lib/i18n.js';
  import { roomSectionPath } from '#lib/rooms/permalink.js';
  import { useRoomList } from '#lib/rooms/room-list.svelte.js';
  import AppPageShell from '#lib/ui/primitives/AppPageShell.svelte';
  import Button from '#lib/ui/primitives/Button.svelte';
  import Select from '#lib/ui/primitives/Select.svelte';
  import { BREAKPOINTS } from '#lib/ui/breakpoints.js';
  import { isComposingKey } from '#lib/ui/shortcuts/binding.js';
  import '#lib/ui/primitives/form-control.css';

  import Avatar from '#lib/ui/primitives/Avatar.svelte';
  import { MESSAGE_SEARCH_FIELD_ID, MessageSearch } from './message-search.svelte.js';
  import {
    clearRecentSearches,
    recentSearches,
    rememberSearch,
  } from '#lib/search/recent-searches.svelte.js';
  import {
    resolveRoomTarget,
    resolveSpaceTarget,
    searchRooms,
    suggestPersonTarget,
    suggestRoomTarget,
    type SearchPerson,
    type TargetSuggestion,
  } from './resolve-targets';
  import { coverageMessage } from './coverage';
  import ComposerAutocomplete from '../composer/ComposerAutocomplete.svelte';
  import type { Suggestion } from '../composer/autocomplete';
  import { applySuggestion, enterAccepts, suggestionsFor } from './search-suggestions';
  import type { SearchToken } from './search-query';
  import { chipText, composeQuery, splitTokenField } from './token-field';
  import SearchChip from './SearchChip.svelte';
  import SearchHitRow from './SearchHitRow.svelte';
  import SearchLoadMore from './SearchLoadMore.svelte';
  import SearchRetryAlert from './SearchRetryAlert.svelte';
  import SearchStarter from './SearchStarter.svelte';
  import { SenderDirectory, type SenderIdentity } from './sender-directory.svelte.js';

  interface Props {
    panel?: boolean;
    initialQuery?: string;
  }

  let { panel = false, initialQuery = '' }: Props = $props();
  const core = useCoreClient();
  const roomList = useRoomList();
  const senders = new SenderDirectory(core);

  let rooms = $derived(searchRooms(roomList.rooms));
  let knownSenders = $derived.by((): SenderIdentity[] => {
    const fromRooms = roomList.rooms
      .map((room) => room.latest_event?.sender)
      .filter((userId): userId is string => userId != null);
    const userIds = new Set([...senders.known().map((identity) => identity.userId), ...fromRooms]);
    return [...userIds].map((userId) => senders.identity(userId));
  });
  let people: SearchPerson[] = $derived(
    knownSenders.map((sender) => ({ user_id: sender.userId, display_name: sender.displayName }))
  );
  let directory = $derived({ rooms, people });
  const search = new MessageSearch(core, () => directory);

  const LOOKUP_DELAY_MS = 300;
  const PEOPLE_OPERATORS: ReadonlySet<string> = new Set(['from', 'mentions', 'with']);
  let lookupTimer: ReturnType<typeof setTimeout> | undefined;
  let destroyed = false;

  search.query = untrack(() => (panel ? initialQuery : (page.url.searchParams.get('q') ?? '')));
  search.order = untrack(() => (panel ? 'recent' : orderFrom(page.url.searchParams.get('order'))));
  if (search.query !== '') {
    search.schedule();
    scheduleLookup();
  }

  onDestroy(() => {
    destroyed = true;
    search.dispose();
    clearTimeout(lookupTimer);
  });

  let suggestionsOpen = $state(false);
  let activeSuggestion = $state(0);
  let navigated = $state(false);
  const compact = new MediaQuery(`(width < ${BREAKPOINTS.compactContent})`);
  const listboxId = $props.id();
  const optionId = (index: number): string => `${listboxId}-${String(index)}`;

  let showOperatorList = $state(false);

  let spaces = $derived(
    roomList.rooms.filter((room) => room.room_kind === 'space' && room.state === 'joined')
  );

  const CLEAR_RECENT = 'recent:clear';
  let userId = $derived(core.session?.user_id ?? null);
  let recent = $derived(userId === null ? [] : recentSearches(userId));
  let showingRecent = $derived(
    suggestionsOpen && !showOperatorList && search.query === '' && recent.length > 0
  );

  let field = $derived(splitTokenField(search.query, search.parsed));
  let suggestions = $derived(
    showingRecent
      ? [
          ...recent.map((query, index) => ({
            id: `recent:${String(index)}`,
            label: query,
            insert: `${query} `,
          })),
          { id: CLEAR_RECENT, label: i18n.t('search.clearRecent'), insert: '' },
        ]
      : suggestionsOpen
        ? suggestionsFor(
            search.query,
            {
              rooms: roomList.rooms.map((room) => ({
                id: room.room_id,
                alias: room.canonical_alias,
                name: room.display_name,
                avatarUrl: room.display_avatar_url,
              })),
              senders: knownSenders,
              spaces: spaces.map((space) => ({
                id: space.room_id,
                alias: space.canonical_alias,
                name: space.name,
                avatarUrl: space.avatar_url,
              })),
            },
            showOperatorList || field.draft.trim() === ''
          )
        : []
  );
  let active = $derived(Math.min(activeSuggestion, Math.max(0, suggestions.length - 1)));
  let suggestionHighlighted = $derived(showingRecent || enterAccepts(search.query, navigated));
  let input = $state<HTMLInputElement>();
  let results = $state<HTMLElement>();

  let phrases = $derived(search.parsed.phrases);

  onMount(() => {
    void core.refreshSearchCoverage().then(() => {
      if (!destroyed) search.updateCoverage(core.searchCoverage);
    });
    return core.subscribeEvents((event) => {
      if (event.type === 'search_coverage') search.updateCoverage(event.coverage);
    });
  });

  let coverage = $derived(
    coverageMessage(core.searchCoverage, core.searchCoverageUnavailable, (key, options) =>
      i18n.t(key, options)
    )
  );

  let countLabel = $derived(
    i18n.t(search.exhausted ? 'search.count' : 'search.countMore', { count: search.hits.length })
  );

  let showCoverage = $derived(coverage !== '' && core.searchCoverage?.state !== 'complete');

  let emptyLabel = $derived(showCoverage ? i18n.t('search.emptyIndexing') : i18n.t('search.empty'));

  let status = $derived.by(() => {
    if (!search.runnable) return '';
    if (search.failed) return '';
    if (search.searching && (search.hits.length === 0 || search.refining))
      return i18n.t('search.searching');
    if (search.hits.length === 0) return showCoverage ? `${emptyLabel} ${coverage}` : emptyLabel;
    return countLabel;
  });

  let unresolvedFixes = $derived(
    search.unresolved.flatMap((token) => {
      const suggestion = suggestionFor(token);
      return suggestion ? [{ token, suggestion }] : [];
    })
  );

  let recoveries = $derived.by(() => {
    const hints: string[] = [];
    const { tokens, phrases, exclude, text } = search.parsed;
    const wordCount = text.split(/\s+/).filter(Boolean).length + phrases.length;

    if (tokens.length > 0)
      hints.push(
        i18n.t('search.recoveryFilter', {
          filters: tokens.map((token) => `${token.operator}:${token.value}`).join(', '),
        })
      );
    if (phrases.length > 0) hints.push(i18n.t('search.recoveryPhrase'));
    if (exclude.length > 0) hints.push(i18n.t('search.recoveryExclude'));
    if (wordCount > 1) hints.push(i18n.t('search.recoveryTerms'));
    return hints;
  });

  function orderFrom(value: string | null): SearchOrder {
    return value === 'rank' || value === 'oldest' ? value : 'recent';
  }

  function suggestionFor(token: SearchToken): TargetSuggestion | undefined {
    switch (token.operator) {
      case 'in':
        return suggestRoomTarget(rooms, token.value);
      case 'space':
        return suggestRoomTarget(rooms, token.value, true);
      case 'from':
      case 'mentions':
      case 'with':
        return suggestPersonTarget(people, token.value);
      default:
        return undefined;
    }
  }

  function applyFix(token: SearchToken, suggestion: TargetSuggestion): void {
    const value = suggestion.value.includes(' ') ? `"${suggestion.value}"` : suggestion.value;
    const replacement = `${token.negated ? '-' : ''}${token.operator}:${value}`;
    search.query = `${search.query.slice(0, token.start)}${replacement}${search.query.slice(token.end)}`;
    runSearch();
    input?.focus();
  }

  function startFilter(operator: string): void {
    const base = search.query.replace(/\s*$/, ' ').trimStart();
    search.query = `${base}${operator}:`;
    activeSuggestion = 0;
    navigated = false;
    showOperatorList = false;
    suggestionsOpen = true;
    input?.focus();
  }

  function showAllFilters(): void {
    showOperatorList = true;
    suggestionsOpen = true;
    activeSuggestion = 0;
    input?.focus();
  }

  function accept(suggestion: Suggestion): void {
    if (suggestion.id === CLEAR_RECENT) {
      if (userId !== null) clearRecentSearches(userId);
      suggestionsOpen = false;
      return;
    }
    search.query = applySuggestion(search.query, suggestion);
    suggestionsOpen = suggestion.insert.endsWith(':');
    activeSuggestion = 0;
    navigated = false;
    runSearch();
  }

  function chipLabel(chip: SearchToken): string {
    if (chip.operator === 'in') {
      const roomId = resolveRoomTarget(rooms, chip.value);
      return roomId === undefined ? chip.value : roomList.labelFor(roomId);
    }
    if (chip.operator === 'space') {
      const spaceId = resolveSpaceTarget(rooms, chip.value);
      return spaceId === undefined ? chip.value : roomList.labelFor(spaceId);
    }
    return chip.value;
  }

  function isUnresolved(chip: SearchToken): boolean {
    return search.unresolved.some((token) => token.start === chip.start);
  }

  function hitRows(): HTMLElement[] {
    return Array.from(results?.querySelectorAll<HTMLElement>('.hit-row') ?? []);
  }

  function onHitKeydown(event: KeyboardEvent, hit: SearchHitView): void {
    if (event.target !== event.currentTarget || isComposingKey(event)) return;

    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      void openHit(hit);
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      input?.focus();
      return;
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;

    event.preventDefault();
    const rows = hitRows();
    const target =
      rows[rows.indexOf(event.currentTarget as HTMLElement) + (event.key === 'ArrowDown' ? 1 : -1)];
    if (target) target.focus();
    else if (event.key === 'ArrowUp') input?.focus();
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

  async function editChip(chip: SearchToken): Promise<void> {
    const token = chipText(search.query, chip);
    const kept = field.chips
      .filter((entry) => entry.start !== chip.start)
      .map((entry) => chipText(search.query, entry));
    const draft = [field.draft.trimEnd(), token].filter(Boolean).join(' ');
    search.query = composeQuery(kept, draft);
    activeSuggestion = 0;
    navigated = false;
    showOperatorList = false;
    runSearch();
    await tick();
    input?.focus();
    suggestionsOpen = true;
    input?.setSelectionRange(draft.length - token.length + token.indexOf(':') + 1, draft.length);
  }

  function onKeydown(event: KeyboardEvent): void {
    if (isComposingKey(event)) return;
    if (event.key === 'Backspace' && field.draft === '' && field.chips.length > 0) {
      event.preventDefault();
      void editChip(field.chips[field.chips.length - 1]);
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      if (suggestions.length > 0) suggestionsOpen = false;
      else clearQuery();
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
    if (suggestions.length === 0) {
      if (event.key === 'Enter') remember();
      else if (event.key === 'ArrowDown') {
        const first = hitRows()[0];
        if (first) {
          event.preventDefault();
          first.focus();
        }
      }
      return;
    }

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      activeSuggestion = suggestionHighlighted ? (active + 1) % suggestions.length : 0;
      navigated = true;
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      activeSuggestion = suggestionHighlighted
        ? (active - 1 + suggestions.length) % suggestions.length
        : suggestions.length - 1;
      navigated = true;
    } else if (event.key === 'Tab') {
      if (event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return;
      if (field.draft.trim() === '' && !navigated) return;
      event.preventDefault();
      accept(suggestions[active]);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      if (showingRecent || enterAccepts(search.query, navigated)) {
        accept(suggestions[active]);
        return;
      }
      suggestionsOpen = false;
      remember();
    }
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
    navigated = false;
    runSearch();
  }

  function reconcileDraft(element: HTMLInputElement, typed: string, caret: number): void {
    const { draft } = field;
    if (element.value === draft) return;

    const position = clamp(caret + draft.length - typed.length, 0, draft.length);
    element.value = draft;
    element.setSelectionRange(position, position);
  }

  function runSearch(): void {
    search.schedule();
    syncUrl();
    scheduleLookup();
  }

  function scheduleLookup(): void {
    clearTimeout(lookupTimer);
    lookupTimer = setTimeout(lookUpUnresolvedPeople, LOOKUP_DELAY_MS);
  }

  function lookUpUnresolvedPeople(): void {
    const terms = search.unresolved
      .filter((token) => PEOPLE_OPERATORS.has(token.operator))
      .map((token) => token.value);

    for (const term of terms) {
      void senders.lookup(term).then((found) => {
        if (found && !destroyed) search.schedule();
      });
    }
  }

  function clearQuery(): void {
    if (search.query === '') return;
    search.query = '';
    runSearch();
    input?.focus();
  }

  function syncUrl(): void {
    if (panel) return;
    const parts: string[] = [];
    if (search.query !== '') parts.push(`q=${encodeURIComponent(search.query)}`);
    if (search.order !== 'recent') parts.push(`order=${search.order}`);
    const space = page.url.searchParams.get('space');
    if (space !== null) parts.push(`space=${encodeURIComponent(space)}`);

    const encoded = parts.join('&');
    // eslint-disable-next-line svelte/no-navigation-without-resolve -- rewrites the query of the current, already resolved URL
    void goto(encoded === '' ? page.url.pathname : `${page.url.pathname}?${encoded}`, {
      replace: true,
      shallow: true,
    });
  }

  function chooseOrder(order: SearchOrder): void {
    search.setOrder(order);
    syncUrl();
  }

  function remember(): void {
    if (userId !== null && search.runnable) rememberSearch(userId, search.query);
  }

  async function openHit(hit: SearchHitView): Promise<void> {
    remember();
    // eslint-disable-next-line svelte/no-navigation-without-resolve -- roomSectionPath() resolves the route itself
    await goto(roomSectionPath(roomList.rooms, hit.room_id, hit.event_id));
  }

  let orders = $derived<{ value: SearchOrder; label: string }[]>([
    { value: 'rank', label: i18n.t('search.orderRank') },
    { value: 'recent', label: i18n.t('search.orderRecent') },
    { value: 'oldest', label: i18n.t('search.orderOldest') },
  ]);
</script>

{#if panel}
  {@render content()}
{:else}
  <AppPageShell title={i18n.t('common.searchMessages')} density="compact">
    {@render content()}
  </AppPageShell>
{/if}

{#snippet content()}
  <div class={['search-view', { panel }]}>
    <div class="search-bar">
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
            <ul class="chips" aria-label={i18n.t('search.activeFilters')}>
              {#each field.chips as chip (chip.start)}
                <SearchChip
                  {chip}
                  label={chipLabel(chip)}
                  unresolved={isUnresolved(chip)}
                  onEdit={() => void editChip(chip)}
                  onRemove={() => {
                    dropChip(chip);
                  }}
                />
              {/each}
            </ul>
          {/if}

          <input
            bind:this={input}
            {@attach (node) => {
              if (untrack(() => compact.current)) return;
              node.focus();
              suggestionsOpen = false;
            }}
            id={MESSAGE_SEARCH_FIELD_ID}
            class="token-input"
            value={field.draft}
            type="text"
            autocomplete="off"
            spellcheck="false"
            enterkeyhint="search"
            role="combobox"
            aria-expanded={suggestions.length > 0}
            aria-controls={suggestions.length > 0 ? listboxId : undefined}
            aria-autocomplete="list"
            aria-activedescendant={suggestions.length > 0 && suggestionHighlighted
              ? `${listboxId}-${String(active)}`
              : undefined}
            placeholder={field.chips.length > 0
              ? ''
              : i18n.t(compact.current ? 'common.searchMessages' : 'search.placeholder')}
            aria-label={i18n.t('common.searchMessages')}
            oninput={onInput}
            onkeydown={onKeydown}
            onfocus={() => {
              suggestionsOpen = true;
            }}
            onclick={() => {
              suggestionsOpen = true;
            }}
            onblur={() => {
              suggestionsOpen = false;
              showOperatorList = false;
            }}
          />
        </div>
        {#if search.query !== ''}
          <button
            class="query-clear"
            type="button"
            aria-label={i18n.t('search.clear')}
            onclick={clearQuery}
          >
            <XIcon />
          </button>
        {/if}

        {#if suggestions.length > 0}
          <div class="search-autocomplete">
            <ComposerAutocomplete
              id={listboxId}
              {optionId}
              heading={showingRecent
                ? i18n.t('search.recentSearches')
                : i18n.t('search.suggestions')}
              {suggestions}
              active={suggestionHighlighted ? active : -1}
              onSelect={accept}
            />
          </div>
        {/if}
      </div>
      <Select
        class="order-select"
        items={orders}
        value={search.order}
        aria-label={i18n.t('search.order')}
        onValueChange={(next: string) => {
          chooseOrder(orderFrom(next));
        }}
      />
    </div>

    {#if search.parsed.unsupported.length > 0}
      <p class="notice">
        {i18n.t('search.unsupported', { operators: search.parsed.unsupported.join(', ') })}
      </p>
    {/if}

    <p class="screen-reader-only" role="status" aria-live="polite">{status}</p>

    <div
      class={['results', { refining: search.refining && search.hits.length > 0 }]}
      aria-busy={search.refining}
      bind:this={results}
    >
      {#if !search.runnable}
        <SearchStarter onStart={startFilter} onShowAll={showAllFilters} />
      {:else if search.failed && search.hits.length === 0}
        <SearchRetryAlert message={i18n.t('search.failed')} onRetry={() => search.schedule()} />
      {:else if search.searching && search.hits.length === 0}
        <p class="hint">{i18n.t('search.searching')}</p>
      {:else if search.hits.length === 0}
        <div class="empty">
          {#if search.unresolved.length > 0}
            <p>
              {i18n.t('search.unresolved', {
                targets: search.unresolved
                  .map((token) => `${token.operator}:${token.value}`)
                  .join(', '),
              })}
            </p>
            {#each unresolvedFixes as { token, suggestion } (token.start)}
              <Button
                variant="ghost"
                size="small"
                onclick={() => {
                  applyFix(token, suggestion);
                }}
              >
                {i18n.t('search.didYouMean', { label: suggestion.label })}
              </Button>
            {/each}
          {:else}
            <p>{emptyLabel}</p>
            {#if coverage}
              <p class="coverage">{coverage}</p>
            {/if}
          {/if}
          <ul>
            {#each recoveries as recovery (recovery)}
              <li>{recovery}</li>
            {/each}
          </ul>
        </div>
      {:else}
        <div class="results-summary">
          <p class="count">
            {countLabel}{#if showCoverage}<span class="count-coverage">{coverage}</span>{/if}
          </p>
          {#if search.refreshAvailable}
            <Button
              size="small"
              variant="ghost"
              disabled={search.searching}
              onclick={() => search.refresh()}
            >
              {i18n.t('search.refreshResults')}
            </Button>
          {/if}
        </div>
        {#each search.groups as group (group.key)}
          {@const room = roomList.byId(group.roomId)}
          {@const label = roomList.labelFor(group.roomId)}
          <section class="group">
            <h2 class={{ 'screen-reader-only': panel && search.groups.length === 1 }}>
              <Avatar id={group.roomId} src={room?.avatar_url ?? null} name={label} size="small" />
              <span class="group-name">{label}</span>
              <span class="group-count">{group.hits.length}</span>
            </h2>
            <ul class="hit-list">
              {#each group.hits as hit (hit.event_id)}
                <SearchHitRow
                  {hit}
                  terms={[...hit.matched, ...phrases]}
                  {senders}
                  {userId}
                  roomLabel={label}
                  onOpen={() => void openHit(hit)}
                  onKeydown={(event) => {
                    onHitKeydown(event, hit);
                  }}
                />
              {/each}
            </ul>
          </section>
        {/each}

        <SearchLoadMore {search} />
      {/if}
    </div>
  </div>
{/snippet}

<style>
  .search-view {
    display: flex;
    flex-direction: column;
    gap: var(--space-300);
  }

  .field {
    --clear-size: 1.5rem;

    position: relative;
  }

  .token-field {
    align-items: center;
    cursor: text;
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-150);
    padding-inline-end: calc(var(--space-200) + var(--clear-size) + var(--space-100));
    width: 100%;
  }

  .token-field:focus-within {
    border-color: var(--primary-main);
    box-shadow: 0 0 0 var(--focus-ring-width) var(--focus-ring);
  }

  @media (width < 32rem) {
    .token-field {
      max-block-size: 7rem;
      overflow-y: auto;
    }
  }

  .token-input {
    background: none;
    border: 0;
    color: inherit;
    flex: 1 1 4rem;
    font: inherit;
    font-size: max(var(--font-size-label), var(--font-size-input-min));
    min-width: 0;
    outline: none;
    padding: 0;
  }

  .query-clear {
    --target: var(--clear-size);

    align-items: center;
    background: none;
    border: 0;
    border-radius: var(--radius-pill);
    color: var(--surface-var-on-container);
    cursor: pointer;
    display: flex;
    flex: 0 0 auto;
    height: var(--target);
    inset-block-start: 50%;
    inset-inline-end: var(--space-200);
    justify-content: center;
    padding: 0;
    position: absolute;
    transform: translateY(-50%);
    width: var(--target);
  }

  .query-clear::after {
    border-radius: inherit;
    content: '';
    inset: calc((var(--target) - var(--target-hit)) / 2);
    position: absolute;
  }

  @media (any-hover: hover) and (any-pointer: fine) {
    .query-clear:hover {
      background: var(--bg-container-hover);
    }
  }

  .query-clear:focus-visible {
    outline: var(--focus-ring-width) solid var(--focus-ring);
    outline-offset: var(--focus-ring-offset);
  }

  .chips {
    display: contents;
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .search-autocomplete :global(.autocomplete) {
    bottom: auto;
    top: calc(100% + 0.25rem);
  }

  .search-autocomplete :global(.menu-item) {
    --menu-item-height: var(--control-height-500);
    --menu-item-gap: var(--space-300);
  }

  .empty ul {
    color: var(--surface-var-on-container);
    font-size: var(--font-size-small);
    margin: var(--space-100) 0 0;
    padding-inline-start: var(--space-500);
  }

  .empty p {
    margin: 0;
  }

  .empty .coverage {
    margin-block-start: var(--space-100);
  }

  .results.refining {
    opacity: 0.55;
  }

  .count {
    color: var(--surface-var-on-container);
    font-size: var(--font-size-small);
    margin: 0;
  }

  .results-summary {
    align-items: center;
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-200);
    justify-content: space-between;
  }

  .search-bar {
    align-items: flex-start;
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-200);
  }

  .search-bar .field {
    flex: 1 1 12rem;
    min-width: 0;
  }

  .search-bar :global(.order-select) {
    flex: none;
    width: auto;
  }

  .count-coverage {
    display: block;
    margin-block-start: var(--space-050);
  }

  .notice,
  .hint {
    color: var(--surface-var-on-container);
    font-size: var(--font-size-small);
    margin: 0;
  }

  .results {
    display: flex;
    flex-direction: column;
    gap: var(--space-400);
    transition: opacity 150ms ease-out;
  }

  @media (prefers-reduced-motion: reduce) {
    .results {
      transition: none;
    }
  }

  .group h2 {
    align-items: center;
    display: flex;
    font-size: var(--font-size-small);
    font-weight: var(--font-weight-medium);
    gap: var(--space-200);
    margin: 0 0 var(--space-200);
    padding-inline: var(--space-100);
  }

  .group-name {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .group-count {
    color: var(--surface-var-on-container);
    font-variant-numeric: tabular-nums;
    font-weight: var(--font-weight-normal);
  }

  .hit-list {
    display: flex;
    flex-direction: column;
    gap: var(--space-200);
    list-style: none;
    margin: 0;
    padding: 0;
  }
</style>
