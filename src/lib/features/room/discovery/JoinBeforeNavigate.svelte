<script lang="ts">
  import { goto } from '$app/navigation';
  import { untrack } from 'svelte';

  import type { RoomPreviewView } from '#src/generated/protocol';

  import { useCoreClient } from '#lib/core/context.js';
  import { i18n } from '#lib/i18n.js';
  import { roomSectionPath, viaFor } from '#lib/rooms/permalink.js';
  import { useRoomList } from '#lib/rooms/room-list.svelte.js';
  import { childRouting } from '#lib/rooms/spaces.js';
  import Avatar from '#lib/ui/primitives/Avatar.svelte';
  import Button from '#lib/ui/primitives/Button.svelte';
  import Spinner from '#lib/ui/primitives/Spinner.svelte';
  import TextInput from '#lib/ui/primitives/TextInput.svelte';
  import FormattedBody from '../messages/FormattedBody.svelte';
  import { topicHtml } from '../topic-html';

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
  let withdrew = $state(false);
  let reason = $state('');
  let failedAction = $state<'join' | 'knock' | 'withdraw' | null>(null);
  const reasonId = $props.id();

  let title = $derived(preview?.name ?? roomId);

  $effect(() => {
    const address = roomId;
    void listedKey;
    let active = true;
    preview = null;
    failed = false;

    core.commands
      .roomPreview(
        address,
        viaFor(
          address,
          untrack(() => listed)
        )
      )
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
  let knocked = $derived((preview?.state === 'knocked' && !withdrew) || sentKnock);
  let offerKnock = $derived(mustKnock || (canKnock && failedAction === 'join'));

  let parent = $derived(childRouting(roomList.rooms, roomId));
  let listed = $derived(via.length > 0 ? via : parent.via);
  let listedKey = $derived(listed.join(','));

  // The alias resolves on servers that have never seen the room id.
  let address = $derived(preview?.canonical_alias ?? roomId);

  async function routingFor(): Promise<string[]> {
    const known = viaFor(address, listed);
    if (known.length > 0 || parent.parentId === null) return known;
    return core.commands.roomViaServers(parent.parentId);
  }

  async function join(): Promise<void> {
    if (busy) return;
    busy = true;
    failedAction = null;
    try {
      const joined = await core.commands.joinRoom(address, await routingFor());
      const target = roomSectionPath(roomList.rooms, joined, eventId);
      await goto(target, { replace: true });
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
      await core.commands.knockRoom(address, await routingFor(), reason.trim() || undefined);
      sentKnock = true;
    } catch (error) {
      console.warn('[sable room] knock failed', error);
      failedAction = 'knock';
    } finally {
      busy = false;
    }
  }

  async function withdraw(): Promise<void> {
    if (busy || !preview) return;
    busy = true;
    failedAction = null;
    try {
      await core.commands.leaveRoom(preview.room_id);
      sentKnock = false;
      withdrew = true;
    } catch (error) {
      console.warn('[sable room] withdrawing the knock failed', error);
      failedAction = 'withdraw';
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
    <Avatar id={roomId} src={preview.avatar_url} name={title} size="large" />
    <h1 id="join-title">{title}</h1>
    {#if preview.canonical_alias}
      <p class="join-address">{preview.canonical_alias}</p>
    {/if}
    <p class="join-members">
      {$i18n.t('join.members', { count: preview.num_joined_members })}
    </p>
    {#if preview.topic}
      <div class="join-topic"><FormattedBody html={topicHtml(preview.topic)} /></div>
    {/if}
    {#if failedAction}
      <p role="alert">
        {$i18n.t(
          failedAction === 'knock'
            ? 'join.knockFailed'
            : failedAction === 'withdraw'
              ? 'join.withdrawFailed'
              : 'join.failed'
        )}
      </p>
    {/if}

    {#if knocked}
      <p role="status">{$i18n.t('join.knockSent')}</p>
      <Button variant="ghost" onclick={() => void withdraw()} disabled={busy}>
        {busy ? $i18n.t('join.withdrawing') : $i18n.t('join.withdraw')}
      </Button>
    {:else}
      {#if !mustKnock}
        <Button onclick={() => void join()} disabled={busy}>
          {busy && !offerKnock ? $i18n.t('join.joining') : $i18n.t('join.action')}
        </Button>
      {/if}
      {#if offerKnock}
        <form
          class="knock"
          onsubmit={(event) => {
            event.preventDefault();
            void knock();
          }}
        >
          <label for={reasonId}>{$i18n.t('join.knockReason')}</label>
          <TextInput id={reasonId} bind:value={reason} maxlength={500} autocomplete="off" />
          <Button type="submit" variant={mustKnock ? 'secondary' : 'ghost'} disabled={busy}>
            {busy ? $i18n.t('join.knocking') : $i18n.t('join.knockAction')}
          </Button>
        </form>
      {/if}
    {/if}
  {/if}
</main>

<style>
  .join {
    align-items: center;
    box-sizing: border-box;
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: var(--space-300);
    justify-content: safe center;
    min-height: 100%;
    min-width: 0;
    padding: var(--space-700) var(--space-600);
    text-align: center;
  }

  .join h1 {
    font-size: var(--font-size-display);
    line-height: var(--line-height-heading);
    margin: var(--space-200) 0 0;
    overflow-wrap: anywhere;
  }

  .join p {
    color: var(--surface-var-on-container);
    margin: 0;
    max-width: 32rem;
  }

  .knock {
    display: grid;
    gap: var(--space-200);
    justify-items: center;
    text-align: start;
    width: min(100%, 24rem);
  }

  .knock label {
    color: var(--surface-var-on-container);
    font-size: var(--font-size-label);
    justify-self: start;
  }

  .join-address,
  .join-members {
    font-size: var(--font-size-label);
  }

  .join-members {
    margin-block-end: var(--space-200);
  }

  .join-topic {
    background: var(--surface-var-container);
    border-radius: var(--radius);
    box-sizing: border-box;
    line-height: var(--line-height-body);
    margin-block-end: var(--space-200);
    max-height: 40dvh;
    overflow-wrap: anywhere;
    overflow-y: auto;
    padding: var(--space-400) var(--space-500);
    scrollbar-width: thin;
    text-align: start;
    width: min(100%, 32rem);
  }

  .join-topic :global(p:first-child) {
    margin-block-start: 0;
  }

  .join-topic :global(p:last-child) {
    margin-block-end: 0;
  }
</style>
