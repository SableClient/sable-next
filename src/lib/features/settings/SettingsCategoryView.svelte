<script lang="ts">
  import { i18n } from '#lib/i18n.js';
  import AppPageShell from '#lib/ui/primitives/AppPageShell.svelte';
  import type { SettingsCategory } from '#lib/settings/registry.js';
  import ComposerSettingsPreview from './ComposerSettingsPreview.svelte';
  import SettingsCategorySections from './SettingsCategorySections.svelte';
  import TimelineSettingsPreview from './TimelineSettingsPreview.svelte';

  interface Props {
    category: SettingsCategory;
  }

  let { category }: Props = $props();
  const isComposer = $derived(category.id === 'composer');
  const isTimeline = $derived(category.id === 'timeline' || category.id === 'appearance');
  const docked = $derived(isComposer || isTimeline);
  let draftTextScale = $state<number | null>(null);
</script>

<AppPageShell
  title={$i18n.t(category.name)}
  description={category.description ? $i18n.t(category.description) : undefined}
  density="compact"
  class={['settings-category', isComposer && 'settings-category-dock']}
>
  {#if docked}
    <div class="settings-with-preview">
      <div class="settings-with-preview-scroll">
        <SettingsCategorySections
          {category}
          onRangeDraft={(key, value) => {
            if (key === 'textScale') draftTextScale = value;
          }}
        />
      </div>
      <div
        class={['settings-preview-dock', draftTextScale !== null && 'text-scale-scope']}
        style:--text-scale={draftTextScale}
      >
        {#if isComposer}
          <ComposerSettingsPreview />
        {:else}
          <TimelineSettingsPreview />
        {/if}
      </div>
    </div>
  {:else}
    <SettingsCategorySections {category} />
  {/if}
</AppPageShell>

<style>
  :global(.settings-scroll .app-page-shell.settings-category) {
    max-width: none;
    overflow: visible;
  }

  :global(.settings-scroll .app-page-shell.settings-category-dock) {
    background: var(--surface-container);
    color: var(--surface-on-container);
  }

  .settings-with-preview {
    min-height: min(70vh, 40rem);
    overflow-x: clip;
  }

  .settings-with-preview-scroll {
    display: flex;
    flex: 1;
    flex-direction: column;
    min-width: 0;
    padding-bottom: var(--space-300);
  }

  .settings-preview-dock {
    background: var(--surface-container);
    bottom: 0;
    isolation: isolate;
    margin-top: auto;
    max-width: 100%;
    min-width: 0;
    overflow-x: clip;
    position: sticky;
    z-index: 3;
  }

  .settings-preview-dock::before {
    background: linear-gradient(
      to top,
      var(--surface-container) 20%,
      color-mix(in oklab, var(--surface-container) 70%, transparent) 55%,
      transparent
    );
    bottom: 100%;
    content: '';
    height: var(--space-500);
    left: 0;
    pointer-events: none;
    position: absolute;
    right: 0;
  }
</style>
