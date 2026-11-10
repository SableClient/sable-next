<script lang="ts">
  import type { Component, Snippet } from 'svelte';
  import type { RoomListItemView } from '#src/generated/protocol';
  import { useCoreClient } from '#lib/core/context.js';
  import { i18n } from '#lib/i18n.js';
  import LockSimpleIcon from 'phosphor-svelte/lib/LockSimpleIcon';
  import DotsThreeVerticalIcon from 'phosphor-svelte/lib/DotsThreeVerticalIcon';
  import ActionMenu from '#lib/ui/primitives/ActionMenu.svelte';
  import Avatar from '#lib/ui/primitives/Avatar.svelte';
  import ResizeHandle from '#lib/ui/primitives/ResizeHandle.svelte';
  import { preferences, setPreference } from '#lib/settings/preferences.svelte.js';
  import { PREFERENCE_RANGES } from '#lib/settings/definitions.js';
  import { bannerChanges, readRoomBanner } from '#lib/features/room/room-banner.svelte.js';
  import Banner from '#lib/ui/primitives/Banner.svelte';

  interface Props {
    activeSpace: RoomListItemView | null;
    activeRoom: RoomListItemView | null;
    title: string;
    titleIcon: Component;
    collapsed: boolean;
    menuItems: Snippet;
  }

  let {
    activeSpace,
    activeRoom,
    title,
    titleIcon: TitleIcon,
    collapsed,
    menuItems,
  }: Props = $props();

  const core = useCoreClient();
  let activeSpaceId = $derived(activeSpace?.room_id ?? null);
  let activeRoomId = $derived(activeRoom?.room_id ?? null);

  let spaceBanner = $state<string | null>(null);
  let roomBanner = $state<string | null>(null);
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- a cache nothing renders from
  const banners = new Map<string, string | null>();

  function loadBanner(roomId: string | null, onLoad: (url: string | null) => void) {
    void bannerChanges.version;
    if (roomId === null) {
      onLoad(null);
      return;
    }

    let current = true;
    onLoad(banners.get(roomId) ?? null);
    void readRoomBanner(core, roomId).then((next) => {
      if (!current) return;
      banners.set(roomId, next);
      onLoad(next);
    });
    return () => {
      current = false;
    };
  }

  // Keep the space banner ready as a fallback without reloading it on every room switch.
  $effect(() => loadBanner(activeSpaceId, (next) => (spaceBanner = next)));
  $effect(() => loadBanner(activeRoomId, (next) => (roomBanner = next)));

  let banner = $derived(roomBanner ?? spaceBanner);
  let bannerName = $derived(roomBanner !== null ? (activeRoom?.display_name ?? title) : title);
  let bannerShown = $derived(banner !== null && !collapsed && preferences.showRoomBanners);
  const { min, max } = PREFERENCE_RANGES.roomBannerHeight;
</script>

<div class="room-nav-top">
  {#if bannerShown && banner}
    <div class="room-banner" style:height={`${preferences.roomBannerHeight}px`}>
      <Banner source={banner} name={bannerName} width={640} height={190} />
      <ResizeHandle
        value={preferences.roomBannerHeight}
        {min}
        {max}
        label={i18n.t('nav.resizeRooms')}
        grow="down"
        step={16}
        shiftStep={64}
        onResize={(next) => setPreference('roomBannerHeight', Math.max(min, Math.min(max, next)))}
      />
    </div>
  {/if}
  <header class={['room-nav-header', { collapsed, 'on-banner': bannerShown }]}>
    <h2 aria-label={collapsed ? title : undefined}>
      {#if collapsed}
        <ActionMenu label={i18n.t('nav.listOptions')} side="right" align="start">
          {#snippet trigger({ props })}
            <button
              {...props}
              type="button"
              class="room-nav-badge selection-open"
              aria-label={i18n.t('nav.listOptions')}
            >
              {#if activeSpace}
                <Avatar
                  id={activeSpace.room_id}
                  src={activeSpace.display_avatar_url}
                  name={title}
                  size="small"
                />
              {:else}
                <TitleIcon />
              {/if}
            </button>
          {/snippet}
          {@render menuItems()}
        </ActionMenu>
      {:else}
        {title}
      {/if}
    </h2>
    {#if !collapsed}
      <div class="room-nav-header-actions">
        {#if activeSpace && activeSpace.join_rule !== 'public'}
          <span
            class="title-lock"
            role="img"
            aria-label={i18n.t(`room.joinRule.${activeSpace.join_rule}`)}
          >
            <LockSimpleIcon />
          </span>
        {/if}
        <ActionMenu label={i18n.t('nav.listOptions')}>
          {#snippet trigger({ props })}
            <button
              {...props}
              type="button"
              class="room-nav-menu selection-open"
              aria-label={i18n.t('nav.listOptions')}
            >
              <DotsThreeVerticalIcon />
            </button>
          {/snippet}
          {@render menuItems()}
        </ActionMenu>
      </div>
    {/if}
  </header>
</div>

<style>
  .room-nav-top {
    flex: none;
    position: relative;
  }

  .room-banner {
    overflow: hidden;
    position: relative;
  }

  .room-banner :global(.resize-handle) {
    bottom: 0;
    z-index: 1;
  }

  .room-banner :global(.room-banner-image),
  .room-banner :global(.banner-button),
  .room-banner :global(img) {
    display: block;
    height: 100%;
    object-fit: cover;
    width: 100%;
  }

  .room-nav-header {
    align-items: center;
    display: flex;
    flex: 0 0 var(--header-height);
    gap: var(--space-100);
    justify-content: space-between;
    min-height: var(--header-height);
    padding: 0 var(--space-300) 0 var(--space-400);
  }

  .room-nav-header.on-banner {
    background: linear-gradient(180deg, var(--media-scrim-solid) 0%, var(--media-scrim-clear) 100%);
    color: var(--media-on-scrim);
    left: 0;
    position: absolute;
    right: 0;
    top: 0;
  }

  .room-nav-header.on-banner :global(.room-nav-menu) {
    color: inherit;
  }

  .room-nav-header.on-banner :global(.room-nav-menu:hover),
  .room-nav-header.on-banner :global(.room-nav-menu[data-state='open']) {
    background: var(--media-scrim-hover);
    color: inherit;
  }

  .room-nav-header-actions {
    align-items: center;
    display: flex;
    flex: none;
    gap: var(--space-100);
  }

  h2 {
    font-size: var(--font-size-heading);
    line-height: var(--line-height-heading);
    margin: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  :global(.room-nav-badge) {
    align-items: center;
    background: transparent;
    border: 0;
    border-radius: var(--radius);
    color: inherit;
    cursor: pointer;
    display: inline-flex;
    justify-content: center;
    padding: 0;
  }

  :global(.room-nav-badge svg) {
    height: var(--icon-size-medium);
    width: var(--icon-size-medium);
  }

  :global(.room-nav-badge:focus-visible) {
    outline: var(--focus-ring-width) solid var(--focus-ring);
    outline-offset: 2px;
  }

  .title-lock {
    align-items: center;
    display: inline-flex;
    flex: none;
    opacity: var(--opacity-p300);
  }

  .title-lock :global(svg) {
    height: var(--size-x200);
    width: var(--size-x200);
  }

  :global(.room-nav-menu) {
    align-items: center;
    background: transparent;
    border: 0;
    border-radius: var(--radius);
    color: var(--surface-var-on-container);
    cursor: pointer;
    display: inline-flex;
    flex: none;
    height: 1.75rem;
    justify-content: center;
    padding: 0;
    width: 1.75rem;
  }

  :global(.room-nav-menu:hover) {
    background: var(--bg-container-hover);
    color: var(--bg-on-container);
  }

  :global(.room-nav-menu:focus-visible) {
    outline: var(--focus-ring-width) solid var(--focus-ring);
    outline-offset: var(--focus-ring-offset);
  }

  :global(.room-nav-menu svg) {
    height: var(--icon-size-small);
    width: var(--icon-size-small);
  }

  .room-nav-header.collapsed {
    justify-content: center;
    padding: 0;
  }

  .room-nav-header.collapsed h2 {
    display: flex;
  }
</style>
