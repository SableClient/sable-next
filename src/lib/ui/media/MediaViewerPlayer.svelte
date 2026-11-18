<script lang="ts">
  import { i18n } from '#lib/i18n.js';
  import { savesNatively } from '#lib/platform/files.js';

  interface Props {
    kind: 'video' | 'audio';
    url: string;
    label: string;
    fileName: string;
  }

  let { kind, url, label, fileName }: Props = $props();
</script>

{#if kind === 'video'}
  <!-- Matrix carries no caption track for an attachment. -->
  <!-- svelte-ignore a11y_media_has_caption -->
  <video
    class="media-player"
    controls
    controlslist={savesNatively() ? 'nodownload' : undefined}
    src={url}
    aria-label={label || i18n.t('timeline.videoAttachment')}
  >
    {fileName}
  </video>
{:else}
  <audio
    class="media-player"
    controls
    controlslist={savesNatively() ? 'nodownload' : undefined}
    src={url}
    aria-label={label || i18n.t('timeline.audioAttachment')}
  >
    {fileName}
  </audio>
{/if}

<style>
  :global(.stage) .media-player {
    max-height: 100%;
    max-width: 100%;
  }
</style>
