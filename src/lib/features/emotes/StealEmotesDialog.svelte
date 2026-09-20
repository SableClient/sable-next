<script lang="ts">
  import { useCoreClient } from '#lib/core/context.js';
  import { invalidatePacks } from '#lib/emoji/load-packs.js';
  import { i18n } from '#lib/i18n.js';
  import MediaImage from '#lib/ui/MediaImage.svelte';
  import Alert from '#lib/ui/primitives/Alert.svelte';
  import Button from '#lib/ui/primitives/Button.svelte';
  import DialogFrame from '#lib/ui/primitives/DialogFrame.svelte';
  import TextInput from '#lib/ui/primitives/TextInput.svelte';

  import { USER_EMOTES_EVENT_TYPE } from './pack-address.js';
  import { normalizeShortcode } from './pack-content.js';
  import { mergedPackContent, uploadCandidates, type EmoteCandidate } from './steal-emotes.js';

  interface Props {
    open?: boolean;
    candidates: EmoteCandidate[];
  }

  let { open = $bindable(false), candidates }: Props = $props();
  const core = useCoreClient();

  let names = $state<Record<string, string>>({});
  let busy = $state(false);
  let failed = $state(false);

  let picks = $derived(
    candidates.map((candidate) => ({
      ...candidate,
      shortcode: normalizeShortcode(names[candidate.source] ?? candidate.shortcode),
    }))
  );
  let ready = $derived(picks.every((pick) => pick.shortcode !== ''));

  async function add(): Promise<void> {
    if (busy || !ready) return;

    busy = true;
    failed = false;
    try {
      const added = await uploadCandidates(core, $state.snapshot(picks));
      const current = await core.commands.accountData(USER_EMOTES_EVENT_TYPE);
      await core.commands.setAccountData(USER_EMOTES_EVENT_TYPE, mergedPackContent(current, added));
      invalidatePacks(core.commands);
      names = {};
      open = false;
    } catch (error) {
      console.warn('[sable emotes] the emote could not be added', error);
      failed = true;
    } finally {
      busy = false;
    }
  }
</script>

<DialogFrame
  bind:open
  variant="verification"
  label={$i18n.t('emotes.stealTitle')}
  onConfirm={() => {
    void add();
  }}
>
  <div class="steal">
    <h2>{$i18n.t('emotes.stealTitle')}</h2>
    <p class="explain">{$i18n.t('emotes.stealExplain')}</p>
    {#if failed}
      <Alert variant="critical" role="alert">{$i18n.t('emotes.stealFailed')}</Alert>
    {/if}

    <ul class="candidates">
      {#each candidates as candidate (candidate.source)}
        <li>
          <MediaImage source={candidate.source} alt="" width={32} height={32} original />
          <TextInput
            value={names[candidate.source] ?? candidate.shortcode}
            aria-label={$i18n.t('emotes.shortcode')}
            disabled={busy}
            oninput={(event: Event & { currentTarget: HTMLInputElement }) => {
              names = { ...names, [candidate.source]: event.currentTarget.value };
            }}
          />
        </li>
      {/each}
    </ul>

    <div class="actions">
      <Button
        type="button"
        variant="ghost"
        disabled={busy}
        onclick={() => {
          open = false;
        }}
      >
        {$i18n.t('timeline.cancel')}
      </Button>
      <Button type="submit" variant="primary" disabled={busy || !ready} loading={busy}>
        {$i18n.t('emotes.stealConfirm')}
      </Button>
    </div>
  </div>
</DialogFrame>

<style>
  .steal {
    display: grid;
    gap: var(--space-300);
    width: min(27rem, calc(100vw - 2rem));
  }

  h2 {
    font-size: var(--font-size-heading);
    line-height: 1.3;
    margin: 0;
  }

  .explain {
    color: var(--surface-var-on-container);
    font-size: var(--font-size-small);
    line-height: 1.45;
    margin: 0;
  }

  .candidates {
    display: grid;
    gap: var(--space-200);
    list-style: none;
    margin: 0;
    max-height: 18rem;
    overflow-y: auto;
    padding: 0;
  }

  .candidates li {
    align-items: center;
    display: grid;
    gap: var(--space-300);
    grid-template-columns: auto 1fr;
  }

  .actions {
    display: flex;
    gap: var(--space-200);
    justify-content: flex-end;
  }
</style>
