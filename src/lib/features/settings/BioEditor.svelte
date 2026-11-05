<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import CodeIcon from 'phosphor-svelte/lib/CodeIcon';
  import LinkIcon from 'phosphor-svelte/lib/LinkIcon';
  import ListBulletsIcon from 'phosphor-svelte/lib/ListBulletsIcon';
  import QuotesIcon from 'phosphor-svelte/lib/QuotesIcon';
  import SmileyIcon from 'phosphor-svelte/lib/SmileyIcon';
  import TextBIcon from 'phosphor-svelte/lib/TextBIcon';
  import TextItalicIcon from 'phosphor-svelte/lib/TextItalicIcon';
  import TextStrikethroughIcon from 'phosphor-svelte/lib/TextStrikethroughIcon';

  import { useCoreClient } from '#lib/core/context.js';
  import { isPackChange } from '#lib/emoji/load-packs.js';
  import { i18n } from '#lib/i18n.js';
  import ComposerAutocomplete from '#lib/features/composer/ComposerAutocomplete.svelte';
  import ComposerLinkDialog from '#lib/features/composer/ComposerLinkDialog.svelte';
  import ComposerSpoilerDialog from '#lib/features/composer/ComposerSpoilerDialog.svelte';
  import { ComposerSources } from '#lib/features/composer/composer-sources.svelte.js';
  import type { AutocompleteQuery, Suggestion } from '#lib/features/composer/autocomplete.js';
  import { suggestionNode } from '#lib/features/composer/suggestion-node.js';
  import { suggestionsFor } from '#lib/features/composer/suggestions.js';
  import { rememberSuggestion } from '#lib/features/composer/suggestion-usage.js';
  import { ComposerEditor } from '#lib/features/composer/editor/composer-editor.js';
  import ComposerEditorView from '#lib/features/composer/editor/ComposerEditor.svelte';
  import type { FormatAction } from '#lib/features/composer/editor/formatting.js';
  import { composerSchema } from '#lib/features/composer/editor/schema.js';
  import { emoticonNode } from '#lib/features/composer/editor/shortcodes.js';
  import { serializeComposer, textDoc } from '#lib/features/composer/editor/serialize.js';
  import { cachedMediaUrl, holdMediaUrl, loadMediaUrl } from '#lib/ui/media-url.js';
  import IconButton from '#lib/ui/primitives/IconButton.svelte';
  import '#lib/ui/primitives/form-control.css';

  import type { BioContent } from './bio-content.js';
  import ProfileEmotePicker from './ProfileEmotePicker.svelte';

  interface Props {
    id: string;
    value: BioContent;
  }

  let { id, value = $bindable() }: Props = $props();
  const core = useCoreClient();
  const uid = $props.id();
  const listboxId = `bio-suggestions-${uid}`;
  const optionId = (index: number): string => `${listboxId}-${String(index)}`;
  const sources = new ComposerSources(core, {
    roomId: () => '',
    roomMembers: () => [],
    botCommandsEnabled: () => false,
  });
  let query = $state<AutocompleteQuery | null>(null);
  let dismissed = $state(false);
  let activeIndex = $state(0);
  let focused = $state(false);
  let showPlaceholder = $state(true);
  let boardOpen = $state(false);
  let linkOpen = $state(false);
  let spoilerOpen = $state(false);
  let mounted = $state(false);
  let synced: BioContent | undefined;
  let suggestions = $derived(suggestionsFor(query, [], sources.emotes, []));
  let active = $derived(Math.min(activeIndex, Math.max(0, suggestions.length - 1)));
  let panelOpen = $derived(focused && query !== null && !dismissed && !boardOpen);

  const editor = new ComposerEditor({
    id: untrack(() => id),
    richText: true,
    multiline: true,
    maxLength: 5000,
    media: {
      cached: (url) => cachedMediaUrl(core, url, 0, 0),
      load: (url) => loadMediaUrl(core, url, 0, 0),
      hold: (url) => holdMediaUrl(core, url, 0, 0),
    },
    emotes: () => sources.emotes,
    label: () => i18n.t('settings.biography'),
    listboxId,
    activeOptionId: () => (panelOpen && suggestions.length > 0 ? optionId(active) : null),
    editable: () => true,
    onSubmit: () => {},
    onChange: (change) => {
      showPlaceholder = change.placeholder;
      activeIndex = 0;
      if (!change.docChanged) return;
      const doc = editor.doc();
      if (!doc) return;
      const { body, formatted } = serializeComposer(doc);
      value = synced = { body, formatted };
    },
    onQuery: (next) => {
      const opening = query === null && next?.sigil === ':';
      query = next?.sigil === ':' ? next : null;
      dismissed = false;
      if (opening) void sources.loadEmotes();
    },
    onNavigate: (key) => {
      if (!panelOpen) return false;
      if (key === 'Escape') {
        dismissed = true;
        return true;
      }
      if (suggestions.length === 0) return false;
      if (key === 'ArrowDown') activeIndex = (active + 1) % suggestions.length;
      else if (key === 'ArrowUp')
        activeIndex = (active - 1 + suggestions.length) % suggestions.length;
      else commit(suggestions[active]);
      return true;
    },
    onFiles: () => {},
    onLinkRequest: () => {
      linkOpen = true;
    },
    onSpoilerRequest: () => {
      spoilerOpen = true;
    },
  });

  onMount(() => {
    mounted = true;
    return core.subscribeEvents((event) => {
      if (!isPackChange(event)) return;
      sources.forgetEmotes();
      if (query) void sources.loadEmotes();
    });
  });

  $effect(() => {
    const next = value;
    if (!mounted) return;
    untrack(() => {
      if (next.body === synced?.body && next.formatted === synced.formatted) return;
      synced = next;
      if (next.formatted !== null) editor.setHtml(next.formatted);
      else editor.setDoc(textDoc(next.body));
      editor.clearHistory();
    });
  });

  $effect(() => {
    editor.syncActiveOption();
  });

  function commit(suggestion: Suggestion): void {
    if (!query) return;
    rememberSuggestion(suggestion.id);
    editor.replaceQuery(query, suggestionNode(':', suggestion, sources.emotes));
  }

  const formats = [
    { id: 'bold', action: 'strong', icon: TextBIcon },
    { id: 'italic', action: 'em', icon: TextItalicIcon },
    { id: 'strike', action: 'strike', icon: TextStrikethroughIcon },
    { id: 'code', action: 'code', icon: CodeIcon },
    { id: 'link', action: 'link', icon: LinkIcon },
    { id: 'quote', action: 'blockquote', icon: QuotesIcon },
    { id: 'list', action: 'bullet_list', icon: ListBulletsIcon },
  ] satisfies { id: string; action: FormatAction; icon: typeof TextBIcon }[];
</script>

<div class="bio-toolbar" role="toolbar" aria-label={i18n.t('settings.bioFormatting')}>
  {#each formats as format (format.id)}
    <IconButton
      variant="ghost"
      size="small"
      label={i18n.t(`settings.bioFormat.${format.id}`)}
      onmousedown={(event) => event.preventDefault()}
      onclick={() => editor.format(format.action)}
    >
      <format.icon />
    </IconButton>
  {/each}
  <ProfileEmotePicker
    bind:open={boardOpen}
    label={i18n.t('composer.emotesHeading', { query: '' })}
    onPick={(image) => editor.insert(emoticonNode(image))}
    onPickUnicode={(emoji) => editor.insert(composerSchema.text(emoji))}
    onCloseAutoFocus={(event) => {
      event.preventDefault();
      editor.focus();
    }}
  >
    {#snippet trigger({ props })}
      <IconButton {...props} variant="ghost" size="small" label={i18n.t('composer.emoticons')}>
        <SmileyIcon />
      </IconButton>
    {/snippet}
  </ProfileEmotePicker>
</div>
<div
  class="bio-field"
  onfocusin={() => {
    focused = true;
  }}
  onfocusout={(event) => {
    if (
      !(event.relatedTarget instanceof Node) ||
      !event.currentTarget.contains(event.relatedTarget)
    )
      focused = false;
  }}
>
  <div class="form-control inline-edit bio-input">
    <ComposerEditorView {editor} {showPlaceholder} placeholder={i18n.t('settings.biographyHint')} />
  </div>
  {#if panelOpen && query}
    <ComposerAutocomplete
      id={listboxId}
      {optionId}
      heading={i18n.t('composer.emotesHeading', { query: query.query })}
      {suggestions}
      {active}
      onSelect={commit}
    />
  {/if}
</div>
<ComposerLinkDialog bind:open={linkOpen} onApply={(href) => editor.applyLink(href)} />
<ComposerSpoilerDialog bind:open={spoilerOpen} onApply={(reason) => editor.applySpoiler(reason)} />

<style>
  .bio-field {
    min-width: 0;
    position: relative;
  }

  .bio-input {
    padding: 0;
  }

  .bio-input :global([contenteditable]) {
    min-height: 4lh;
  }

  .bio-input:focus-within {
    --form-control-line: var(--primary-main);
    --form-control-ring: var(--border-width-600);
  }
</style>
