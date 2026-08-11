<script lang="ts">
  import { resolve } from '$app/paths';
  import { page } from '$app/state';
  import { i18n } from '$lib/i18n';
  import CaretDownIcon from 'phosphor-icons-svelte/IconCaretDownRegular.svelte';
  import ChatsIcon from 'phosphor-icons-svelte/IconChatsRegular.svelte';
  import CompassIcon from 'phosphor-icons-svelte/IconCompassRegular.svelte';
  import DotsThreeIcon from 'phosphor-icons-svelte/IconDotsThreeRegular.svelte';
  import HouseIcon from 'phosphor-icons-svelte/IconHouseRegular.svelte';
  import LinkIcon from 'phosphor-icons-svelte/IconLinkRegular.svelte';
  import MagnifyingGlassIcon from 'phosphor-icons-svelte/IconMagnifyingGlassRegular.svelte';
  import PlusIcon from 'phosphor-icons-svelte/IconPlusRegular.svelte';

  interface Props {
    onNavigate?: (href: string) => void;
    width?: number;
    collapsed?: boolean;
  }

  let { onNavigate, width, collapsed = false }: Props = $props();

  let title = $derived.by(() => {
    const { pathname } = page.url;

    if (pathname.startsWith('/direct')) return $i18n.t('nav.direct');
    if (pathname.startsWith('/space')) return $i18n.t('nav.space');

    return $i18n.t('nav.home');
  });
  let TitleIcon = $derived(page.url.pathname.startsWith('/direct') ? ChatsIcon : HouseIcon);
</script>

<section
  class="room-nav"
  aria-label={$i18n.t('nav.rooms')}
  style:--room-nav-width={width === undefined ? undefined : String(width) + 'px'}
>
  <header class="room-nav-header" class:collapsed>
    <h2 aria-label={collapsed ? title : undefined}>
      {#if collapsed}
        <span aria-hidden="true"><TitleIcon /></span>
      {:else}
        {title}
      {/if}
    </h2>
    <button class="overflow-button" type="button" aria-label={$i18n.t('nav.moreOptions')}>
      <span aria-hidden="true"><DotsThreeIcon /></span>
    </button>
  </header>

  <div class="room-nav-content">
    <div class="room-nav-actions" class:collapsed>
      <a
        href={resolve('/create-room')}
        onclick={() => onNavigate?.('/create-room')}
        aria-label={collapsed ? $i18n.t('nav.createRoom') : undefined}
      >
        <span class="action-icon" aria-hidden="true"><PlusIcon /></span>
        {#if !collapsed}<span>{$i18n.t('nav.createRoom')}</span>{/if}
      </a>
      <button
        type="button"
        disabled
        aria-label={collapsed ? $i18n.t('nav.joinWithAddress') : undefined}
      >
        <span class="action-icon" aria-hidden="true"><LinkIcon /></span>
        {#if !collapsed}<span>{$i18n.t('nav.joinWithAddress')}</span>{/if}
      </button>
      <a
        href={resolve('/explore')}
        onclick={() => onNavigate?.('/explore')}
        aria-label={collapsed ? $i18n.t('nav.exploreSpaces') : undefined}
      >
        <span class="action-icon" aria-hidden="true"><CompassIcon /></span>
        {#if !collapsed}<span>{$i18n.t('nav.exploreSpaces')}</span>{/if}
      </a>
      <button
        type="button"
        disabled
        aria-label={collapsed ? $i18n.t('nav.messageSearch') : undefined}
      >
        <span class="action-icon" aria-hidden="true"><MagnifyingGlassIcon /></span>
        {#if !collapsed}<span>{$i18n.t('nav.messageSearch')}</span>{/if}
      </button>
    </div>

    {#if !collapsed}
      <div class="rooms-heading">
        <span aria-hidden="true"><CaretDownIcon /></span>
        <h3>{$i18n.t('nav.rooms')}</h3>
      </div>

      <div class="empty-rooms">
        <p>{$i18n.t('nav.roomsUnavailable')}</p>
      </div>
    {/if}
  </div>
</section>

<style>
  .room-nav {
    background: var(--sable-bg-container);
    box-sizing: border-box;
    color: var(--sable-bg-on-container);
    display: flex;
    flex: 1;
    flex-direction: column;
    min-height: 0;
    min-width: 0;
  }

  .room-nav-header {
    align-items: center;
    display: flex;
    flex: 0 0 2.875rem;
    justify-content: space-between;
    min-height: 2.875rem;
    padding: 0 0.75rem 0 1rem;
  }

  h2,
  h3,
  p {
    margin: 0;
  }

  h2 {
    font-size: var(--font-size-large);
    line-height: var(--line-height-heading);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .overflow-button {
    align-items: center;
    background: transparent;
    border: 0;
    border-radius: var(--radius);
    color: inherit;
    cursor: pointer;
    display: flex;
    font: inherit;
    height: 2rem;
    justify-content: center;
    width: 2rem;
  }

  .overflow-button:hover,
  .overflow-button:focus-visible {
    background: var(--sable-bg-container-hover);
  }

  .room-nav-actions {
    display: grid;
    gap: 0.25rem;
    padding: 0.25rem 0.5rem 0.5rem;
  }

  .room-nav-actions :is(a, button) {
    align-items: center;
    background: transparent;
    border: 0;
    border-radius: var(--radius);
    color: inherit;
    cursor: pointer;
    display: flex;
    font-size: var(--font-size-small);
    font-weight: var(--font-weight-medium);
    gap: 0.5rem;
    height: 2rem;
    padding: 0 0.5rem;
    text-align: left;
    text-decoration: none;
  }

  .room-nav-actions :is(a, button):not(:disabled):hover,
  .room-nav-actions :is(a, button):not(:disabled):focus-visible {
    background: var(--sable-bg-container-hover);
  }

  .room-nav-actions button:disabled {
    cursor: default;
    opacity: 1;
  }

  .room-nav-header.collapsed {
    justify-content: center;
    padding: 0;
  }

  .room-nav-header.collapsed h2 {
    display: flex;
  }

  .room-nav-header.collapsed .overflow-button {
    display: none;
  }

  .room-nav-actions.collapsed {
    justify-items: center;
    padding: 0.25rem 0;
  }

  .room-nav-actions.collapsed :is(a, button) {
    justify-content: center;
    padding: 0;
    width: 2rem;
  }

  .room-nav-actions :global(svg),
  .rooms-heading :global(svg),
  .overflow-button :global(svg) {
    flex: 0 0 auto;
    height: 1rem;
    width: 1rem;
  }

  .room-nav-content {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
  }

  .rooms-heading {
    align-items: center;
    display: flex;
    gap: 0.25rem;
    padding: 0.75rem 1rem 0.5rem;
  }

  h3 {
    font-size: var(--font-size-small);
    font-weight: var(--font-weight-bold);
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }

  .empty-rooms {
    color: var(--sable-surface-var-on-container);
    font-size: var(--font-size-small);
    line-height: var(--line-height-body);
    padding: 0.5rem 1rem;
  }

  :is(.overflow-button, .room-nav-actions :is(a, button)):focus-visible {
    outline: 3px solid var(--sable-focus-ring);
    outline-offset: 2px;
  }

  @media (width >= 48rem) {
    .room-nav {
      flex: 0 0 var(--room-nav-width);
      width: var(--room-nav-width);
    }
  }
</style>
