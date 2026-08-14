<script lang="ts">
  import type { MemberView } from '@/generated/MemberView';
  import type { ProfileView } from '@/generated/ProfileView';
  import { DropdownMenu } from 'bits-ui';
  import ArrowSquareOutIcon from 'phosphor-svelte/lib/ArrowSquareOutIcon';
  import CaretRightIcon from 'phosphor-svelte/lib/CaretRightIcon';
  import ClockIcon from 'phosphor-svelte/lib/ClockIcon';
  import CopyIcon from 'phosphor-svelte/lib/CopyIcon';
  import HeartIcon from 'phosphor-svelte/lib/HeartIcon';
  import DotsThreeIcon from 'phosphor-svelte/lib/DotsThreeIcon';
  import HardDrivesIcon from 'phosphor-svelte/lib/HardDrivesIcon';
  import PaperPlaneRightIcon from 'phosphor-svelte/lib/PaperPlaneRightIcon';
  import ProhibitIcon from 'phosphor-svelte/lib/ProhibitIcon';
  import ShareNetworkIcon from 'phosphor-svelte/lib/ShareNetworkIcon';
  import UserIcon from 'phosphor-svelte/lib/UserIcon';

  import { goto } from '$app/navigation';
  import { resolve } from '$app/paths';
  import type { MutualRoomView } from '@/generated/MutualRoomView';
  import { useCoreClient } from '$lib/core/context';
  import { i18n } from '$lib/i18n';
  import Alert from '$lib/ui/primitives/Alert.svelte';
  import IconButton from '$lib/ui/primitives/IconButton.svelte';
  import ProfileCard from '$lib/ui/primitives/ProfileCard.svelte';
  import TextInput from '$lib/ui/primitives/TextInput.svelte';

  import FormattedBody from './FormattedBody.svelte';
  import { senderColor } from './timeline-format';

  interface Props {
    userId: string;
    member: MemberView | null;
    profile: ProfileView | null;
    failed?: boolean;
    variant?: 'popover' | 'sheet';
  }

  let { userId, member, profile, failed = false, variant = 'popover' }: Props = $props();
  const core = useCoreClient();
  // Bounded at roughly one unclamped bio, so swapping the panel cannot make the
  // card taller than the profile it replaced.
  const mutualRoomsShown = 5;
  let currentProfile = $derived(profile?.user_id === userId ? profile : null);
  // A room member overrides their global profile for that room.
  let displayName = $derived(member?.display_name ?? currentProfile?.display_name ?? userId);
  let avatarUrl = $derived(member?.avatar_url ?? currentProfile?.avatar_url ?? null);
  let color = $derived(currentProfile?.hero_color ?? senderColor(userId));
  let pronouns = $derived(
    (currentProfile?.pronouns ?? []).map((pronoun) => pronoun.summary).join(', ')
  );
  let localTime = $derived.by(() => {
    const timezone = currentProfile?.timezone;
    if (!timezone) return null;

    try {
      const time = new Intl.DateTimeFormat(undefined, {
        hour: 'numeric',
        minute: '2-digit',
        timeZone: timezone,
      }).format(new Date());
      return { time, timezone };
    } catch {
      // An unknown zone name is another client's data, not a fault here.
      return null;
    }
  });
  let animalText = $derived.by(() => {
    const animal = currentProfile?.animal;
    if (!animal) return null;

    let identity: string;
    if (animal.is_animal && animal.has_animal) {
      identity = $i18n.t('timeline.animalBoth', { is: animal.is_animal, has: animal.has_animal });
    } else if (animal.is_animal) {
      identity = $i18n.t('timeline.animalIs', { is: animal.is_animal });
    } else if (animal.has_animal) {
      identity = $i18n.t('timeline.animalHas', { has: animal.has_animal });
    } else {
      return null;
    }

    // v1 always suggests something, so an animal with no stated need still gets
    // the default one rather than a bare "Is cat!".
    return $i18n.t('timeline.animalNeed', {
      identity,
      need: animal.animal_need ?? $i18n.t('timeline.animalDefaultNeed'),
    });
  });
  let extra = $derived(currentProfile?.extra ?? []);
  let showFailure = $derived(failed && !currentProfile);
  // Messaging yourself is a room the account cannot be invited to.
  let canMessage = $derived(core.session !== null && core.session.user_id !== userId);
  let messageLabel = $derived($i18n.t('timeline.messageUser', { name: displayName }));
  let draft = $state('');
  let sending = $state(false);
  let sendFailed = $state(false);
  let homeserver = $derived(userId.slice(userId.indexOf(':') + 1));
  let roleLabel = $derived.by(() => {
    if (!member) return null;
    if (member.power_level >= 100) return $i18n.t('timeline.powerLevelAdmin');
    if (member.power_level >= 50) return $i18n.t('timeline.powerLevelModerator');
    return $i18n.t('timeline.powerLevelMember');
  });
  // Elevated power is the one fact a reader may need to spot without reading, so
  // it is the only metadata item allowed a fill.
  let elevated = $derived(member !== null && member.power_level >= 50);
  let profileLink = $derived(`https://matrix.to/#/${userId}`);
  const canShareLink = typeof navigator !== 'undefined' && 'share' in navigator;
  let mutualRooms = $state<MutualRoomView[]>([]);
  let ignored = $state(false);
  let showMutualRooms = $state(false);
  let hasMeta = $derived(Boolean(pronouns || localTime || animalText || roleLabel));

  // Both answers come from local state, so this is cheap enough to redo whenever
  // the card points at someone else.
  $effect(() => {
    const target = userId;
    let cancelled = false;
    void core.userRelations(target).then(
      (relations) => {
        if (cancelled) return;
        mutualRooms = relations.mutualRooms;
        ignored = relations.ignored;
      },
      () => {}
    );
    return () => {
      cancelled = true;
      showMutualRooms = false;
    };
  });

  async function copy(text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Nothing to report if the clipboard is unavailable to this document.
    }
  }

  async function copyUserId(): Promise<void> {
    await copy(userId);
  }

  async function copyProfileLink(): Promise<void> {
    await copy(profileLink);
  }

  async function copyServer(): Promise<void> {
    await copy(homeserver);
  }

  async function shareProfileLink(): Promise<void> {
    try {
      await navigator.share({ url: profileLink, title: displayName });
    } catch {
      // A dismissed share sheet rejects, which is not a failure to report.
    }
  }

  function openServer(): void {
    window.open(`https://${homeserver}`, '_blank', 'noopener,noreferrer');
  }

  async function toggleIgnored(): Promise<void> {
    const next = !ignored;
    try {
      await core.setUserIgnored(userId, next);
      ignored = next;
    } catch {
      // Leaving `ignored` alone keeps the menu honest about server state.
    }
  }

  function openRoom(roomId: string): void {
    void goto(resolve('/(app)/home/[roomId]', { roomId }));
  }

  async function sendDirectMessage(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    const body = draft.trim();
    if (!body || sending) return;

    sending = true;
    sendFailed = false;
    try {
      const roomId = await core.createDm(userId);
      await core.sendMessage(roomId, body);
      draft = '';
    } catch {
      // The draft stays put: a failed send must not eat what was typed.
      sendFailed = true;
    } finally {
      sending = false;
    }
  }
</script>

{#snippet metaRow()}
  {#if pronouns}
    <span class="profile-meta-item"><UserIcon size={16} />{pronouns}</span>
  {/if}
  {#if localTime}
    <span class="profile-meta-item">
      <ClockIcon size={16} />
      {localTime.time}
      <span class="profile-meta-aside">({localTime.timezone})</span>
    </span>
  {/if}
  {#if animalText}
    <span class="profile-meta-item"><HeartIcon size={16} />{animalText}</span>
  {/if}
  <span class="profile-meta-item profile-meta-server" title={homeserver}>
    <HardDrivesIcon size={16} />
    <span class="profile-meta-server-name">{homeserver}</span>
  </span>
  {#if roleLabel}
    <span class="profile-meta-item" class:profile-meta-elevated={elevated}>{roleLabel}</span>
  {/if}
{/snippet}

<!-- Only the verbs live here. The homeserver and the room role are facts, so they
     stay unfilled in the metadata row above; a border, not a fill, is what marks
     these three as pressable. -->
{#snippet actionRow()}
  <DropdownMenu.Root>
    <DropdownMenu.Trigger class="profile-action">
      <ShareNetworkIcon size={14} />
      {$i18n.t('timeline.profileShare')}
    </DropdownMenu.Trigger>
    <DropdownMenu.Content class="profile-menu" side="bottom" align="start" sideOffset={4}>
      <DropdownMenu.Item class="profile-menu-item" onSelect={copyUserId}>
        {$i18n.t('timeline.profileCopyId')}
      </DropdownMenu.Item>
      <DropdownMenu.Item class="profile-menu-item" onSelect={copyProfileLink}>
        {$i18n.t('timeline.profileCopyLink')}
      </DropdownMenu.Item>
      {#if canShareLink}
        <DropdownMenu.Item class="profile-menu-item" onSelect={shareProfileLink}>
          {$i18n.t('timeline.profileShareLink')}
        </DropdownMenu.Item>
      {/if}
    </DropdownMenu.Content>
  </DropdownMenu.Root>
  {#if mutualRooms.length > 0}
    <button
      class="profile-action"
      class:pressed={showMutualRooms}
      type="button"
      aria-expanded={showMutualRooms}
      onclick={() => (showMutualRooms = !showMutualRooms)}
    >
      {$i18n.t('timeline.profileMutualRooms', { count: mutualRooms.length })}
    </button>
  {/if}
  <DropdownMenu.Root>
    <DropdownMenu.Trigger
      class="profile-action profile-action-overflow"
      aria-label={$i18n.t('timeline.profileMoreActions')}
    >
      <DotsThreeIcon size={14} />
    </DropdownMenu.Trigger>
    <DropdownMenu.Content class="profile-menu" side="bottom" align="end" sideOffset={4}>
      <!-- The safe items come first so opening the menu with a keyboard lands
           focus somewhere harmless. -->
      <DropdownMenu.Item class="profile-menu-item" onSelect={copyServer}>
        <CopyIcon size={16} />
        {$i18n.t('timeline.profileCopyServer')}
      </DropdownMenu.Item>
      <DropdownMenu.Item class="profile-menu-item" onSelect={openServer}>
        <ArrowSquareOutIcon size={16} />
        {$i18n.t('timeline.profileOpenServer')}
      </DropdownMenu.Item>
      <DropdownMenu.Item
        class="profile-menu-item profile-menu-destructive"
        onSelect={toggleIgnored}
      >
        <ProhibitIcon size={16} />
        {ignored ? $i18n.t('timeline.profileUnblock') : $i18n.t('timeline.profileBlock')}
      </DropdownMenu.Item>
    </DropdownMenu.Content>
  </DropdownMenu.Root>
{/snippet}

{#snippet bioPanel()}
  {#if showFailure}
    <Alert variant="warning" role="status">{$i18n.t('timeline.profileUnavailable')}</Alert>
  {:else if currentProfile?.bio}
    <FormattedBody html={currentProfile.bio} />
  {/if}
{/snippet}

<!-- The room list replaces the panel's contents rather than expanding under it:
     a third in-place expander would turn the card into an accordion. -->
{#snippet mutualRoomsPanel()}
  <ul class="profile-rooms">
    {#each mutualRooms.slice(0, mutualRoomsShown) as room (room.room_id)}
      <li>
        <button
          type="button"
          onclick={() => {
            openRoom(room.room_id);
          }}
        >
          {room.name ?? room.room_id}
        </button>
      </li>
    {/each}
  </ul>
  {#if mutualRooms.length > mutualRoomsShown}
    <p class="profile-rooms-remainder">
      {$i18n.t('timeline.profileMoreRooms', { count: mutualRooms.length - mutualRoomsShown })}
    </p>
  {/if}
  <button class="profile-rooms-back" type="button" onclick={() => (showMutualRooms = false)}>
    {$i18n.t('timeline.profileBackToProfile')}
  </button>
{/snippet}

{#snippet composer()}
  <form class="profile-composer" onsubmit={sendDirectMessage}>
    <TextInput
      bind:value={draft}
      class="profile-composer-input"
      placeholder={messageLabel}
      aria-label={messageLabel}
      disabled={sending}
    />
    <IconButton
      label={$i18n.t('timeline.sendMessage')}
      variant="primary"
      size="small"
      type="submit"
      disabled={sending || draft.trim() === ''}
    >
      <PaperPlaneRightIcon size={16} />
    </IconButton>
  </form>
  {#if sendFailed}
    <p class="profile-composer-error" role="status">{$i18n.t('timeline.sendFailed')}</p>
  {/if}
{/snippet}

{#snippet miscData()}
  <details class="profile-extra">
    <summary>
      <CaretRightIcon size={16} />
      {$i18n.t('timeline.profileMiscData', { count: extra.length })}
    </summary>
    <dl>
      {#each extra as field (field.key)}
        <dt>{field.key}</dt>
        <dd>{field.value}</dd>
      {/each}
    </dl>
  </details>
{/snippet}

<!-- Each panel is passed only when it has something in it: an empty snippet
     would still draw its padding, background and separator. -->
<ProfileCard
  {displayName}
  {userId}
  {avatarUrl}
  {color}
  heroColor={currentProfile?.hero_color}
  heroBrightness={currentProfile?.hero_brightness}
  bannerUrl={currentProfile?.banner_url}
  status={currentProfile?.status?.text}
  statusEmoji={currentProfile?.status?.emoji}
  nameColorLight={currentProfile?.name_color_light}
  nameColorDark={currentProfile?.name_color_dark}
  bioMoreLabel={showMutualRooms ? undefined : $i18n.t('timeline.profileBioMore')}
  bioLessLabel={showMutualRooms ? undefined : $i18n.t('timeline.profileBioLess')}
  meta={hasMeta ? metaRow : undefined}
  actions={actionRow}
  children={showMutualRooms
    ? mutualRoomsPanel
    : showFailure || currentProfile?.bio
      ? bioPanel
      : undefined}
  footer={!showMutualRooms && extra.length > 0 ? miscData : undefined}
  composer={canMessage ? composer : undefined}
  {variant}
/>

<style>
  .profile-meta-item {
    align-items: center;
    display: inline-flex;
    gap: var(--space-1);
    max-width: 100%;
    min-width: 0;
    overflow-wrap: anywhere;
  }

  .profile-meta-aside {
    color: var(--sable-sec-main);
  }

  /* The only truncatable string in either row: it is both unbounded and already
     printed in full in the Matrix ID above. */
  .profile-meta-server-name {
    display: block;
    max-width: 11rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .profile-meta-elevated {
    background: var(--sable-surface-var-container);
    border-radius: var(--radius-pill);
    color: var(--sable-bg-on-container);
    font-weight: var(--font-weight-medium);
    padding: 0 var(--space-1);
  }

  /* Bordered, never filled: an outline is the at-rest shape everyone reads as
     pressable, and staying ghost leaves Send as the only solid button here. */
  .profile-action {
    align-items: center;
    background: none;
    border: 1px solid var(--sable-surface-container-line);
    border-radius: var(--radius-pill);
    color: var(--sable-bg-on-container);
    cursor: pointer;
    display: inline-flex;
    font: inherit;
    font-size: var(--font-size-small);
    font-weight: var(--font-weight-medium);
    gap: 0.25rem;

    /* A clipped verb is a broken button, so labels never truncate. */
    padding: 0.125rem var(--space-2);
    white-space: nowrap;
  }

  .profile-action :global(svg) {
    color: var(--sable-sec-main);
    flex: none;
  }

  .profile-action:hover {
    background: color-mix(in oklab, var(--sable-bg-on-container) 7%, transparent);
  }

  .profile-action:focus-visible {
    outline: var(--focus-ring-width) solid var(--sable-focus-ring);
    outline-offset: var(--focus-ring-offset);
  }

  .profile-action.pressed {
    background: var(--sable-surface-var-container);
    border-color: var(--sable-sec-main);
  }

  /* Fixed width and always last, so it sits at the right edge of whichever line
     the row wraps onto. */

  /* On a bits-ui trigger, so it needs the same `:global` as the menu classes. */
  :global(.profile-action-overflow) {
    margin-left: auto;
    padding: 0.125rem var(--space-1);
  }

  .profile-rooms {
    display: grid;
    font-size: var(--font-size-small);
    gap: 0.125rem;
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .profile-rooms button {
    background: none;
    border: 0;
    border-radius: var(--radius);
    color: var(--sable-primary-main);
    cursor: pointer;
    font: inherit;
    font-size: var(--font-size-small);
    padding: 0.25rem var(--space-1);
    text-align: left;
    width: 100%;
  }

  .profile-rooms button:hover {
    background: color-mix(in oklab, var(--sable-bg-on-container) 7%, transparent);
  }

  .profile-rooms-remainder {
    color: var(--sable-sec-main);
    font-size: var(--font-size-small);
    margin: var(--space-1) 0 0 var(--space-1);
  }

  .profile-rooms-back {
    background: none;
    border: 0;
    border-radius: var(--radius-pill);
    color: var(--sable-primary-main);
    cursor: pointer;
    font: inherit;
    font-size: var(--font-size-small);
    font-weight: var(--font-weight-medium);
    margin: var(--space-1) 0 0;
    padding: 0.125rem var(--space-1);
  }

  .profile-rooms-back:focus-visible {
    outline: var(--focus-ring-width) solid var(--sable-focus-ring);
    outline-offset: var(--focus-ring-offset);
  }

  :global(.profile-menu) {
    background: var(--sable-bg-container);
    border: 1px solid var(--sable-bg-container-line);
    border-radius: var(--radius);
    box-shadow: var(--shadow-float);
    display: grid;
    min-width: 11rem;
    padding: 0.25rem;
    z-index: calc(var(--layer-popover) + 2);
  }

  :global(.profile-menu-item) {
    align-items: center;
    border-radius: var(--radius);
    cursor: pointer;
    display: flex;
    font-size: var(--font-size-small);
    gap: var(--space-1);
    min-height: 2.25rem;
    padding: 0 var(--space-1);
  }

  :global(.profile-menu-item[data-highlighted]) {
    background: var(--sable-bg-container-hover);
  }

  /* Neutral at rest, behind a hairline and a taller target: a red row at rest
     turns a two-item menu into a warning box and pulls the eye to the one thing
     nobody should hit by accident. The colour arrives on hover, where it helps. */
  :global(.profile-menu-destructive) {
    border-top: 1px solid var(--sable-bg-container-line);
    margin-top: 0.25rem;
    min-height: var(--control-height-medium);
  }

  :global(.profile-menu-destructive svg) {
    color: var(--sable-crit-main);
  }

  :global(.profile-menu-destructive[data-highlighted]) {
    background: color-mix(in oklab, var(--sable-crit-main) 12%, var(--sable-bg-container));
    color: var(--sable-crit-main);
  }

  .profile-composer {
    align-items: center;
    display: flex;
    gap: var(--space-1);
  }

  /* The popover is 22rem wide: a full-height control would dominate it, and the
     control's own block padding is what makes it tall, so the height is set
     outright rather than nudged with min-height. The sheet keeps 2.75rem. */
  .profile-composer :global(.profile-composer-input) {
    flex: 1 1 auto;
    font-size: var(--font-size-small);
    height: var(--control-height-small);
    min-height: 0;
    min-width: 0;
    padding-block: 0;
  }

  :global(.sable-profile-card-sheet) .profile-composer :global(.profile-composer-input) {
    height: var(--control-height-medium);
  }

  :global(.sable-profile-card-sheet) .profile-composer :global(.sable-icon-button) {
    min-height: var(--control-height-medium);
    width: var(--control-height-medium);
  }

  .profile-composer-error {
    color: var(--sable-crit-main);
    font-size: var(--font-size-small);
    margin: var(--space-1) 0 0;
  }

  .profile-extra {
    font-size: var(--font-size-small);
    line-height: var(--line-height-body);
  }

  .profile-extra summary {
    align-items: center;
    border-radius: var(--radius);
    cursor: pointer;
    display: flex;
    font-weight: var(--font-weight-medium);
    gap: var(--space-1);
    list-style: none;
    margin: 0 -0.5rem;
    min-height: 2.25rem;
    padding: 0 var(--space-1);
  }

  .profile-extra summary::-webkit-details-marker {
    display: none;
  }

  .profile-extra summary:hover {
    background: color-mix(
      in oklab,
      var(--sable-bg-on-container) 7%,
      var(--sable-surface-container)
    );
  }

  .profile-extra summary:focus-visible {
    outline: var(--focus-ring-width) solid var(--sable-focus-ring);
    outline-offset: var(--focus-ring-offset);
  }

  .profile-extra summary :global(svg) {
    color: var(--sable-sec-main);
    flex: none;
    transition: transform var(--motion-fast) var(--motion-easing-standard);
  }

  .profile-extra[open] summary :global(svg) {
    transform: rotate(90deg);
  }

  .profile-extra dl {
    display: grid;
    gap: 0.125rem;
    margin: var(--space-1) 0 0;
  }

  /* Key is the quiet half, value the readable one. */
  .profile-extra dt {
    color: var(--sable-sec-main);
    font-weight: var(--font-weight-medium);
    overflow-wrap: anywhere;
  }

  .profile-extra dd {
    margin: 0 0 var(--space-1);
    overflow-wrap: anywhere;
  }
</style>
