<script lang="ts">
  import { i18n } from '#lib/i18n.js';
  import SableBrandMark from '#lib/ui/SableBrandMark.svelte';

  interface Props {
    hasLoggedInBefore: boolean;
  }

  let { hasLoggedInBefore }: Props = $props();
</script>

<header class="auth-heading">
  <SableBrandMark />
  <h1 id="sable-title">
    {hasLoggedInBefore ? $i18n.t('auth.welcomeBack') : $i18n.t('auth.welcome')}
  </h1>
</header>

<style>
  .auth-heading {
    align-self: end;
    margin-bottom: 1.25rem;
    text-align: center;
  }

  .auth-heading h1 {
    font-size: var(--font-size-xlarge);
    margin: 1rem 0 0;
  }
</style>
