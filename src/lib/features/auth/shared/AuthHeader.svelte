<script lang="ts">
  import logo from '$lib/assets/res/svg/logo.svg';
  import { i18n } from '$lib/i18n';

  interface Props {
    hasLoggedInBefore: boolean;
  }

  let { hasLoggedInBefore }: Props = $props();
</script>

<header class="auth-heading">
  <img class="logo" src={logo} alt="" />
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

  .logo {
    filter: drop-shadow(0 0.375rem 0.625rem var(--sable-shadow));
    height: 4rem;
    width: 4rem;
  }
</style>
