<script lang="ts">
  import { i18n } from '#lib/i18n.js';
  import type { MatrixLink } from '#lib/rooms/matrix-link.js';
  import Alert from '#lib/ui/primitives/Alert.svelte';
  import Button from '#lib/ui/primitives/Button.svelte';
  import DialogActions from '#lib/ui/primitives/DialogActions.svelte';
  import DialogFrame from '#lib/ui/primitives/DialogFrame.svelte';
  import { scrollHint } from '#lib/ui/scroll-hint.js';
  import { toasts } from '#lib/ui/toasts.svelte.js';

  import FormattedBody from './messages/FormattedBody.svelte';
  import type { RoomRules } from './room-rules.svelte.js';
  import '#lib/ui/primitives/dialog-body.css';

  interface Props {
    rules: RoomRules;
    roomName: string;
    sourceName: string | null;
    isSpace: boolean;
    onLeave: () => void;
    onMatrixLink?: (link: MatrixLink, anchor: HTMLAnchorElement) => void;
  }

  let { rules, roomName, sourceName, isSpace, onLeave, onMatrixLink }: Props = $props();

  let heading = $derived(i18n.t('room.rulesHeading', { name: sourceName ?? roomName }));

  async function accept(): Promise<void> {
    try {
      await rules.accept();
    } catch (error) {
      console.warn('[sable room] rules acceptance not saved', error);
      toasts.error(i18n.t('room.rulesAcceptFailed'));
    }
  }
</script>

<DialogFrame
  open={rules.visible}
  onOpenChange={(next: boolean) => {
    if (!next) rules.dismiss();
  }}
  variant="verification"
  label={heading}
>
  <div class="dialog-body rules-dialog">
    <h2>{heading}</h2>
    {#if sourceName !== null}
      <p class="rules-hint">{i18n.t('room.rulesDelegatedFrom', { room: roomName })}</p>
    {/if}
    {#if rules.removed}
      <Alert variant="warning" role="status">{i18n.t('room.rulesRemoved')}</Alert>
    {:else if rules.stale}
      <Alert variant="warning" role="status">{i18n.t('room.rulesChanged')}</Alert>
    {/if}
    <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
    <div
      class="rules-body"
      role="region"
      aria-label={i18n.t('room.rulesText')}
      tabindex="0"
      {@attach scrollHint}
    >
      <FormattedBody
        html={rules.shown?.html ?? ''}
        onMatrixLink={(link, anchor) => {
          rules.dismiss();
          onMatrixLink?.(link, anchor);
        }}
      />
    </div>
    {#if rules.blocking}
      <p class="rules-hint">{i18n.t('room.rulesAcceptHint')}</p>
    {/if}
    <DialogActions>
      {#if rules.blocking}
        <Button
          variant="ghost"
          disabled={rules.accepting}
          onclick={() => {
            rules.dismiss();
            onLeave();
          }}
        >
          {isSpace ? i18n.t('room.menuLeaveSpace') : i18n.t('room.menuLeave')}
        </Button>
        {#if rules.stale}
          <Button onclick={() => rules.review()}>{i18n.t('room.rulesShowUpdated')}</Button>
        {:else}
          <Button loading={rules.accepting} onclick={() => void accept()}>
            {i18n.t('room.rulesAccept')}
          </Button>
        {/if}
      {:else}
        {#if rules.stale}
          <Button onclick={() => rules.review()}>{i18n.t('room.rulesShowUpdated')}</Button>
        {/if}
        <Button variant="ghost" onclick={() => rules.dismiss()}>{i18n.t('common.close')}</Button>
      {/if}
    </DialogActions>
  </div>
</DialogFrame>

<style>
  .rules-dialog {
    gap: var(--space-400);
  }

  h2 {
    font-size: var(--font-size-heading);
    line-height: var(--line-height-heading);
    margin: 0;
  }

  .rules-hint {
    color: var(--surface-var-on-container);
    margin: 0;
  }

  .rules-body {
    overflow-wrap: anywhere;
    overflow-y: auto;
  }
</style>
