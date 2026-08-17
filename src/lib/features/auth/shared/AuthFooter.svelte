<script lang="ts">
  import { SABLE_SOURCE_URL } from '$lib/config/links';
  import { i18n } from '$lib/i18n';
</script>

<footer class="auth-footer">
  <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- external project URL -->
  <a href={SABLE_SOURCE_URL} rel="noopener noreferrer" target="_blank">
    {$i18n.t('footer.sourceCode')}
  </a>
  <span aria-hidden="true">·</span>
  <span
    >{$i18n.t('footer.poweredBy')}
    <a href="https://matrix.org" rel="noopener noreferrer" target="_blank">Matrix</a></span
  >
</footer>

<style>
  .auth-footer {
    align-items: center;
    color: var(--sable-sec-main);
    display: flex;
    font-size: var(--font-size-small);
    gap: 0.5rem;
    justify-content: center;
    margin: 1rem auto 0;
  }

  .auth-footer a {
    color: inherit;
  }

  .auth-footer a:hover {
    color: var(--sable-bg-on-container);
  }
</style>
