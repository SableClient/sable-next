<script lang="ts">
  import { helpUrl, privacyUrl, sourceUrl, termsLinks } from '#lib/deployment/links.js';
  import { loginConfiguration } from '#lib/deployment/deployment.js';
  import { i18n } from '#lib/i18n.js';
  const version = `v${import.meta.env.VITE_APP_VERSION ?? 'dev'}`;

  const links = $derived(
    [
      { text: i18n.t('common.sourceCode'), url: sourceUrl(loginConfiguration()) },
      { text: i18n.t('footer.help'), url: helpUrl(loginConfiguration()) },
      { text: i18n.t('footer.privacy'), url: privacyUrl(loginConfiguration()) },
      ...termsLinks(loginConfiguration()),
    ].filter((link): link is { text: string; url: string } => link.url !== null)
  );
</script>

<footer class="auth-footer">
  {#each links as link (link.url)}
    <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- external deployment URL -->
    <a href={link.url} rel="noopener noreferrer" target="_blank">{link.text}</a>
    <span aria-hidden="true">·</span>
  {/each}
  <span
    >{i18n.t('footer.poweredBy')}
    <a href="https://matrix.org" rel="noopener noreferrer" target="_blank">Matrix</a></span
  >
  <span aria-hidden="true">·</span>
  <span>{version}</span>
</footer>

<style>
  .auth-footer {
    align-items: center;
    color: var(--sec-main);
    display: flex;
    flex-wrap: wrap;
    font-size: var(--font-size-small);
    gap: var(--space-200);
    justify-content: center;
    margin: var(--space-400) auto 0;
  }

  .auth-footer a {
    color: inherit;
  }

  .auth-footer a:hover {
    color: var(--bg-on-container);
  }
</style>
