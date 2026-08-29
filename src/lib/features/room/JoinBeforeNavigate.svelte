<script lang="ts">
  import { goto } from '$app/navigation';

  import type { RoomPreviewView } from '#src/generated/RoomPreviewView';

  import { useCoreClient } from '#lib/core/context.js';
  import { i18n } from '#lib/i18n.js';
  import { roomSectionPath, viaFor } from '#lib/rooms/permalink.js';
  import { useRoomList } from '#lib/rooms/room-list.svelte.js';
  import Avatar from '#lib/ui/primitives/Avatar.svelte';
  import Button from '#lib/ui/primitives/Button.svelte';
  import Spinner from '#lib/ui/primitives/Spinner.svelte';

  interface Props {
    roomId: string;
    eventId?: string | null;
    via?: string[];
  }

  let { roomId, eventId = null, via = [] }: Props = $props();

  const core = useCoreClient();
  const roomList = useRoomList();

  let preview = $state<RoomPreviewView | null>(null);
  let failed = $state(false);
  let busy = $state(false);
  let sentKnock = $state(false);
  let failedAction = $state<'join' | 'knock' | null>(null);

  let title = $derived(preview?.name ?? roomId);

  $effect(() => {
    const address = roomId;
    let active = true;
    preview = null;
    failed = false;

    core.commands
      .roomPreview(address, viaFor(address, via))
      .then((result) => {
        if (active) preview = result;
      })
      .catch((error: unknown) => {
        console.debug('[sable room] preview unavailable', error);
        if (active) failed = true;
      });

    return () => {
      active = false;
    };
  });

  /* `knock` admits nobody through /join, so the button has to ask instead.
     `knock_restricted` still lets a member of the allowed space straight in,
     so it tries joining first and offers to knock only once that is refused. */
  let mustKnock = $derived(preview?.join_rule === 'knock');
  let canKnock = $derived(mustKnock || preview?.join_rule === 'knock_restricted');
  let knocked = $derived(preview?.state === 'knocked' || sentKnock);

  // The alias resolves on servers that have never seen the room id.
  let address = $derived(preview?.canonical_alias ?? roomId);
  let routing = $derived(viaFor(address, via));

  async function join(): Promise<void> {
    if (busy) return;
    busy = true;
    failedAction = null;
    try {
      const joined = await core.commands.joinRoom(address, routing);
      const target = roomSectionPath(roomList.rooms, joined, eventId);
      await goto(target, { replaceState: true });
    } catch (error) {
      console.warn('[sable room] join failed', error);
      failedAction = 'join';
    } finally {
      busy = false;
    }
  }

  async function knock(): Promise<void> {
    if (busy) return;
    busy = true;
    failedAction = null;
    try {
      await core.commands.knockRoom(address, routing);
      sentKnock = true;
    } catch (error) {
      console.warn('[sable room] knock failed', error);
      failedAction = 'knock';
    } finally {
      busy = false;
    }
  }
</script>

<main class="join" aria-labelledby="join-title">
  {#if failed}
    <p role="alert">{$i18n.t('join.unavailable', { room: roomId })}</p>
  {:else if preview === null}
    <div role="status"><Spinner /></div>
  {:else}
    <Avatar src={preview.avatar_url} name={title} size="large" />
    <h1 id="join-title">{title}</h1>
    {#if preview.canonical_alias}
      <p class="join-address">{preview.canonical_alias}</p>
    {/if}
    <p class="join-members">
      {$i18n.t('join.members', { count: preview.num_joined_members })}
    </p>
    {#if preview.topic}
      <p class="join-topic">{preview.topic}</p>
    {/if}
    {#if failedAction}
      <p role="alert">
        {failedAction === 'knock' ? $i18n.t('join.knockFailed') : $i18n.t('join.failed')}
      </p>
    {/if}

    {#if knocked}
      <p role="status">{$i18n.t('join.knockSent')}</p>
    {:else if mustKnock}
      <Button onclick={() => void knock()} disabled={busy}>
        {busy ? $i18n.t('join.knocking') : $i18n.t('join.knockAction')}
      </Button>
    {:else}
      <Button onclick={() => void join()} disabled={busy}>
        {busy ? $i18n.t('join.joining') : $i18n.t('join.action')}
      </Button>
      {#if canKnock && failedAction === 'join'}
        <Button variant="ghost" onclick={() => void knock()} disabled={busy}>
          {$i18n.t('join.knockAction')}
        </Button>
      {/if}
    {/if}
  {/if}
</main>

<style>
  .join {
    align-items: center;
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    gap: var(--space-300);
    justify-content: center;
    min-height: 100%;
    padding: var(--space-700) var(--space-600);
    text-align: center;
  }

  .join h1 {
    font-size: var(--font-size-heading);
    margin: 0;
    overflow-wrap: anywhere;
  }

  .join p {
    color: var(--sable-surface-var-on-container);
    margin: 0;
    max-width: 32rem;
  }

  .join-topic {
    line-height: var(--line-height-body);
  }
</style>
