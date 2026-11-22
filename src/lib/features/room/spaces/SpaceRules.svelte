<script lang="ts">
  import type { RoomListItemView, RoomRulesView } from '#src/generated/protocol';

  import BackIcon from 'phosphor-svelte/lib/CaretLeftIcon';

  import { useCoreClient } from '#lib/core/context.js';
  import { i18n } from '#lib/i18n.js';
  import { useRoomList } from '#lib/rooms/room-list.svelte.js';
  import { AppLayout } from '#lib/ui/app-layout.svelte.js';
  import { formatDate } from '#lib/ui/date-time.js';
  import Alert from '#lib/ui/primitives/Alert.svelte';
  import Avatar from '#lib/ui/primitives/Avatar.svelte';
  import Button from '#lib/ui/primitives/Button.svelte';
  import IconButton from '#lib/ui/primitives/IconButton.svelte';
  import Spinner from '#lib/ui/primitives/Spinner.svelte';

  import FormattedBody from '../messages/FormattedBody.svelte';
  import { backToRoomList } from '../room-navigation.js';

  interface Props {
    space: RoomListItemView | null;
  }

  let { space }: Props = $props();
  const core = useCoreClient();
  const roomList = useRoomList();
  const appLayout = new AppLayout();

  let spaceId = $derived(space?.room_id ?? null);
  let view = $state.raw<RoomRulesView | null>(null);
  let status = $state<'loading' | 'ready' | 'failed'>('loading');
  let sourceName = $derived(
    view && view.source_room_id !== spaceId ? roomList.labelFor(view.source_room_id) : null
  );

  async function load(target: string): Promise<void> {
    status = 'loading';
    try {
      const next = await core.rpc.room_state.rules({ room_id: target });
      if (spaceId !== target) return;
      view = next;
      status = 'ready';
    } catch (error) {
      if (spaceId !== target) return;
      status = 'failed';
      console.debug('[sable room] rules unavailable', error);
    }
  }

  $effect(() => {
    const target = spaceId;
    view = null;
    status = 'loading';
    if (target === null) return;

    void load(target);
    return core.subscribeEvents((event) => {
      if (event.type === 'room_rules_changed') void load(target);
    });
  });
</script>

<section class="rules" aria-label={i18n.t('room.rulesTitle')}>
  {#if space !== null}
    <header class="hero">
      {#if !appLayout.current}
        <div class="mobile-back-menu">
          <IconButton
            variant="ghost"
            size="small"
            label={i18n.t('timeline.back')}
            onclick={backToRoomList}
          >
            <BackIcon class="mirror-rtl" />
          </IconButton>
        </div>
      {/if}
      <Avatar
        id={space.room_id}
        src={space.avatar_url}
        openable={true}
        name={space.name ?? ''}
        size="large"
        uniform
        autoplay
      />
      <h1>{space.name ?? i18n.t('nav.space')}</h1>
      {#if space.topic}
        <p class="topic">{space.topic}</p>
      {/if}
      {#if view?.updated_at != null}
        <p class="rules-updated">
          {i18n.t('room.rulesUpdated', { date: formatDate(view.updated_at) })}
        </p>
      {/if}
      {#if sourceName !== null}
        <p class="delegated">{i18n.t('room.rulesFromSpace', { name: sourceName })}</p>
      {/if}
    </header>
  {/if}

  {#if view !== null}
    <div class="rules-body">
      <FormattedBody html={view.html} />
    </div>
  {:else if status === 'loading'}
    <Spinner label={i18n.t('a11y.loading')} />
  {:else if status === 'failed'}
    <Alert variant="critical" role="alert">
      <p>{i18n.t('room.rulesUnavailable')}</p>
      {#if spaceId !== null}
        {@const target = spaceId}
        <div>
          <Button variant="secondary" size="small" onclick={() => void load(target)}>
            {i18n.t('common.retry')}
          </Button>
        </div>
      {/if}
    </Alert>
  {:else}
    <p class="empty">{i18n.t('room.rulesNone')}</p>
  {/if}
</section>

<style>
  .rules {
    display: grid;
    gap: var(--space-400);
    grid-template-columns: minmax(0, 1fr);
  }

  .hero {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    justify-items: center;
    padding: var(--space-500) 0 var(--space-100);
    position: relative;
    text-align: center;
  }

  .mobile-back-menu {
    inset-inline-start: 0;
    position: absolute;
    top: var(--space-300);
  }

  h1 {
    font-size: var(--font-size-heading);
    line-height: var(--line-height-heading);
    margin: var(--space-300) 0 0;
    overflow-wrap: anywhere;
  }

  .topic {
    -webkit-box-orient: vertical;
    color: var(--surface-var-on-container);
    display: -webkit-box;
    -webkit-line-clamp: 3;
    line-clamp: 3;
    margin: var(--space-200) 0 0;
    max-width: 48ch;
    overflow: hidden;
    overflow-wrap: anywhere;
    white-space: pre-wrap;
  }

  .delegated,
  .rules-updated {
    color: var(--surface-var-on-container);
    font-size: var(--font-size-small);
    margin: var(--space-200) 0 0;
  }

  .rules-updated {
    font-style: italic;
  }

  .rules-body {
    overflow-wrap: anywhere;
  }

  .empty {
    color: var(--surface-var-on-container);
    margin: 0;
  }
</style>
