<script lang="ts">
  import type { Component } from 'svelte';
  import type { RoomSummary } from '@/generated/RoomSummary';
  import type { Pathname } from '$app/types';
  import { resolve } from '$app/paths';
  import { page } from '$app/state';
  import { i18n } from '$lib/i18n';
  import { roomPathParam } from '$lib/rooms/room-list.svelte';
  import Tooltip from '$lib/ui/primitives/Tooltip.svelte';
  import MediaImage from '$lib/ui/MediaImage.svelte';
  import ChatsIcon from 'phosphor-svelte/lib/ChatsIcon';
  import HouseIcon from 'phosphor-svelte/lib/HouseIcon';
  import MagnifyingGlassIcon from 'phosphor-svelte/lib/MagnifyingGlassIcon';
  import PlusIcon from 'phosphor-svelte/lib/PlusIcon';

  type RailItem = {
    href: string;
    activePrefix: string;
    label: string;
    route?: Pathname;
    icon?: Component;
    initial?: string;
    avatar?: string | null;
    navigateHref?: string;
  };

  interface Props {
    spaces: readonly RoomSummary[];
    mobile?: boolean;
    onNavigate?: (href: string) => void;
  }

  let { spaces, mobile = false, onNavigate }: Props = $props();

  const items: readonly RailItem[] = [
    {
      href: resolve('/home'),
      activePrefix: '/home',
      icon: HouseIcon,
      label: 'nav.home',
      route: '/home',
    },
    {
      href: resolve('/navigate'),
      activePrefix: '/navigate',
      icon: MagnifyingGlassIcon,
      label: 'nav.navigate',
      route: '/navigate',
    },
    {
      href: resolve('/direct'),
      activePrefix: '/direct',
      icon: ChatsIcon,
      label: 'nav.direct',
      route: '/direct',
    },
  ];

  let spaceItems = $derived.by<RailItem[]>(() =>
    spaces.map((space) => {
      const name = spaceName(space.name, space.room_id);
      const href = resolve('/(app)/space/[spaceId]', { spaceId: roomPathParam(space) });

      return {
        href,
        activePrefix: href,
        navigateHref: href,
        initial: initial(name),
        avatar: space.avatar_url,
        label: name,
      };
    })
  );

  const createItem: RailItem = {
    href: resolve('/create-room'),
    activePrefix: '/create-room',
    icon: PlusIcon,
    label: 'nav.createRoom',
    route: '/create-room',
  };

  function spaceName(name: string | null, roomId: string): string {
    return name ?? roomId;
  }

  function initial(name: string): string {
    return name.slice(0, 1).toUpperCase();
  }

  function isActive(item: RailItem): boolean {
    if (item.initial) {
      return (
        page.url.pathname.startsWith(`${item.activePrefix}/`) ||
        page.url.pathname === item.activePrefix
      );
    }

    return page.url.pathname.startsWith(item.activePrefix);
  }

  function navigate(item: RailItem): void {
    onNavigate?.(item.navigateHref ?? item.href);
  }
</script>

{#if mobile}
  <div class="rail">
    <div class="rail-scroll">
      <ul class="rail-stack">
        {#each [...items, ...spaceItems] as item (item.href)}
          {@const active = isActive(item)}
          <li>
            <a
              class="rail-item sable-selection-layer"
              class:space-item={Boolean(item.initial)}
              class:active
              href={resolve((item.route ?? item.href) as Pathname)}
              onclick={() => {
                navigate(item);
              }}
              aria-label={$i18n.t(item.label)}
              aria-current={active ? 'page' : undefined}
            >
              {#if item.icon}
                <span class="icon" aria-hidden="true"
                  ><item.icon weight={active ? 'fill' : 'regular'} /></span
                >
              {:else}
                <span class="space-initial" aria-hidden="true">
                  {#if item.avatar}
                    <MediaImage
                      source={item.avatar}
                      alt=""
                      width={56}
                      height={56}
                      class="space-image"
                    />
                  {:else}
                    {item.initial}
                  {/if}
                </span>
              {/if}
            </a>
          </li>
        {/each}
      </ul>
      <div class="dynamic-rail-region" aria-hidden="true"></div>
    </div>
    <ul class="rail-stack rail-bottom">
      <li>
        <a
          class="rail-item sable-selection-layer"
          class:active={isActive(createItem)}
          href={resolve((createItem.route ?? createItem.href) as Pathname)}
          onclick={() => {
            navigate(createItem);
          }}
          aria-label={$i18n.t(createItem.label)}
          aria-current={isActive(createItem) ? 'page' : undefined}
        >
          <span class="icon" aria-hidden="true"
            ><PlusIcon weight={isActive(createItem) ? 'fill' : 'regular'} /></span
          >
        </a>
      </li>
    </ul>
  </div>
{:else}
  <div class="rail">
    <div class="rail-scroll">
      <ul class="rail-stack">
        {#each [...items, ...spaceItems] as item (item.href)}
          {@const active = isActive(item)}
          {@const label = $i18n.t(item.label)}
          <li>
            {#snippet trigger({ props }: { props: Record<string, unknown> })}
              <a
                {...props}
                class="rail-item sable-selection-layer"
                class:space-item={Boolean(item.initial)}
                class:active
                href={resolve((item.route ?? item.href) as Pathname)}
                aria-label={label}
                aria-current={active ? 'page' : undefined}
              >
                {#if item.icon}
                  <span class="icon" aria-hidden="true"
                    ><item.icon weight={active ? 'fill' : 'regular'} /></span
                  >
                {:else}
                  <span class="space-initial" aria-hidden="true">
                    {#if item.avatar}
                      <MediaImage
                        source={item.avatar}
                        alt=""
                        width={56}
                        height={56}
                        class="space-image"
                      />
                    {:else}
                      {item.initial}
                    {/if}
                  </span>
                {/if}
              </a>
            {/snippet}
            <Tooltip {label} side="right" {trigger} />
          </li>
        {/each}
      </ul>
      <div class="dynamic-rail-region" aria-hidden="true"></div>
    </div>
    <ul class="rail-stack rail-bottom">
      <li>
        {#snippet trigger({ props }: { props: Record<string, unknown> })}
          {@const label = $i18n.t(createItem.label)}
          <a
            {...props}
            class="rail-item sable-selection-layer"
            class:active={isActive(createItem)}
            href={resolve((createItem.route ?? createItem.href) as Pathname)}
            aria-label={label}
            aria-current={isActive(createItem) ? 'page' : undefined}
          >
            <span class="icon" aria-hidden="true"
              ><PlusIcon weight={isActive(createItem) ? 'fill' : 'regular'} /></span
            >
          </a>
        {/snippet}
        <Tooltip label={$i18n.t(createItem.label)} side="right" {trigger} />
      </li>
    </ul>
  </div>
{/if}

<style>
  .rail {
    background: var(--sable-bg-container);
    border-right: 1px solid var(--sable-bg-container-line);
    box-sizing: border-box;
    color: var(--sable-bg-on-container);
    display: flex;
    flex: 0 0 var(--navigation-rail-width);
    flex-direction: column;
    min-height: 0;
    width: var(--navigation-rail-width);
  }

  .rail-scroll {
    flex: 1;
    min-height: 0;
    overflow: hidden auto;
  }

  .dynamic-rail-region {
    border-top: 1px solid var(--sable-bg-container-line);
    margin: 0.25rem auto;
    width: 2rem;
  }

  .rail-stack {
    align-items: center;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    list-style: none;
    margin: 0;
    padding: 0.5rem 0;
  }

  .rail-scroll > .rail-stack,
  .rail-scroll > .dynamic-rail-region {
    transform: translateX(0.25rem);
  }

  .rail-bottom {
    gap: 0.5rem;
    padding: 0.5rem 0 0.75rem;
  }

  .rail-item {
    align-items: center;
    border-radius: var(--radius);
    color: inherit;
    display: flex;
    height: 2.625rem;
    justify-content: center;
    position: relative;
    width: 2.625rem;
  }

  .rail-item::before {
    background: currentcolor;
    border-radius: 0 0.25rem 0.25rem 0;
    content: '';
    height: 1.5rem;
    left: -0.75rem;
    position: absolute;
    transform: translateX(-50%);
    width: 3px;
  }

  .rail-item:not(.active)::before {
    display: none;
  }

  .rail-item:hover {
    background: var(--sable-bg-container-hover);
  }

  .rail-item.active {
    color: var(--sable-bg-on-container);
  }

  .icon {
    display: flex;
  }

  .space-initial {
    align-items: center;
    background: var(--sable-surface-var-container);
    border-radius: var(--radius);
    display: flex;
    font-size: var(--font-size-small);
    font-weight: var(--font-weight-bold);
    height: var(--avatar-size-small);
    justify-content: center;
    overflow: hidden;
    width: var(--avatar-size-small);
  }

  :global(.space-image) {
    height: 100%;
    width: 100%;
  }

  :global(.space-image .media-image-content) {
    object-fit: cover;
    object-position: center;
  }

  .icon :global(svg) {
    height: var(--icon-size-medium);
    width: var(--icon-size-medium);
  }

  .rail-item:focus-visible {
    outline: var(--focus-ring-width) solid var(--sable-focus-ring);
    outline-offset: 2px;
  }

  @media (prefers-reduced-motion: no-preference) {
    .rail-item {
      transition:
        border-color var(--motion-normal) var(--motion-easing-standard),
        color var(--motion-normal) var(--motion-easing-standard);
    }
  }
</style>
