<script lang="ts">
  import { i18n } from '#lib/i18n.js';
</script>

<div class="composer-shell">
  <div class="composer">
    <div class="composer-row">
      <p class="locked">{i18n.t('composer.readOnly')}</p>
    </div>
  </div>
</div>

<style>
  .locked {
    align-items: center;
    color: var(--surface-var-on-container);
    display: flex;
    font-size: max(var(--font-size-editor), var(--font-size-input-min));
    grid-column: 1 / -1;
    justify-content: center;
    margin: 0;
    min-height: var(--target);
    padding: var(--space-200) var(--space-300);
  }
</style>
