<script lang="ts">
  import PaperclipIcon from 'phosphor-svelte/lib/PaperclipIcon';
  import { goto } from '$app/navigation';

  import { readDraft, writeDraft } from '#lib/features/composer/composer-drafts.svelte.js';
  import { stageFiles } from '#lib/features/composer/composer-files.js';
  import { i18n } from '#lib/i18n.js';
  import { roomSectionPath } from '#lib/rooms/permalink.js';
  import { useRoomList } from '#lib/rooms/room-list.svelte.js';
  import Alert from '#lib/ui/primitives/Alert.svelte';
  import DialogFrame from '#lib/ui/primitives/DialogFrame.svelte';
  import Spinner from '#lib/ui/primitives/Spinner.svelte';
  import RoomJumpList from '#lib/ui/shortcuts/RoomJumpList.svelte';

  import { appendPlainText } from './share-content.js';
  import type { ShareInbox } from './share-inbox.svelte.js';

  interface Props {
    inbox: ShareInbox;
  }

  let { inbox }: Props = $props();

  const roomList = useRoomList();
  let staging = $state(false);
  let failed = $state(false);

  async function shareTo(roomId: string): Promise<void> {
    if (staging) return;
    staging = true;
    failed = false;

    try {
      const files = await inbox.files();
      const text = inbox.text;
      const existing = readDraft(roomId);
      let nextStagedId = existing?.nextStagedId ?? 0;

      writeDraft(roomId, {
        doc: appendPlainText(existing?.doc, text),
        staged: stageFiles(existing?.staged ?? [], files, () => nextStagedId++),
        nextStagedId,
      });

      const path = roomSectionPath(roomList.rooms, roomId);
      await inbox.clear();
      await goto(path, { replaceState: true });
    } catch (error) {
      console.warn('[sable share-target] staging failed', error);
      failed = true;
    } finally {
      staging = false;
    }
  }

  function dismiss(): void {
    if (staging) return;
    void inbox.clear();
  }
</script>

<DialogFrame
  open={inbox.pending}
  onOpenChange={(open) => {
    if (!open) dismiss();
  }}
  variant="verification"
  label={$i18n.t('share.title')}
>
  <div class="share">
    <h2>{$i18n.t('share.title')}</h2>

    {#if inbox.text !== ''}
      <p class="preview">{inbox.text}</p>
    {/if}
    {#if inbox.fileCount > 0}
      <p class="files">
        <PaperclipIcon size={16} aria-hidden="true" />
        {$i18n.t('share.files', { count: inbox.fileCount })}
      </p>
    {/if}

    {#if failed}
      <Alert variant="critical" role="alert">{$i18n.t('share.failed')}</Alert>
    {/if}

    {#if staging}
      <p class="staging"><Spinner small /> {$i18n.t('share.staging')}</p>
    {:else}
      <RoomJumpList
        onSelect={(room) => {
          void shareTo(room.room_id);
        }}
        onClose={dismiss}
      />
    {/if}
  </div>
</DialogFrame>

<style>
  .share {
    display: grid;
    gap: var(--space-3);
    width: min(28rem, calc(100vw - 2rem));
  }

  h2 {
    font-size: var(--font-size-large);
    margin: 0;
  }

  .preview {
    background: var(--sable-surface-container);
    border-radius: var(--radii-300);
    color: var(--sable-surface-var-on-container);
    font-size: var(--font-size-small);
    margin: 0;
    max-height: 6rem;
    overflow: auto;
    overflow-wrap: anywhere;
    padding: var(--space-200) var(--space-300);
    white-space: pre-wrap;
  }

  .files,
  .staging {
    align-items: center;
    color: var(--sable-surface-var-on-container);
    display: flex;
    font-size: var(--font-size-small);
    gap: var(--space-200);
    margin: 0;
  }
</style>
