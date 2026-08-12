<script lang="ts">
  import { resolve } from '$app/paths';
  import { i18n } from '$lib/i18n';
  import EmptyState from '$lib/ui/primitives/EmptyState.svelte';
  import LinkButton from '$lib/ui/primitives/LinkButton.svelte';
</script>

<svelte:head>
  <title>{$i18n.t('nav.home')} · Sable</title>
</svelte:head>

<EmptyState
  eyebrow={$i18n.t('nav.home')}
  title={$i18n.t('home.welcome')}
  description={$i18n.t('home.empty')}
  titleId="welcome-heading"
>
  {#snippet actions()}
    <LinkButton href={resolve('/direct')} variant="primary">{$i18n.t('nav.direct')}</LinkButton>
    <LinkButton href={resolve('/explore')}>{$i18n.t('nav.explore')}</LinkButton>
  {/snippet}
</EmptyState>
