<script lang="ts">
  import type { SearchContextView, SearchHitView, SearchOrder } from '#src/generated/protocol';
  import { onDestroy, onMount, untrack } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import WarningIcon from 'phosphor-svelte/lib/WarningIcon';
  import XIcon from 'phosphor-svelte/lib/XIcon';

  import { useCoreClient } from '#lib/core/context.js';
  import { i18n } from '#lib/i18n.js';
  import { splitDisplayNamePronouns, withDisplayNamePronouns } from '#lib/personas/pronouns.js';
  import { profileOverrides } from '#lib/profile/profile-overrides.svelte.js';
  import { roomSectionPath } from '#lib/rooms/permalink.js';
  import { useRoomList } from '#lib/rooms/room-list.svelte.js';
  import { preferences } from '#lib/settings/preferences.svelte.js';
  import Alert from '#lib/ui/primitives/Alert.svelte';
  import AppPageShell from '#lib/ui/primitives/AppPageShell.svelte';
  import Button from '#lib/ui/primitives/Button.svelte';
  import Select from '#lib/ui/primitives/Select.svelte';
  import { BREAKPOINTS } from '#lib/ui/breakpoints.js';
  import { createMediaQuery } from '#lib/ui/media-query.svelte.js';
  import { whenVisible } from '#lib/ui/when-visible.js';
  import '#lib/ui/primitives/form-control.css';

  import { formatFullTimestamp, formatMessageTimestamp } from '#lib/ui/date-time.js';
  import Avatar from '#lib/ui/primitives/Avatar.svelte';
  import { MESSAGE_SEARCH_FIELD_ID, MessageSearch } from './message-search.svelte.js';
  import { clearRecentSearches, recentSearches, rememberSearch } from './recent-searches.svelte.js';
  import {
    resolveDirectRooms,
    resolveRoomTarget,
    resolveSpaceRooms,
    resolveSpaceTarget,
    resolveUserTarget,
    suggestRoomTarget,
    suggestUserTarget,
    type TargetSuggestion,
  } from './resolve-targets';
  import { coverageMessage } from './coverage';
  import { snippetAround } from './highlight';
  import { markTerms } from './mark-terms';
  import MessagePreview from '../room/messages/MessagePreview.svelte';
  import { opensFrom } from '../room/messages/message-preview';
  import SenderName from '../room/members/SenderName.svelte';
  import { senderDisplayColors } from '../room/members/members';
  import ComposerAutocomplete from '../composer/ComposerAutocomplete.svelte';
  import type { Suggestion } from '../composer/autocomplete';
  import { applySuggestion, enterAccepts, suggestionsFor } from './search-suggestions';
  import type { SearchToken } from './search-query';
  import { chipText, composeQuery, splitTokenField } from './token-field';
  import { SenderDirectory, type SenderIdentity } from './sender-directory.svelte.js';

  interface Props {
    panel?: boolean;
    initialQuery?: string;
  }

  let { panel = false, initialQuery = '' }: Props = $props();
  const core = useCoreClient();
  const roomList = useRoomList();
  const senders = new SenderDirectory(core);

  const search = new MessageSearch(core, () => ({
    roomId: (value) => resolveRoomTarget(roomList.rooms, value),
    userId: (value) => resolveUserTarget(knownSenders(), value),
    usersMatching: (pattern) =>
      knownSenders()
        .filter((sender) => pattern.test(sender.userId) || pattern.test(sender.displayName))
        .map((sender) => sender.userId),
    spaceRooms: (value) => resolveSpaceRooms(roomList.rooms, value),
    directRooms: (value) =>
      resolveDirectRooms(roomList.rooms, resolveUserTarget(knownSenders(), value) ?? value),
  }));

  const LOOKUP_DELAY_MS = 300;
  const PEOPLE_OPERATORS: readonly string[] = ['from', 'mentions', 'with'];
  const STARTER_OPERATORS: readonly string[] = ['from', 'in', 'has', 'before', 'is'];
  let lookupTimer: ReturnType<typeof setTimeout> | undefined;
  let destroyed = false;

  search.query = untrack(() => (panel ? initialQuery : (page.url.searchParams.get('q') ?? '')));
  search.order = untrack(() => (panel ? 'rank' : orderFrom(page.url.searchParams.get('order'))));
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
  const compact = createMediaQuery(`(width < ${BREAKPOINTS.compactContent})`);
  const listboxId = $props.id();
  const optionId = (index: number): string => `${listboxId}-${String(index)}`;

  let showOperatorList = $state(false);

  let spaces = $derived(roomList.rooms.filter((room) => room.is_space && room.state === 'joined'));

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
          { id: CLEAR_RECENT, label: $i18n.t('search.clearRecent'), insert: '' },
        ]
      : suggestionsOpen
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
  let suggestionHighlighted = $derived(showingRecent || enterAccepts(search.query, navigated));
  let input = $state<HTMLInputElement>();
  let results = $state<HTMLElement>();

  let terms = $derived([...search.parsed.text.split(/\s+/), ...search.parsed.phrases]);

  onMount(() => void core.refreshSearchCoverage());

  let coverage = $derived(
    coverageMessage(core.searchCoverage, core.searchCoverageUnavailable, (key, options) =>
      $i18n.t(key, options)
    )
  );

  let countLabel = $derived(
    $i18n.t(search.exhausted ? 'search.count' : 'search.countMore', { count: search.hits.length })
  );

  let showCoverage = $derived(coverage !== '' && core.searchCoverage?.state !== 'complete');

  let emptyLabel = $derived(
    search.older
      ? $i18n.t('search.emptyRecent')
      : showCoverage
        ? $i18n.t('search.emptyIndexing')
        : $i18n.t('search.empty')
  );

  let status = $derived.by(() => {
    if (!search.runnable) return '';
    if (search.failed) return '';
    if (search.searching && (search.hits.length === 0 || search.refining))
      return $i18n.t('search.searching');
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
        $i18n.t('search.recoveryFilter', {
          filters: tokens.map((token) => `${token.operator}:${token.value}`).join(', '),
        })
      );
    if (phrases.length > 0) hints.push($i18n.t('search.recoveryPhrase'));
    if (exclude.length > 0) hints.push($i18n.t('search.recoveryExclude'));
    if (wordCount > 1) hints.push($i18n.t('search.recoveryTerms'));
    return hints;
  });

  function orderFrom(value: string | null): SearchOrder {
    return value === 'recent' || value === 'oldest' ? value : 'rank';
  }

  function knownSenders(): SenderIdentity[] {
    const fromRooms = roomList.rooms
      .map((room) => room.latest_event?.sender)
      .filter((userId): userId is string => userId != null);
    const userIds = [...senders.known().map((identity) => identity.userId), ...fromRooms];

    return userIds
      .filter((userId, index) => userIds.indexOf(userId) === index)
      .map((userId) => senders.identity(userId));
  }

  function suggestionFor(token: SearchToken): TargetSuggestion | undefined {
    switch (token.operator) {
      case 'in':
        return suggestRoomTarget(roomList.rooms, token.value);
      case 'space':
        return suggestRoomTarget(roomList.rooms, token.value, true);
      case 'from':
      case 'mentions':
      case 'with':
        return suggestUserTarget(knownSenders(), token.value);
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
      const roomId = resolveRoomTarget(roomList.rooms, chip.value);
      return roomId === undefined ? chip.value : roomList.labelFor(roomId);
    }
    if (chip.operator === 'space') {
      const spaceId = resolveSpaceTarget(roomList.rooms, chip.value);
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
    if (event.target !== event.currentTarget || event.isComposing) return;

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
      navigated = true;
      activeSuggestion = (activeSuggestion + 1) % suggestions.length;
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      navigated = true;
      activeSuggestion = (activeSuggestion - 1 + suggestions.length) % suggestions.length;
    } else if (event.key === 'Tab') {
      if (field.draft.trim() === '' && !navigated) return;
      event.preventDefault();
      accept(suggestions[activeSuggestion]);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      if (showingRecent || enterAccepts(search.query, navigated)) {
        accept(suggestions[activeSuggestion]);
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

    const position = Math.max(0, Math.min(draft.length, caret + draft.length - typed.length));
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
      .filter((token) => PEOPLE_OPERATORS.includes(token.operator))
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
    if (search.order !== 'rank') parts.push(`order=${search.order}`);
    const space = page.url.searchParams.get('space');
    if (space !== null) parts.push(`space=${encodeURIComponent(space)}`);

    const encoded = parts.join('&');
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
    await goto(roomSectionPath(roomList.rooms, hit.room_id, hit.event_id));
  }

  let orders = $derived<{ value: SearchOrder; label: string }[]>([
    { value: 'rank', label: $i18n.t('search.orderRank') },
    { value: 'recent', label: $i18n.t('search.orderRecent') },
    { value: 'oldest', label: $i18n.t('search.orderOldest') },
  ]);
</script>

{#snippet loadMore()}
  {#if !search.exhausted}
    <div class="load-more">
      {#key search.pages}
        <div
          class="load-sentinel"
          aria-hidden="true"
          {@attach whenVisible(() => void search.loadMore())}
        ></div>
      {/key}
      <Button
        variant="ghost"
        size="small"
        disabled={search.searching}
        onclick={() => void search.loadMore()}
      >
        {search.searching
          ? $i18n.t('search.searching')
          : search.older
            ? $i18n.t('search.loadOlder')
            : $i18n.t('search.loadMore')}
      </Button>
    </div>
  {/if}
{/snippet}

{#snippet contextLine(line: SearchContextView)}
  <span class="hit-context" hidden={line.body.startsWith('mxc://')}>
    <span class="hit-context-sender">{senders.identity(line.sender).displayName}</span>
    {line.body}
  </span>
{/snippet}

{#if panel}
  {@render content()}
{:else}
  <AppPageShell title={$i18n.t('search.title')} density="compact">
    {@render content()}
  </AppPageShell>
{/if}

{#snippet content()}
  <div class="search-view" class:panel>
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
            <ul class="chips" aria-label={$i18n.t('search.activeFilters')}>
              {#each field.chips as chip (chip.start)}
                <li class="chip" class:negated={chip.negated} class:unresolved={isUnresolved(chip)}>
                  {#if isUnresolved(chip)}<WarningIcon />{/if}
                  <span class="chip-operator">{chip.negated ? '-' : ''}{chip.operator}:</span>
                  <span class="chip-value">{chipLabel(chip)}</span>
                  {#if isUnresolved(chip)}
                    <span class="visually-hidden">{$i18n.t('search.chipUnresolved')}</span>
                  {/if}
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
              ? `${listboxId}-${String(activeSuggestion)}`
              : undefined}
            placeholder={field.chips.length > 0
              ? ''
              : $i18n.t(compact.matches ? 'search.placeholderShort' : 'search.placeholder')}
            aria-label={$i18n.t('search.title')}
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
        {#if search.query !== ''}
          <button
            class="query-clear"
            type="button"
            aria-label={$i18n.t('search.clear')}
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
                ? $i18n.t('search.recentSearches')
                : $i18n.t('search.suggestions')}
              {suggestions}
              active={suggestionHighlighted ? activeSuggestion : -1}
              onSelect={accept}
            />
          </div>
        {/if}
      </div>
      <Select
        class="order-select"
        items={orders}
        value={search.order}
        aria-label={$i18n.t('search.order')}
        onValueChange={(next: string) => {
          chooseOrder(orderFrom(next));
        }}
      />
    </div>

    {#if search.parsed.unsupported.length > 0}
      <p class="notice">
        {$i18n.t('search.unsupported', { operators: search.parsed.unsupported.join(', ') })}
      </p>
    {/if}

    <p class="announcement" role="status" aria-live="polite">{status}</p>

    <div
      class="results"
      class:refining={search.refining && search.hits.length > 0}
      aria-busy={search.refining}
      bind:this={results}
    >
      {#if !search.runnable}
        <div class="starter">
          <p class="hint">{$i18n.t('search.hint')}</p>
          <ul class="starter-filters" aria-label={$i18n.t('search.startFilter')}>
            {#each STARTER_OPERATORS as operator (operator)}
              <li>
                <button
                  class="starter-filter"
                  type="button"
                  onclick={() => {
                    startFilter(operator);
                  }}
                >
                  {operator}:
                </button>
              </li>
            {/each}
            <li>
              <button class="starter-filter more" type="button" onclick={showAllFilters}>
                {$i18n.t('search.allFilters')}
              </button>
            </li>
          </ul>
          <p class="hint">{$i18n.t('search.hintExample')}</p>
          <p class="hint">{$i18n.t('search.hintSyntax')}</p>
        </div>
      {:else if search.failed}
        <Alert variant="critical" role="alert">
          <p>{$i18n.t('search.failed')}</p>
          <div class="alert-actions">
            <Button size="small" onclick={() => search.schedule()}>{$i18n.t('search.retry')}</Button
            >
          </div>
        </Alert>
      {:else if search.searching && search.hits.length === 0}
        <p class="hint">{$i18n.t('search.searching')}</p>
      {:else if search.hits.length === 0}
        <div class="empty">
          {#if search.unresolved.length > 0}
            <p>
              {$i18n.t('search.unresolved', {
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
                {$i18n.t('search.didYouMean', { label: suggestion.label })}
              </Button>
            {/each}
          {:else}
            <p>{emptyLabel}</p>
            {#if coverage}
              <p class="coverage">{coverage}</p>
            {/if}
            {#if search.older}
              {@render loadMore()}
            {/if}
          {/if}
          <ul>
            {#each recoveries as recovery (recovery)}
              <li>{recovery}</li>
            {/each}
          </ul>
        </div>
      {:else}
        <p class="count">
          {countLabel}{#if showCoverage}<span class="count-coverage">{coverage}</span>{/if}
        </p>
        {#each search.groups as group (group.key)}
          {@const room = roomList.byId(group.roomId)}
          {@const label = roomList.labelFor(group.roomId)}
          <section class="group">
            <h2 class:visually-hidden={panel && search.groups.length === 1}>
              <Avatar id={group.roomId} src={room?.avatar_url ?? null} name={label} size="small" />
              <span class="group-name">{label}</span>
              <span class="group-count">{group.hits.length}</span>
            </h2>
            <ul class="hit-list">
              {#each group.hits as hit (hit.event_id)}
                {@const snippet = snippetAround(hit.body, terms)}
                {@const openLabel = $i18n.t('search.openResultFrom', {
                  sender: senders.identity(hit.sender).displayName,
                  room: roomList.labelFor(hit.room_id),
                  time: formatFullTimestamp(hit.origin_server_ts),
                })}
                <li class="hit">
                  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
                  <div
                    class="hit-row"
                    role="group"
                    tabindex="-1"
                    aria-label={openLabel}
                    onclick={(event) => {
                      if (opensFrom(event)) void openHit(hit);
                    }}
                    onkeydown={(event) => {
                      onHitKeydown(event, hit);
                    }}
                  >
                    {#each hit.context_before as line, index (`${index}:${line.event_id}`)}
                      {@render contextLine(line)}
                    {/each}
                    <div class="hit-message" {@attach markTerms(terms)}>
                      <MessagePreview
                        roomId={hit.room_id}
                        eventId={hit.event_id}
                        loadPreviewProfile
                        timeAction={{
                          label: openLabel,
                          run: () => void openHit(hit),
                        }}
                      >
                        {#snippet fallback()}
                          {@const sender = senders.identity(hit.sender)}
                          {@const profile = senders.profile(hit.sender)}
                          {@const name = profileOverrides.name(hit.sender, sender.displayName)}
                          {@const parsedName =
                            preferences.showPronouns && preferences.showPronounPills
                              ? splitDisplayNamePronouns(name)
                              : { name, pronouns: [] }}
                          <span class="hit-fallback">
                            <Avatar
                              id={hit.sender}
                              src={profileOverrides.avatar(hit.sender, sender.avatarUrl)}
                              {name}
                              size="small"
                            />
                            <span class="hit-text">
                              <span class="hit-meta">
                                <SenderName
                                  displayName={parsedName.name}
                                  colors={senderDisplayColors(
                                    hit.sender,
                                    profile,
                                    null,
                                    hit.sender === userId
                                  )}
                                  pronouns={preferences.showPronouns && preferences.showPronounPills
                                    ? withDisplayNamePronouns(
                                        profile?.pronouns ?? [],
                                        parsedName.pronouns
                                      )
                                    : []}
                                />
                                <button
                                  class="hit-time-action"
                                  type="button"
                                  aria-label={openLabel}
                                  onclick={() => void openHit(hit)}
                                >
                                  <time
                                    datetime={new Date(hit.origin_server_ts).toISOString()}
                                    title={formatFullTimestamp(hit.origin_server_ts)}
                                  >
                                    {formatMessageTimestamp(hit.origin_server_ts)}
                                  </time>
                                </button>
                              </span>
                              <span class="hit-body">
                                {#if snippet.clippedStart}…{/if}
                                {#each snippet.segments as segment, index (index)}
                                  {#if segment.match}<mark>{segment.text}</mark
                                    >{:else}{segment.text}{/if}
                                {/each}
                                {#if snippet.clippedEnd}…{/if}
                              </span>
                            </span>
                          </span>
                        {/snippet}
                      </MessagePreview>
                    </div>
                    {#each hit.context_after as line, index (`${index}:${line.event_id}`)}
                      {@render contextLine(line)}
                    {/each}
                  </div>
                </li>
              {/each}
            </ul>
          </section>
        {/each}

        {@render loadMore()}
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

  .chip {
    align-items: center;
    background: var(--sec-container);
    border: var(--border-width) solid var(--sec-container-line);
    border-radius: var(--radius-pill);
    color: var(--sec-on-container);
    display: inline-flex;
    font-size: var(--font-size-small);
    gap: var(--space-050);
    max-width: 100%;
    min-width: 0;
    padding-inline: var(--space-200) var(--space-050);
  }

  .chip.negated {
    background: var(--crit-container);
    border-color: var(--crit-container-line);
    color: var(--crit-on-container);
  }

  .chip.unresolved {
    background: var(--warn-container);
    border-color: var(--warn-container-line);
    border-style: dashed;
    color: var(--warn-on-container);
  }

  .visually-hidden {
    block-size: 1px;
    clip-path: inset(50%);
    inline-size: 1px;
    overflow: hidden;
    position: absolute;
    white-space: nowrap;
  }

  .chip-operator {
    flex: 0 0 auto;
    opacity: 0.75;
  }

  .chip.unresolved .chip-operator {
    opacity: 1;
  }

  .chip-value {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .chip-remove {
    --target: 1.25rem;

    align-items: center;
    background: none;
    border: 0;
    border-radius: var(--radius-pill);
    color: inherit;
    cursor: pointer;
    display: flex;
    flex: 0 0 auto;
    font-size: inherit;
    height: var(--target);
    justify-content: center;
    padding: 0;
    position: relative;
    width: var(--target);
  }

  .chip-remove::after {
    border-radius: inherit;
    content: '';
    inset: calc((var(--target) - var(--target-hit)) / 2);
    position: absolute;
  }

  .chip-remove:hover,
  .chip-remove:focus-visible {
    background: var(--sec-container-hover);
  }

  .chip.negated .chip-remove:hover,
  .chip.negated .chip-remove:focus-visible {
    background: var(--crit-container-hover);
  }

  .chip.unresolved .chip-remove:hover,
  .chip.unresolved .chip-remove:focus-visible {
    background: var(--warn-container-hover);
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
    padding-left: var(--space-500);
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

  @media (prefers-reduced-motion: reduce) {
    .results {
      transition: none;
    }
  }

  @media (pointer: coarse) {
    .starter-filter {
      min-block-size: var(--target-hit);
    }
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
    color: var(--surface-var-on-container);
    font-size: var(--font-size-small);
    margin: 0;
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

  .starter {
    display: flex;
    flex-direction: column;
    gap: var(--space-300);
  }

  .starter-filters {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-150);
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .starter-filter {
    background: var(--surface-container);
    border: var(--border-width) solid var(--surface-container-line);
    border-radius: var(--radius-pill);
    color: var(--surface-on-container);
    cursor: pointer;
    font: inherit;
    font-size: var(--font-size-small);
    min-block-size: var(--control-height-300);
    padding-inline: var(--space-300);
  }

  .starter-filter.more {
    background: none;
    border-style: dashed;
    color: var(--surface-var-on-container);
  }

  .starter-filter:focus-visible {
    outline: var(--focus-ring-width) solid var(--focus-ring);
    outline-offset: var(--focus-ring-offset);
  }

  @media (any-hover: hover) and (any-pointer: fine) {
    .starter-filter:hover {
      background: var(--surface-container-hover);
    }
  }

  .alert-actions {
    display: flex;
  }

  .load-more {
    align-items: flex-start;
    display: flex;
    flex-direction: column;
  }

  .load-sentinel {
    block-size: 1px;
    inline-size: 100%;
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

  .hit {
    background: var(--surface-container);
    border-radius: var(--radius-inner);
    padding: var(--space-100) var(--space-200) var(--space-200) var(--space-600);
  }

  .hit:is(:hover, :focus-within) {
    background: var(--surface-container-hover);
    box-shadow: inset 0 0 0 var(--border-width) var(--surface-container-line);
  }

  .search-view.panel .hit {
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

  .hit-message {
    container-type: inline-size;
  }

  @container (width < 30rem) {
    .hit-message :global(.sender-identity-pronouns) {
      display: none;
    }
  }

  .hit-context {
    color: var(--surface-var-on-container);
    display: none;
    font-size: var(--font-size-small);
    opacity: 0.75;
    overflow: hidden;
    padding-inline-start: calc(var(--avatar-size-small) + var(--space-300));
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  @media (width >= 48rem) {
    .hit-context:not([hidden]) {
      display: block;
    }
  }

  .hit-context-sender {
    font-weight: var(--font-weight-medium);
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
