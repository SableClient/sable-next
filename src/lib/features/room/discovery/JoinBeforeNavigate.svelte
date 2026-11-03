<script lang="ts">
  import PageTitle from '#lib/ui/primitives/PageTitle.svelte';
  import { goto } from '$app/navigation';
  import { untrack } from 'svelte';

  import type { RoomPreviewView, RoomStateView } from '#src/generated/protocol';

  import { useCoreClient } from '#lib/core/context.js';
  import { joinRoom, knockRoom } from '#lib/core/api/rooms.js';
  import { i18n } from '#lib/i18n.js';
  import { CoreError } from '#src/transport';
  import { bannedMessage } from '#lib/rooms/join-errors.js';
  import { joinVia, roomSectionPath } from '#lib/rooms/permalink.js';
  import { useRoomList } from '#lib/rooms/room-list.svelte.js';
  import { childRouting } from '#lib/rooms/spaces.js';
  import Avatar from '#lib/ui/primitives/Avatar.svelte';
  import Button from '#lib/ui/primitives/Button.svelte';
  import Spinner from '#lib/ui/primitives/Spinner.svelte';
  import TextInput from '#lib/ui/primitives/TextInput.svelte';
  import FormattedBody from '../messages/FormattedBody.svelte';
  import { topicToHtml } from '#lib/model/model.js';
  import { scrollHint } from '#lib/ui/scroll-hint.js';
  import RoomIcon from '#lib/ui/primitives/RoomIcon.svelte';
  import UserIcon from 'phosphor-svelte/lib/UserIcon';
  import LinkSimpleIcon from 'phosphor-svelte/lib/LinkSimpleIcon';
  import CircleDashedIcon from 'phosphor-svelte/lib/CircleDashedIcon';
  import PanelHeader from '#lib/ui/primitives/PanelHeader.svelte';
  import PanelHeaderButton from '#lib/ui/primitives/PanelHeaderButton.svelte';
  import BackIcon from 'phosphor-svelte/lib/CaretLeftIcon';
  import { backToRoomList } from '../room-navigation';
  import { AppLayout } from '#lib/ui/app-layout.svelte.js';
  import DoorIcon from 'phosphor-svelte/lib/DoorIcon';
  import DoorOpenIcon from 'phosphor-svelte/lib/DoorOpenIcon';
  import SealQuestionIcon from 'phosphor-svelte/lib/SealQuestionIcon';
  import SealCheckIcon from 'phosphor-svelte/lib/SealCheckIcon';
  import Tooltip from '#lib/ui/primitives/Tooltip.svelte';

  interface Props {
    roomId: string;
    eventId?: string | null;
    via?: string[];
    membership?: RoomStateView;
  }

  let { roomId, eventId = null, via = [], membership }: Props = $props();

  const core = useCoreClient();
  const roomList = useRoomList();
  const appLayout = new AppLayout();

  let preview = $state<RoomPreviewView | null>(null);
  let failed = $state(false);
  let busy = $state(false);
  let sentKnock = $state(false);
  let withdrew = $state(false);
  let reason = $state('');
  let failedAction = $state<'join' | 'knock' | 'withdraw' | null>(null);
  const reasonId = $props.id();

  let title = $derived(preview?.name ?? roomId);
  let localServer = $derived(core.session?.user_id.split(':').slice(1).join(':') ?? null);

  $effect(() => {
    const address = roomId;
    void listedKey;
    let active = true;
    preview = null;
    failed = false;

    core.rpc.rooms
      .preview({
        address,
        via: [...untrack(() => selectedVias)],
      })
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
  let currentMembership = $derived(membership ?? preview?.state ?? 'left');
  let invited = $derived(currentMembership === 'invited');
  let joinBanned = $state(false);
  let banReason = $state<string | null>(null);
  let banned = $derived(currentMembership === 'banned' || joinBanned);
  let mustKnock = $derived(preview?.join_rule === 'knock' && !invited);
  let restricted = $derived(
    preview?.join_rule === 'restricted' || preview?.join_rule === 'knock_restricted'
  );
  let canKnock = $derived(mustKnock || (preview?.join_rule === 'knock_restricted' && !invited));
  let offerKnock = $derived(mustKnock || (canKnock && !invited && failedAction === 'join'));
  let knocked = $derived((currentMembership === 'knocked' && !withdrew) || (sentKnock && !invited));

  let parent = $derived(childRouting(roomList.rooms, roomId));
  let selectedVias = $derived(via.length > 0 ? via : parent.via);
  let listedKey = $derived(selectedVias.join(','));

  let provenanceTooltip = $derived.by(() => {
    const origin = preview?.via;
    if (!origin || origin.type === 'client') return '';
    return i18n.t(
      origin.type === 'unknown'
        ? 'join.uncertainProvenanceTooltip'
        : localServer && origin.server === localServer
          ? 'join.trustedProvenanceTooltip'
          : 'join.untrustedProvenanceTooltip',
      { server: origin.type === 'remote' ? origin.server : undefined }
    );
  });

  // The alias resolves on servers that have never seen the room id.
  let address = $derived(preview?.canonical_alias ?? roomId);

  function routingFor(): Promise<string[]> {
    return joinVia(core, selectedVias, parent.parentId);
  }

  async function join(): Promise<void> {
    if (busy) return;
    busy = true;
    failedAction = null;
    try {
      const joined = await joinRoom(core.rpc, address, await routingFor());
      const target = roomSectionPath(roomList.rooms, joined, eventId);
      // eslint-disable-next-line svelte/no-navigation-without-resolve -- roomSectionPath() resolves the route itself
      await goto(target, { replace: true });
    } catch (error) {
      console.warn('[sable room] join failed', error);
      if (error instanceof CoreError && error.detail.code === 'banned') {
        banReason = error.detail.reason;
        joinBanned = true;
      } else {
        failedAction = 'join';
      }
    } finally {
      busy = false;
    }
  }

  async function knock(): Promise<void> {
    if (busy) return;
    busy = true;
    failedAction = null;
    try {
      await knockRoom(core.rpc, address, await routingFor(), reason.trim() || undefined);
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
      await core.rpc.rooms.leave({ room_id: preview.room_id });
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

<PageTitle title={preview?.name ?? i18n.t('a11y.loading')} />

<div class="wrapper" data-inset-owner="top">
  {#if !appLayout.current}
    <PanelHeader class="mobile-back-bar" title={preview?.name ?? undefined}>
      {#snippet prefix()}
        <PanelHeaderButton
          class="back-button"
          label={i18n.t('timeline.back')}
          onclick={backToRoomList}
        >
          <BackIcon />
        </PanelHeaderButton>
      {/snippet}
    </PanelHeader>
  {/if}

  <div class="join-container">
    {#if preview === null && !failed}
      <div role="status"><Spinner /></div>
    {:else}
      <main class="join" aria-labelledby="join-title">
        <div class="join-header">
          <div class="join-avatar">
            {#snippet failedFallback()}
              <CircleDashedIcon />
            {/snippet}
            <Avatar
              color={failed ? 'var(--crit-main)' : undefined}
              id={roomId}
              src={preview?.avatar_url}
              name={title}
              size="large"
              children={failed ? failedFallback : undefined}
            />
          </div>
          {#if !failed}
            <span class="join-title-icon" aria-hidden="true">
              <RoomIcon
                roomKind={preview?.room_kind ?? null}
                joinRule={preview?.join_rule ?? null}
              />
            </span>
          {/if}
          <h1 class="join-title" class:failed>
            {title}
          </h1>
          {#if preview?.num_joined_members != null}
            <div class="join-members-icon">
              <UserIcon />
            </div>
            <p class="join-members">
              {i18n.t('join.members', { count: preview.num_joined_members })}
            </p>
          {/if}
          {#if preview?.canonical_alias}
            <div class="join-address-icon">
              <LinkSimpleIcon />
            </div>
            <p class="join-address">{preview.canonical_alias}</p>
          {/if}
          {#if invited}
            <div class="join-invite-icon">
              <DoorOpenIcon />
            </div>
            <p class="join-invite">{i18n.t('join.invited')}</p>
          {/if}
          {#if mustKnock}
            <div class="join-knock-icon">
              <DoorIcon />
            </div>
            <p class="join-knock">{i18n.t('join.knockRequired')}</p>
          {:else if restricted}
            <div class="join-knock-icon">
              <DoorIcon />
            </div>
            <div class="join-knock">
              <p>{i18n.t('join.restricted')}</p>
              {#if canKnock}
                <p class="hint">{i18n.t('join.restrictedKnockAvailable')}</p>
              {/if}
            </div>
          {/if}
        </div>
        {#if failed}
          <p role="alert">{i18n.t('join.unavailable', { room: roomId })}</p>
        {/if}
        {#if knocked}
          <p role="status">{i18n.t('join.knockSent')}</p>
        {/if}
        {#if preview?.topic}
          <div class="join-topic" {@attach scrollHint}>
            <FormattedBody html={preview.topic_html ?? topicToHtml(preview.topic)} />
          </div>
        {/if}
        {#if failedAction}
          <p role="alert" style:color="var(--crit-main)">
            {i18n.t(
              failedAction === 'knock'
                ? 'join.knockFailed'
                : failedAction === 'withdraw'
                  ? 'join.withdrawFailed'
                  : preview?.join_rule === 'restricted'
                    ? 'join.restrictedFailed'
                    : preview?.join_rule === 'knock_restricted'
                      ? 'join.restrictedKnockRequired'
                      : 'common.roomJoinFailed'
            )}
          </p>
        {/if}
        {#if banned}
          <p role="alert" style:color="var(--crit-main)">
            {bannedMessage(banReason)}
          </p>
        {/if}
        {#if !failed && !banned}
          <div class="action">
            {#if knocked}
              <Button variant="danger" onclick={() => void withdraw()} disabled={busy}>
                {busy ? i18n.t('join.withdrawing') : i18n.t('join.withdraw')}
              </Button>
            {:else}
              {#if offerKnock}
                <form
                  class="knock"
                  onsubmit={(event) => {
                    event.preventDefault();
                    void knock();
                  }}
                >
                  <label for={reasonId}>{i18n.t('join.knockReason')}</label>
                  <TextInput id={reasonId} bind:value={reason} maxlength={500} autocomplete="off" />
                  <Button type="submit" variant="secondary" disabled={busy}>
                    {busy ? i18n.t('join.knocking') : i18n.t('common.askToJoin')}
                  </Button>
                </form>
              {:else if !mustKnock}
                <Button onclick={() => void join()} disabled={busy}>
                  {busy && !offerKnock ? i18n.t('join.joining') : i18n.t('common.join')}
                </Button>
              {/if}
            {/if}
          </div>
        {/if}

        {#if preview && preview.via.type !== 'client'}
          <Tooltip align="center" side="bottom" label={provenanceTooltip}>
            {#snippet trigger({ props })}
              {#if preview && preview.via.type !== 'client'}
                <div {...props} class="provenance">
                  {#if preview.via.type === 'unknown'}
                    <SealQuestionIcon />
                    <span>{i18n.t('join.uncertainProvenance')}</span>
                  {:else if localServer && preview.via.server === localServer}
                    <SealCheckIcon />
                    <span>{i18n.t('join.provenance', { server: localServer })}</span>
                  {:else}
                    <SealQuestionIcon />
                    <span>{i18n.t('join.provenance', { server: preview.via.server })}</span>
                  {/if}
                </div>
              {/if}
            {/snippet}
          </Tooltip>
        {/if}
      </main>
    {/if}
  </div>
</div>

<style>
  .wrapper {
    width: 100%;
  }

  .wrapper > :global(.mobile-back-bar) {
    /* to keep the preview card centered */
    position: absolute;
    width: 100vw;
  }

  .join-container {
    align-items: center;
    background-image: radial-gradient(
      40% 40vh at 0% 100%,
      var(--primary-container) 0%,
      transparent 100%
    );
    box-sizing: border-box;
    display: flex;
    flex: 1;
    flex-direction: column;
    justify-content: center;
    min-height: 100%;
    min-width: 0;
    padding: var(--space-700) var(--space-600);

    @media (--compact-layout) {
      background-image: linear-gradient(to top, var(--primary-container) 0%, transparent 30%);
    }
  }

  .join {
    background: var(--bg-container);
    border: var(--border-width) solid var(--bg-container-line);
    border-radius: var(--radius);
    box-shadow: var(--shadow-float);
    color: var(--bg-on-container);
    display: flex;
    flex-direction: column;
    gap: var(--space-300);
    justify-content: safe center;
    padding: var(--space-400);
    width: min(100%, 32rem);
  }

  .join p {
    margin: 0;
  }

  .join-header {
    align-items: center;
    display: grid;
    grid-template-areas:
      'avatar . title-icon . title'
      'avatar . members-icon . members'
      'avatar . address-icon . address'
      'avatar . invite-icon . invite'
      'avatar . knock-icon . knock';
    grid-template-columns: min-content var(--space-400) min-content var(--space-100) 1fr;
  }

  .join-header :global(div > svg) {
    color: var(--surface-var-on-container);
    vertical-align: middle;
  }

  .join-header p {
    color: var(--surface-var-on-container);
    font-size: var(--font-size-label);
    margin: 0;
  }

  .join-avatar {
    grid-area: avatar;
    height: 100%;
    position: relative;
  }

  .join-avatar::after {
    background-color: var(--surface-container-line);
    content: '';
    height: 100%;
    position: absolute;
    transform: translateX(calc((var(--space-400) + 3.5px) / 2));
    width: 1px;
  }

  .join-title-icon {
    grid-area: title-icon;
    justify-self: center;
  }

  .join-title-icon > :global(span) {
    vertical-align: middle;
    width: min-content;
  }

  .join-title-icon :global(span .room-icon-composite > svg),
  .join-title-icon > :global(span > svg) {
    height: var(--icon-size-medium);
    width: var(--icon-size-medium);
  }

  .join-title {
    display: flex;
    font-size: var(--font-size-heading);
    gap: var(--space-100);
    grid-area: title;
    line-height: var(--line-height-heading);
    margin: 0;
    word-break: normal;
  }

  .join-title.failed {
    word-break: break-all;
  }

  .join-members-icon {
    grid-area: members-icon;
    justify-self: center;
  }

  .join-members {
    grid-area: members;
  }

  .join-address-icon {
    grid-area: address-icon;
    justify-self: center;
  }

  .join-address {
    grid-area: address;
  }

  .join-invite-icon {
    grid-area: invite-icon;
    justify-self: center;
  }

  .join-invite {
    grid-area: invite;
  }

  .join-knock-icon {
    grid-area: knock-icon;
    place-self: start center;
    transform: translateY(-1px);
  }

  .join-knock {
    grid-area: knock;
  }

  .join-knock .hint {
    color: var(--sec-main);
    font-size: var(--font-size-small);
  }

  @media (prefers-reduced-motion: no-preference) {
    :global(html:not([data-reduced-motion='on'])) .join {
      animation: dialog-in var(--duration-medium) var(--ease-smooth-out);
    }
  }

  @keyframes dialog-in {
    from {
      opacity: 0;
      transform: scale(var(--scale-enter));
    }
  }

  .knock {
    display: grid;
    gap: var(--space-200);
    grid-template-areas:
      'label label'
      'message submit';
    grid-template-columns: 1fr auto;

    label {
      font-size: var(--font-size-label);
      grid-area: label;
    }

    :global(input) {
      grid-area: message;
    }

    :global(button) {
      grid-area: submit;
    }
  }

  .join-topic {
    border-bottom: var(--border-width) solid var(--bg-container-line);
    box-sizing: border-box;
    line-height: var(--line-height-body);
    max-height: 20dvh;
    overflow-wrap: anywhere;
    overflow-y: auto;
    padding-bottom: var(--space-300);
    scrollbar-width: thin;
    text-align: start;
  }

  .action {
    & > :global(button) {
      width: 100%;
    }
  }

  .join-topic :global(p:first-child) {
    margin-block-start: 0;
  }

  .join-topic :global(p:last-child) {
    margin-block-end: 0;
  }

  .provenance {
    color: var(--sec-main);
    cursor: help;
    display: flex;
    font-size: var(--font-size-small);
    gap: var(--space-100);
    width: fit-content;

    :global(svg) {
      height: var(--size-x100);
      width: var(--size-x100);
    }
  }
</style>
