<script lang="ts">
  import PageTitle from '#lib/ui/primitives/PageTitle.svelte';
  import { resolve } from '$app/paths';
  import ChatCircleDotsIcon from 'phosphor-svelte/lib/ChatCircleDotsIcon';
  import CompassIcon from 'phosphor-svelte/lib/CompassIcon';
  import GithubLogoIcon from 'phosphor-svelte/lib/GithubLogoIcon';
  import HeartIcon from 'phosphor-svelte/lib/HeartIcon';
  import PlusCircleIcon from 'phosphor-svelte/lib/PlusCircleIcon';

  import { donateUrl, sourceUrl, supportRoom } from '#lib/deployment/links.js';
  import { readReturningUser } from '#lib/features/auth/flow/auth-flow.svelte.js';
  import { i18n } from '#lib/i18n.js';
  import { roomPathParamFromId } from '#lib/rooms/room-list.svelte.js';
  import ActionCard from '#lib/ui/ActionCard.svelte';
  import SableBrandMark from '#lib/ui/SableBrandMark.svelte';
  import LinkButton from '#lib/ui/primitives/LinkButton.svelte';
  import SettingsChangesCard from './SettingsChangesCard.svelte';

  interface Props {
    titleKey?: string;
  }

  let { titleKey = 'nav.home' }: Props = $props();
  const hasLoggedInBefore = readReturningUser();
  let room = $derived(supportRoom());
  let supportHref = $derived(
    room ? resolve('/(app)/to/[...permalink]', { permalink: roomPathParamFromId(room) }) : null
  );
  let source = $derived(sourceUrl());
  let donate = $derived(donateUrl());

  const startCards = [
    {
      href: resolve('explore'),
      icon: CompassIcon,
      title: 'home.findCommunityTitle',
      description: 'home.findCommunityDescription',
    },
    {
      href: resolve('create-room'),
      icon: PlusCircleIcon,
      title: 'home.startRoomTitle',
      description: 'home.startRoomDescription',
    },
    {
      href: resolve('direct'),
      icon: ChatCircleDotsIcon,
      title: 'home.joinConversationTitle',
      description: 'home.joinConversationDescription',
    },
  ];
</script>

<PageTitle title={i18n.t(titleKey)} />

<main class="home-page" aria-labelledby="home-title">
  <section class="hero">
    <SableBrandMark />
    <h1 id="home-title">
      {i18n.t(hasLoggedInBefore ? 'auth.welcomeBack' : 'auth.welcome')}
    </h1>

    {#if supportHref || source || donate}
      <div class="hero-actions" aria-label={i18n.t('home.resourcesLabel')}>
        {#if supportHref}
          <LinkButton href={supportHref} variant="primary">
            <ChatCircleDotsIcon aria-hidden="true" />
            {i18n.t('home.getSupport')}
          </LinkButton>
        {/if}
        {#if source}
          <LinkButton href={source} target="_blank" rel="noreferrer noopener" variant="ghost">
            <GithubLogoIcon aria-hidden="true" />
            {i18n.t('common.viewSource')}
          </LinkButton>
        {/if}
        {#if donate}
          <LinkButton href={donate} target="_blank" rel="noreferrer noopener" variant="secondary">
            <HeartIcon aria-hidden="true" />
            {i18n.t('home.supportDevelopment')}
          </LinkButton>
        {/if}
      </div>
    {/if}
  </section>

  <SettingsChangesCard />

  <section class="start-section" aria-labelledby="start-title">
    <div class="section-heading">
      <h2 id="start-title">{i18n.t('home.nextStepsTitle')}</h2>
    </div>

    <div class="start-grid">
      {#each startCards as card (card.title)}
        <ActionCard
          icon={card.icon}
          title={i18n.t(card.title)}
          description={i18n.t(card.description)}
          href={card.href}
          disabled={!card.href}
        />
      {/each}
    </div>
  </section>
</main>

<style>
  .home-page {
    box-sizing: border-box;
    display: none;
    margin: 0 auto;
    max-width: 64rem;
    min-height: 100%;
    overflow: auto;
    padding: clamp(var(--space-500), 5vw, calc(var(--space-700) + var(--space-600)))
      var(--page-gutter) var(--space-900);
    width: 100%;
  }

  .hero {
    align-items: center;
    display: flex;
    flex-direction: column;
    padding: clamp(
        var(--space-700),
        7vw,
        calc(var(--space-700) + var(--space-600) + var(--space-500))
      )
      clamp(var(--space-500), 7vw, calc(var(--space-700) + var(--space-700) + var(--space-600)));
    text-align: center;
  }

  h1,
  h2 {
    margin: 0;
  }

  .hero h1 {
    font-size: var(--font-size-heading);
    line-height: var(--line-height-heading);
    margin: var(--space-400) 0 0;
  }

  .hero-actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-300);
    justify-content: center;
    margin-top: var(--space-500);
  }

  .hero-actions :global(.btn) {
    flex: 0 0 11rem;
    width: 11rem;
  }

  .hero-actions :global(.btn:not(:disabled)) {
    cursor: pointer;
    pointer-events: auto;
  }

  .hero-actions :global(.btn:disabled) {
    cursor: default;
    pointer-events: none;
  }

  .start-section {
    padding-top: clamp(
      calc(var(--space-700) + var(--space-300)),
      7vw,
      calc(var(--space-700) + var(--space-600) + var(--space-400))
    );
  }

  .section-heading {
    margin-bottom: var(--space-500);
  }

  .section-heading h2 {
    font-size: var(--font-size-heading);
    line-height: var(--line-height-heading);
  }

  .start-grid {
    display: grid;
    gap: var(--space-400);
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }

  @media (--app-layout) {
    .home-page {
      display: block;
    }
  }
</style>
