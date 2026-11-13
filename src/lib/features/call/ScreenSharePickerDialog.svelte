<script lang="ts">
  import { Dialog, RadioGroup } from 'bits-ui';
  import { untrack } from 'svelte';

  import { i18n } from '#lib/i18n.js';
  import type { ScreenShareCandidate } from '#lib/platform/electron.js';
  import Button from '#lib/ui/primitives/Button.svelte';
  import DialogActions from '#lib/ui/primitives/DialogActions.svelte';
  import DialogFrame from '#lib/ui/primitives/DialogFrame.svelte';

  interface Props {
    sources: readonly ScreenShareCandidate[];
    onShare: (id: string) => void;
    onCancel: () => void;
  }

  let { sources, onShare, onCancel }: Props = $props();

  let choice = $state(untrack(() => sources[0]?.id ?? ''));

  const groups = $derived(
    [
      {
        name: i18n.t('call.screenPickerScreens'),
        sources: sources.filter((source) => source.id.startsWith('screen:')),
      },
      {
        name: i18n.t('call.screenPickerWindows'),
        sources: sources.filter((source) => !source.id.startsWith('screen:')),
      },
    ].filter((group) => group.sources.length > 0)
  );

  function share(): void {
    if (choice) onShare(choice);
  }
</script>

<DialogFrame
  open
  onOpenChange={(next) => {
    if (!next) onCancel();
  }}
  variant="verification"
  label={i18n.t('call.screenSourcePicker')}
  onConfirm={share}
>
  <div class="screen-picker">
    <Dialog.Title>
      {#snippet child({ props })}
        <h2 {...props}>{i18n.t('call.screenSourcePicker')}</h2>
      {/snippet}
    </Dialog.Title>

    <RadioGroup.Root
      class="screen-picker-groups"
      value={choice}
      aria-label={i18n.t('call.screenSourcePicker')}
      onValueChange={(next) => {
        choice = next;
      }}
    >
      {#each groups as group (group.name)}
        <section>
          <h3>{group.name}</h3>
          <div class="screen-picker-grid">
            {#each group.sources as source (source.id)}
              <RadioGroup.Item
                value={source.id}
                class="screen-picker-source"
                data-selected={source.id === choice ? 'true' : undefined}
              >
                <img src={source.thumbnail} alt="" />
                <span>{source.name}</span>
              </RadioGroup.Item>
            {/each}
          </div>
        </section>
      {/each}
    </RadioGroup.Root>

    <DialogActions>
      <Button type="button" variant="ghost" onclick={onCancel}>
        {i18n.t('common.cancel')}
      </Button>
      <Button type="submit" disabled={!choice}>{i18n.t('common.share')}</Button>
    </DialogActions>
  </div>
</DialogFrame>

<style>
  .screen-picker {
    display: grid;
    gap: var(--space-300);
    max-width: 100%;
    width: min(44rem, calc(100vw - 2rem));
  }

  h2 {
    font-size: var(--font-size-heading);
    margin: 0;
  }

  h3 {
    color: var(--surface-var-on-container);
    font-size: var(--font-size-small);
    margin: 0 0 var(--space-200);
  }

  :global(.screen-picker-groups) {
    display: grid;
    gap: var(--space-300);
    max-height: min(60vh, 32rem);
    overflow-y: auto;
  }

  .screen-picker-grid {
    display: grid;
    gap: var(--space-200);
    grid-template-columns: repeat(auto-fill, minmax(10rem, 1fr));
  }

  :global(.screen-picker-source) {
    background: var(--surface-container);
    border: var(--border-width) solid var(--surface-container-line);
    border-radius: var(--radius-inner);
    color: var(--surface-on-container);
    cursor: pointer;
    display: grid;
    gap: var(--space-100);
    padding: var(--space-200);
    text-align: start;
  }

  :global(.screen-picker-source:hover) {
    background: var(--surface-container-hover);
  }

  :global(.screen-picker-source:focus-visible) {
    outline: var(--focus-ring-width) solid var(--focus-ring);
    outline-offset: var(--focus-ring-offset);
  }

  :global(.screen-picker-source[data-selected='true']) {
    border-color: var(--primary-main);
  }

  img {
    aspect-ratio: 16 / 9;
    background: var(--surface-container-active);
    border-radius: var(--radius-inner);
    object-fit: contain;
    width: 100%;
  }

  span {
    font-size: var(--font-size-small);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
