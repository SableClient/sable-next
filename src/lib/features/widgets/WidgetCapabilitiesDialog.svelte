<script lang="ts">
  import { i18n } from '#lib/i18n.js';
  import Button from '#lib/ui/primitives/Button.svelte';
  import DialogFrame from '#lib/ui/primitives/DialogFrame.svelte';

  import { capabilityLabel, isSensitiveCapability } from './capabilities.js';

  interface Props {
    open?: boolean;
    widgetName: string;
    requested: readonly string[];
    onDecide: (approved: string[]) => void;
  }

  let { open = $bindable(false), widgetName, requested, onDecide }: Props = $props();

  let granted = $derived(requested.filter((capability) => !isSensitiveCapability(capability)));

  function toggle(capability: string): void {
    granted = granted.includes(capability)
      ? granted.filter((entry) => entry !== capability)
      : [...granted, capability];
  }

  function decide(approved: string[]): void {
    open = false;
    onDecide(approved);
  }
</script>

<DialogFrame
  {open}
  onOpenChange={(next) => {
    if (!next) decide([]);
  }}
  variant="verification"
  label={$i18n.t('widgets.capabilitiesTitle', { name: widgetName })}
>
  <div class="capabilities">
    <h2>{$i18n.t('widgets.capabilitiesTitle', { name: widgetName })}</h2>
    <p class="explain">{$i18n.t('widgets.capabilitiesExplain')}</p>

    <ul>
      {#each requested as capability (capability)}
        {@const sensitive = isSensitiveCapability(capability)}
        <li class:sensitive>
          <label>
            <input
              type="checkbox"
              checked={granted.includes(capability)}
              onchange={() => {
                toggle(capability);
              }}
            />
            <span class="label">
              {$i18n.t(capabilityLabel(capability), { capability })}
              {#if sensitive}
                <span class="warning">{$i18n.t('widgets.capabilitySensitive')}</span>
              {/if}
            </span>
          </label>
        </li>
      {/each}
    </ul>

    <div class="actions">
      <Button
        variant="ghost"
        onclick={() => {
          decide([]);
        }}
      >
        {$i18n.t('widgets.capabilitiesDeny')}
      </Button>
      <Button
        onclick={() => {
          decide(granted);
        }}
      >
        {$i18n.t('widgets.capabilitiesAllow')}
      </Button>
    </div>
  </div>
</DialogFrame>

<style>
  .capabilities {
    display: grid;
    gap: var(--space-300);
    width: min(26rem, calc(100vw - 2rem));
  }

  h2 {
    font-size: var(--font-size-heading);
    margin: 0;
  }

  .explain {
    color: var(--sable-surface-var-on-container);
    font-size: var(--font-size-small);
    line-height: 1.45;
    margin: 0;
  }

  ul {
    display: grid;
    gap: var(--space-200);
    list-style: none;
    margin: 0;
    max-height: 16rem;
    overflow: auto;
    padding: 0;
  }

  label {
    align-items: start;
    cursor: pointer;
    display: flex;
    gap: var(--space-200);
  }

  .label {
    font-size: var(--font-size-small);
  }

  .warning {
    color: var(--sable-crit-main);
    display: block;
    font-size: var(--font-size-small);
  }

  .actions {
    display: flex;
    gap: var(--space-200);
    justify-content: flex-end;
  }
</style>
