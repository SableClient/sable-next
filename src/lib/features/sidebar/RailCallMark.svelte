<script lang="ts">
  import SpeakerHighIcon from 'phosphor-svelte/lib/SpeakerHighIcon';

  import { i18n } from '#lib/i18n.js';

  interface Props {
    others?: boolean;
    id?: string;
  }

  let { others = false, id }: Props = $props();
</script>

{#if others}
  <span class="call-mark others" {id}
    ><SpeakerHighIcon aria-hidden="true" /><span class="screen-reader-only"
      >{i18n.t('nav.voiceActive')}</span
    ></span
  >
{:else}
  <span class="call-mark" aria-hidden="true"><SpeakerHighIcon weight="fill" /></span>
{/if}

<style>
  .call-mark {
    align-items: center;
    background: var(--success-main);
    border: var(--border-width) solid var(--bg-container);
    border-radius: var(--radii-pill);
    color: var(--success-on-main);
    display: flex;
    inset-inline-end: -0.25rem;
    justify-content: center;
    padding: var(--space-050);
    position: absolute;
    top: -0.25rem;
    z-index: 1;
  }

  .call-mark.others {
    background: var(--bg-container);
    border-color: var(--success-main);
    color: var(--success-main);
  }

  .call-mark :global(svg) {
    height: 0.625rem;
    width: 0.625rem;
  }
</style>
