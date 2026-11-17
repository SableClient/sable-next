<script lang="ts">
  import { goto } from '$app/navigation';
  import type { MemberView } from '#src/generated/protocol';
  import ChatCenteredTextIcon from 'phosphor-svelte/lib/ChatCenteredTextIcon';

  import { useCoreClient } from '#lib/core/context.js';
  import { i18n } from '#lib/i18n.js';
  import { parseMatrixLink, type MatrixLink } from '#lib/rooms/matrix-link.js';
  import { matrixLinkPath } from '#lib/rooms/permalink.js';
  import { formatDate } from '#lib/ui/date-time.js';
  import IconButton from '#lib/ui/primitives/IconButton.svelte';
  import Tooltip from '#lib/ui/primitives/Tooltip.svelte';

  import { memberName } from '../members/members';
  import AttachmentMeta from './AttachmentMeta.svelte';
  import RoomAttachmentFeed from './RoomAttachmentFeed.svelte';
  import { afterClosing, closingJump, type RoomAttachmentOf } from './room-attachments';
  import { RoomAttachmentsPager } from './room-attachments-pager.svelte';

  interface Props {
    roomId: string;
    members: readonly MemberView[];
    modal?: boolean;
    onJump: (eventId: string) => void;
    onMatrixLink?: (link: MatrixLink, anchor: HTMLAnchorElement) => void;
    onClose?: () => void;
  }

  let { roomId, members, modal = false, onJump, onMatrixLink, onClose }: Props = $props();

  const LINKS_PER_ROW = 3;

  type LinkAttachment = RoomAttachmentOf<'link'>;

  const pager = new RoomAttachmentsPager(useCoreClient(), 'link');

  function senderOf(item: LinkAttachment): string {
    return memberName(members, item.sender);
  }

  function followLink(event: MouseEvent, url: string): void {
    const link = parseMatrixLink(url);
    const anchor = event.currentTarget;
    if (!link || !(anchor instanceof HTMLAnchorElement)) return;
    event.preventDefault();
    afterClosing(modal, onClose, () => {
      if (onMatrixLink) onMatrixLink(link, anchor);
      else {
        const path = matrixLinkPath(url);
        // eslint-disable-next-line svelte/no-navigation-without-resolve -- matrixLinkPath resolves the permalink route
        if (path !== null) void goto(path);
      }
    });
  }

  function splitUrl(url: string): { host: string; rest: string } {
    try {
      const parsed = new URL(url);
      const rest = `${parsed.pathname}${parsed.search}${parsed.hash}`;
      return { host: parsed.host, rest: rest === '/' ? '' : rest };
    } catch {
      return { host: url, rest: '' };
    }
  }
</script>

<RoomAttachmentFeed {pager} {roomId} layout="rows" empty="timeline.attachmentsLinksEmpty">
  {#snippet item(item: LinkAttachment)}
    {@const content = item.content}
    <div class="link-row">
      <span class="link-text">
        {#each content.urls.slice(0, LINKS_PER_ROW) as url (url)}
          {@const parts = splitUrl(url)}
          <Tooltip label={url} multiline>
            {#snippet trigger({ props })}
              <a
                {...props}
                class="link"
                href={url}
                target="_blank"
                rel="external noopener noreferrer"
                onclick={(event) => {
                  followLink(event, url);
                }}
              >
                <span class="link-host">{parts.host}</span>
                {#if parts.rest}
                  <span class="link-rest">{parts.rest}</span>
                {/if}
              </a>
            {/snippet}
          </Tooltip>
        {/each}
        {#if content.urls.length > LINKS_PER_ROW}
          <span class="link-more">
            {i18n.t('timeline.attachmentsMoreLinks', {
              count: content.urls.length - LINKS_PER_ROW,
            })}
          </span>
        {/if}
        <AttachmentMeta sender={senderOf(item)} timestamp={item.timestamp} />
      </span>
      <IconButton
        class="link-jump"
        variant="ghost"
        size="small"
        label={`${i18n.t('common.jumpToMessage')}: ${senderOf(item)}, ${formatDate(item.timestamp)}`}
        onclick={() => {
          closingJump(modal, onClose, onJump)(item.event_id);
        }}
      >
        <ChatCenteredTextIcon />
      </IconButton>
    </div>
  {/snippet}
</RoomAttachmentFeed>

<style>
  .link-row {
    align-items: start;
    border-radius: var(--radius);
    display: flex;
    gap: var(--space-300);
    padding: var(--space-200);
  }

  .link-text {
    display: grid;
    flex: 1;
    gap: var(--space-100);
    min-width: 0;
  }

  .link-row :global(.link-jump) {
    flex: none;
  }

  .link {
    border-radius: var(--radius);
    color: inherit;
    display: flex;
    gap: var(--space-100);
    min-width: 0;
    text-decoration: none;
  }

  .link:focus-visible {
    outline: var(--focus-ring-width) solid var(--focus-ring);
    outline-offset: var(--focus-ring-offset);
  }

  .link-host {
    color: var(--primary-main);
    flex: none;
    font-weight: var(--font-weight-medium);
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .link:hover .link-host,
  .link:focus-visible .link-host {
    text-decoration: underline;
    text-underline-offset: 0.2em;
  }

  .link-rest {
    color: var(--surface-var-on-container);
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .link-more {
    color: var(--surface-var-on-container);
    font-size: var(--font-size-small);
  }
</style>
