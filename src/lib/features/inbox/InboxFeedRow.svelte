<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { ClassValue } from 'svelte/elements';

  import { roomSectionPath } from '#lib/rooms/permalink.js';
  import { useRoomList } from '#lib/rooms/room-list.svelte.js';
  import Avatar from '#lib/ui/primitives/Avatar.svelte';

  interface Props {
    roomId: string;
    eventId: string;
    name: string;
    class?: ClassValue;
    children: Snippet;
    trailing: Snippet;
    message?: Snippet;
  }

  let { roomId, eventId, name, class: className, children, trailing, message }: Props = $props();
  const roomList = useRoomList();

  let avatarUrl = $derived(roomList.byId(roomId)?.avatar_url ?? null);
</script>

<li class={className}>
  <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- roomSectionPath resolves the route itself -->
  <a class="row" href={roomSectionPath(roomList.rooms, roomId, eventId)}>
    <Avatar id={roomId} src={avatarUrl} {name} />
    <span class="body">
      {@render children()}
    </span>
  </a>
  {@render trailing()}
  {#if message}
    <div class="message">{@render message()}</div>
  {/if}
</li>

<style>
  li {
    align-items: center;
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-200);
    padding-right: var(--space-300);
  }

  li:not(:first-child) {
    border-top: var(--border-width) solid var(--bg-container-line);
  }

  @media (hover: hover) and (pointer: fine) {
    li:hover {
      background: var(--bg-container-hover);
    }
  }

  .row {
    align-items: center;
    color: inherit;
    display: flex;
    flex: 1;
    gap: var(--space-300);
    min-width: 0;
    padding: var(--space-300) var(--space-400);
    text-decoration: none;
  }

  .row:focus-visible {
    outline: var(--focus-ring-width) solid var(--focus-ring);
    outline-offset: calc(var(--focus-ring-width) * -1);
  }

  .message {
    flex: 1 0 100%;
    min-width: 0;
    padding: 0 0 var(--space-200) var(--space-400);
  }

  .body {
    display: grid;
    flex: 1;
    gap: var(--space-100);
    min-width: 0;
  }

  @media (prefers-reduced-motion: no-preference) {
    .row {
      transition: background var(--motion-fast) var(--motion-easing-standard);
    }
  }

  @media (pointer: coarse) {
    li :global(.icon-button) {
      min-height: 2.75rem;
      min-width: 2.75rem;
    }
  }
</style>
