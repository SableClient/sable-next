<script lang="ts">
  import type { ProfileFieldView } from '#src/generated/protocol';
  import CaretDownIcon from 'phosphor-svelte/lib/CaretDownIcon';
  import CaretRightIcon from 'phosphor-svelte/lib/CaretRightIcon';

  import { i18n } from '#lib/i18n.js';
  import { preferences } from '#lib/settings/preferences.svelte.js';
  import Button from '#lib/ui/primitives/Button.svelte';

  import { profileFieldJson, profileFieldMap, profileFieldPreview } from './profile-field-map.js';

  interface Props {
    extra: readonly ProfileFieldView[];
    open: boolean;
    active: ProfileFieldView | null;
  }

  let { extra, open: miscOpen = $bindable(), active: activeExtra = $bindable() }: Props = $props();
  const profileId = $props.id();
  const miscId = `${profileId}-misc`;
</script>

<Button
  class="profile-extra"
  aria-expanded={miscOpen}
  aria-controls={miscId}
  onclick={() => {
    miscOpen = !miscOpen;
    activeExtra = null;
  }}
  size="small"
  block
>
  {#if miscOpen}
    <CaretDownIcon />
    {#if activeExtra}
      {activeExtra.key}
    {:else}
      {i18n.t('timeline.profileHideMiscData', { count: extra.length })}
    {/if}
  {:else}
    <CaretRightIcon class="mirror-rtl" />
    {i18n.t('timeline.profileMiscData', { count: extra.length })}
  {/if}
</Button>
{#if miscOpen}
  <div class="profile-extra-open" id={miscId}>
    {#if activeExtra === null}
      <div class="profile-keys">
        {#each extra as field (field.key)}
          <Button
            size="small"
            class="choice"
            block
            onclick={() => {
              activeExtra = field;
            }}
          >
            {field.key}
          </Button>
        {/each}
      </div>
    {:else if preferences.developerTools}
      <pre class="profile-extra-json">{profileFieldJson(activeExtra.value)}</pre>
    {:else}
      {@const value = profileFieldPreview(activeExtra.value)}
      {@const map = profileFieldMap(value)}
      {#if map}
        <table class="profile-key-table" aria-label={activeExtra.key}>
          <tbody>
            {#each map as [key, value] (key)}
              <tr>
                <th scope="row">{key}</th>
                <td>{value}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      {:else}
        {value}
      {/if}
    {/if}
  </div>
{/if}

<style>
  :global(.btn.profile-extra),
  .profile-keys :global(.btn) {
    --button-on-container: var(--profile-ink, var(--sec-on-container));

    background: transparent;
    border: 0;
  }

  :global(.btn.profile-extra) {
    font-size: var(--font-size-small);
    line-height: var(--line-height-body);
  }

  .profile-extra-open {
    max-height: 12rem;
    overflow: auto;
  }

  .profile-key-table th,
  .profile-key-table td {
    border: var(--border-width) solid var(--profile-line, var(--surface-container-line));
    padding: var(--space-100);
  }

  .profile-key-table {
    border-collapse: collapse;
  }

  .profile-extra-json {
    font-family: var(--font-family-mono);
    font-variant-ligatures: none;
    margin: 0;
    overflow-wrap: anywhere;
    white-space: pre-wrap;
  }
</style>
