<script lang="ts">
  import ReplyIcon from 'phosphor-svelte/lib/ArrowBendUpLeftIcon';
  import ThreadIcon from 'phosphor-svelte/lib/ChatCircleDotsIcon';
  import TrashIcon from 'phosphor-svelte/lib/TrashIcon';

  import type { EditVersionView } from '#src/generated/protocol';

  import { i18n } from '#lib/i18n.js';
  import { BREAKPOINTS } from '#lib/ui/breakpoints.js';
  import { createMediaQuery } from '#lib/ui/media-query.svelte.js';
  import BottomSheet from '#lib/ui/primitives/BottomSheet.svelte';
  import DialogFrame from '#lib/ui/primitives/DialogFrame.svelte';
  import IconButton from '#lib/ui/primitives/IconButton.svelte';

  import FormattedBody from './FormattedBody.svelte';
  import type { MatrixLink } from './matrix-link';
  import { formatMessageTimestamp } from './timeline-format';

  interface Props {
    open?: boolean;
    versions: readonly EditVersionView[];
    senderTimezone?: string | null;
    onMatrixLink?: (link: MatrixLink, anchor: HTMLAnchorElement) => void;
    onReply?: (version: EditVersionView) => void;
    onThread?: (version: EditVersionView) => void;
    onDelete?: (version: EditVersionView) => void;
  }

  let {
    open = $bindable(false),
    versions,
    senderTimezone = null,
    onMatrixLink,
    onReply,
    onThread,
    onDelete,
  }: Props = $props();
  const appLayout = createMediaQuery(BREAKPOINTS.appLayout);
  let desktop = $derived(appLayout.matches);

  function act(version: EditVersionView, action?: (version: EditVersionView) => void): void {
    open = false;
    action?.(version);
  }
</script>

{#snippet content()}
  <div class="edit-history" class:sheet={!desktop}>
    <h2>{$i18n.t('timeline.editHistoryTitle')}</h2>
    <ol class="edit-history-versions">
      {#each versions as version, index (version.event_id)}
        <li class="edit-history-version">
          <div class="edit-history-meta">
            <time datetime={new Date(version.timestamp).toISOString()}>
              {formatMessageTimestamp(version.timestamp)}
            </time>
            {#if index === 0}
              <span class="edit-history-original">{$i18n.t('timeline.editHistoryOriginal')}</span>
            {/if}
            <span class="edit-history-actions">
              {#if onReply}
                <IconButton
                  class="edit-history-reply"
                  size="small"
                  variant="ghost"
                  label={$i18n.t('timeline.reply')}
                  onclick={() => {
                    act(version, onReply);
                  }}
                >
                  <ReplyIcon />
                </IconButton>
              {/if}
              {#if onThread && index === 0}
                <IconButton
                  class="edit-history-thread"
                  size="small"
                  variant="ghost"
                  label={$i18n.t('timeline.replyInThread')}
                  onclick={() => {
                    act(version, onThread);
                  }}
                >
                  <ThreadIcon />
                </IconButton>
              {/if}
              {#if onDelete}
                <IconButton
                  class="edit-history-delete"
                  size="small"
                  variant="ghost"
                  label={$i18n.t('timeline.deleteMessage')}
                  onclick={() => {
                    act(version, onDelete);
                  }}
                >
                  <TrashIcon />
                </IconButton>
              {/if}
            </span>
          </div>
          <FormattedBody html={version.html} {senderTimezone} {onMatrixLink} />
        </li>
      {/each}
    </ol>
  </div>
{/snippet}

{#if desktop}
  <DialogFrame bind:open variant="verification" label={$i18n.t('timeline.editHistoryTitle')}>
    {@render content()}
  </DialogFrame>
{:else}
  <BottomSheet
    bind:open
    label={$i18n.t('timeline.editHistoryTitle')}
    closeLabel={$i18n.t('timeline.closeEditHistory')}
  >
    {@render content()}
  </BottomSheet>
{/if}

<style>
  .edit-history {
    display: grid;
    gap: var(--space-300);
    width: min(32rem, calc(100vw - 2rem));
  }

  .edit-history.sheet {
    padding: 0 var(--space-400);
    width: auto;
  }

  h2 {
    font-size: var(--font-size-heading);
    margin: 0;
  }

  .edit-history-versions {
    display: grid;
    list-style: none;
    margin: 0;
    max-height: 28rem;
    overflow: auto;
    padding: 0;
  }

  .edit-history-version {
    border-top: var(--border-width) solid var(--surface-container-line);
    display: grid;
    gap: var(--space-100);
    min-width: 0;
    overflow-wrap: anywhere;
    padding-block: var(--space-300);
  }

  .edit-history-meta {
    align-items: center;
    color: var(--surface-var-on-container);
    display: flex;
    font-size: var(--font-size-small);
    gap: var(--space-200);
  }

  .edit-history-original {
    background: var(--surface-var-container);
    border-radius: var(--radii-300);
    padding: 0 var(--space-200);
  }

  .edit-history-actions {
    display: flex;
    margin-inline-start: auto;
  }
</style>
