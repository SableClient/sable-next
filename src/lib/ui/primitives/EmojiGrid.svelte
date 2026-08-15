<script lang="ts">
  import { i18n } from '$lib/i18n';
  import { searchReactionEmoji, shortcodeFor } from '$lib/emoji/emoji';
  import { readRecentReactions, rememberReaction } from '$lib/emoji/recents';

  import './emoji-grid.css';

  interface Props {
    onPick: (emoji: string) => void;
    /** Reset the query and reload recents when a host popover reopens. */
    revision?: number;
  }

  let { onPick, revision = 0 }: Props = $props();
  let query = $state('');
  let recent = $derived.by(() => {
    void revision;
    return readRecentReactions();
  });
  let results = $derived(searchReactionEmoji(query));
  let highlighted = $derived(results[0]?.emoji ?? null);

  $effect(() => {
    void revision;
    query = '';
  });

  function pick(emoji: string): void {
    rememberReaction(emoji);
    onPick(emoji);
  }

  function onKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Enter' || !highlighted) return;
    event.preventDefault();
    pick(highlighted);
  }
</script>

<div class="emoji-grid">
  <input
    class="emoji-search"
    type="text"
    role="combobox"
    aria-expanded="true"
    aria-controls="emoji-grid-results"
    aria-label={$i18n.t('timeline.searchEmoji')}
    placeholder={$i18n.t('timeline.searchEmoji')}
    bind:value={query}
    onkeydown={onKeydown}
  />

  {#if query.trim() === ''}
    <p class="emoji-label">{$i18n.t('timeline.frequentlyUsed')}</p>
    <div class="emoji-cells" role="listbox" aria-label={$i18n.t('timeline.frequentlyUsed')}>
      {#each recent as emoji (emoji)}
        <button
          class="emoji-cell"
          type="button"
          role="option"
          aria-selected="false"
          aria-label={shortcodeFor(emoji) ?? emoji}
          onclick={() => {
            pick(emoji);
          }}>{emoji}</button
        >
      {/each}
    </div>
  {:else}
    <p class="emoji-label">{$i18n.t('timeline.emojiMatching', { query })}</p>
    <div
      class="emoji-cells"
      id="emoji-grid-results"
      role="listbox"
      aria-label={$i18n.t('timeline.emojiResults')}
    >
      {#each results as entry (entry.emoji)}
        <button
          class="emoji-cell"
          type="button"
          role="option"
          aria-selected={entry.emoji === highlighted}
          aria-label={entry.shortcode}
          onclick={() => {
            pick(entry.emoji);
          }}>{entry.emoji}</button
        >
      {/each}
    </div>
    {#if results.length === 0}
      <p class="emoji-empty">{$i18n.t('timeline.noEmoji')}</p>
    {/if}
  {/if}

  {#if highlighted}
    <p class="emoji-foot">
      <em>{highlighted}</em>
      <span>:{shortcodeFor(highlighted) ?? ''}:</span>
      <kbd>↵</kbd>
      {$i18n.t('timeline.toReact')}
    </p>
  {/if}
</div>
