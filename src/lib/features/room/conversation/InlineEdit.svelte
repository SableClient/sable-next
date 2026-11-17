<script lang="ts">
  import { onDestroy, onMount, tick } from 'svelte';
  import type { Node as ProseMirrorNode } from 'prosemirror-model';

  import { formattedForEditing } from '#lib/composer/composer-context.js';
  import { useCoreClient } from '#lib/core/context.js';
  import { ComposerEditor } from '#lib/features/composer/editor/composer-editor.js';
  import ComposerEditorView from '#lib/features/composer/editor/ComposerEditor.svelte';
  import type { EmoteMedia } from '#lib/features/composer/editor/node-views.js';
  import {
    plainEditDoc,
    serializeComposer,
    serializePlain,
  } from '#lib/features/composer/editor/serialize.js';
  import { sendFailure } from '#lib/features/composer/send-failure.js';
  import { i18n } from '#lib/i18n.js';
  import { preferences } from '#lib/settings/preferences.svelte.js';
  import { cachedMediaUrl, holdMediaUrl, loadMediaUrl } from '#lib/ui/media-url.js';
  import Alert from '#lib/ui/primitives/Alert.svelte';
  import Button from '#lib/ui/primitives/Button.svelte';
  import { isEditableTarget } from '#lib/ui/shortcuts/binding.js';
  import { focusRegion } from '#lib/ui/shortcuts/focus-regions.js';

  import type { Conversation } from './conversation.svelte.js';

  interface Props {
    conversation: Conversation;
    roomId: string;
  }

  let { conversation, roomId }: Props = $props();

  const core = useCoreClient();
  const pending = $derived(conversation.context?.kind === 'edit' ? conversation.context : null);

  const media: EmoteMedia = {
    cached: (url) => cachedMediaUrl(core, url, 0, 0),
    load: (url) => loadMediaUrl(core, url, 0, 0),
    hold: (url) => holdMediaUrl(core, url, 0, 0),
  };

  let showPlaceholder = $state(false);
  let saving = $state(false);
  let error = $state<string | null>(null);
  let original: ProseMirrorNode | undefined;

  const editor = new ComposerEditor({
    media,
    emotes: () => [],
    label: () => i18n.t('composer.editing'),
    listboxId: 'inline-edit-suggestions',
    activeOptionId: () => null,
    editable: () => !saving,
    onSubmit: () => {
      void save();
    },
    onChange: (change) => {
      showPlaceholder = change.placeholder;
    },
    onQuery: () => {},
    onNavigate: (key) => {
      if (key !== 'Escape') return false;
      conversation.clearContext();
      return true;
    },
    onFiles: () => {},
    onLinkRequest: () => {},
    onSpoilerRequest: () => {},
    onSourceToggle: () => {},
  });

  onMount(() => {
    const edit = pending;
    if (!edit) return;

    const formatted = formattedForEditing(edit.html);
    if (formatted === null) editor.setLines(edit.body);
    else if (preferences.richTextComposer) editor.setHtml(formatted);
    else editor.setDoc(plainEditDoc(edit.body, formatted));
    original = editor.doc();

    const draft = conversation.takeInlineDraft(edit.eventId);
    if (draft) editor.setDoc(draft);
    editor.focus();
  });

  onDestroy(() => {
    const edit = pending;
    const doc = editor.doc();
    if (edit && doc) conversation.stashInlineDraft(edit.eventId, doc);
  });

  function reveal(node: HTMLElement): void {
    node.scrollIntoView({ block: 'nearest' });
  }

  async function cancel(): Promise<void> {
    const keyboardUp = isEditableTarget(document.activeElement);
    conversation.clearContext();
    if (!keyboardUp) return;
    await tick();
    focusRegion('composer');
  }

  async function save(): Promise<void> {
    const edit = pending;
    const doc = editor.doc();
    if (!edit || !doc || saving) return;

    const message = preferences.richTextComposer ? serializeComposer(doc) : serializePlain(doc);
    const untouched = original !== undefined && doc.eq(original);
    saving = true;
    error = null;
    try {
      await conversation.sendMessage(
        roomId,
        untouched ? edit.body : message.body,
        untouched ? (edit.html ?? null) : message.formatted,
        message.mentions
      );
    } catch (cause) {
      const failure = sendFailure(cause);
      error = i18n.t(failure.key, failure.values);
    } finally {
      saving = false;
    }
  }
</script>

<div class="inline-edit" {@attach reveal}>
  <ComposerEditorView
    {editor}
    placeholder={i18n.t('timeline.messagePlaceholder')}
    {showPlaceholder}
  />
  {#if error}
    <Alert variant="critical" role="alert">{error}</Alert>
  {/if}
  <div class="actions">
    <Button
      size="small"
      onmousedown={(event: MouseEvent) => {
        event.preventDefault();
      }}
      onclick={() => void cancel()}>{i18n.t('common.cancel')}</Button
    >
    <Button size="small" variant="primary" loading={saving} onclick={() => void save()}>
      {i18n.t('common.save')}
    </Button>
  </div>
</div>

<style>
  .inline-edit {
    background: var(--surface-container);
    border: var(--border-width) solid var(--surface-container-line);
    border-radius: var(--radius);
    display: grid;
    gap: var(--space-100);
    min-width: 0;
    padding: var(--space-100);
  }

  .actions {
    display: flex;
    gap: var(--space-100);
    justify-content: flex-end;
  }
</style>
