<script lang="ts">
  import type { MemberView, TimelineItemView } from '#src/generated/protocol';
  import type { MatrixLink } from '#lib/rooms/matrix-link.js';
  import { i18n } from '#lib/i18n.js';
  import Button from '#lib/ui/primitives/Button.svelte';

  import FormattedBody from './FormattedBody.svelte';
  import MessageBody from './MessageBody.svelte';
  import type { RevealState } from './revealed-redactions.svelte.js';

  const MEDIA = ['image', 'video', 'sticker', 'gallery', 'file', 'audio'];

  interface Props {
    item: TimelineItemView;
    reveal: RevealState | undefined;
    onToggle: () => void;
    senderTimezone: string | null;
    members: readonly MemberView[];
    canRedactOthers: boolean;
    encrypted: boolean | null;
    onMatrixLink?: (link: MatrixLink, anchor: HTMLAnchorElement) => void;
    onOpenMedia?: (eventId: string) => void;
    onSenderProfile?: (userId: string, anchor: HTMLElement) => void;
  }

  let {
    item,
    reveal,
    onToggle,
    senderTimezone,
    members,
    canRedactOthers,
    encrypted,
    onMatrixLink,
    onOpenMedia,
    onSenderProfile,
  }: Props = $props();

  const labelId = $props.id();
  let mediaShown = $state(false);
</script>

<div class="toggle">
  <Button size="small" variant="ghost" loading={reveal?.kind === 'loading'} onclick={onToggle}>
    {i18n.t(reveal?.kind === 'shown' ? 'timeline.hideRedacted' : 'timeline.viewRedacted')}
  </Button>
  {#if reveal?.kind === 'failed'}
    <p class="note" role="status">{reveal.message}</p>
  {/if}
</div>
{#if reveal?.kind === 'shown'}
  {@const content = reveal.content}
  <section class="revealed" aria-labelledby={labelId}>
    <p class="caption" id={labelId}>{i18n.t('timeline.redactedRevealedCaption')}</p>
    {#if content.kind === 'message'}
      <FormattedBody html={content.html} {senderTimezone} {onMatrixLink} />
    {:else if MEDIA.includes(content.kind) && !mediaShown}
      <Button size="small" variant="secondary" onclick={() => (mediaShown = true)}>
        {i18n.t('timeline.redactedShowMedia')}
      </Button>
    {:else}
      <MessageBody
        item={{ ...item, content }}
        {senderTimezone}
        {members}
        {canRedactOthers}
        {encrypted}
        {onMatrixLink}
        {onOpenMedia}
        {onSenderProfile}
      />
    {/if}
  </section>
{/if}

<style>
  .toggle {
    align-items: center;
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-200);
  }

  .note {
    color: var(--surface-var-on-container);
    font-size: var(--font-size-small);
    line-height: var(--line-height-small);
    margin: 0;
  }

  .revealed {
    border-inline-start: var(--border-width) solid var(--surface-var-container-line);
    display: grid;
    gap: var(--space-100);
    margin-block-start: var(--space-100);
    padding-inline-start: var(--space-200);
  }

  .caption {
    color: var(--surface-var-on-container);
    font-size: var(--font-size-small);
    line-height: var(--line-height-small);
    margin: 0;
  }
</style>
