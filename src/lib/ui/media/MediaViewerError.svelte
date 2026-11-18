<script lang="ts">
  import { i18n } from '#lib/i18n.js';
</script>

<div class="error">
  <strong>{i18n.t('timeline.mediaUnavailable')}</strong>
  <span>{i18n.t('timeline.mediaUnavailableDetail')}</span>
</div>

<style>
  .error {
    color: var(--crit-main);
    display: grid;
    gap: var(--space-200);
    text-align: center;
  }

  .error span {
    color: var(--surface-var-on-container);
  }

  @media (--app-layout) {
    .error,
    .error span {
      color: var(--media-on-scrim);
    }
  }
</style>
