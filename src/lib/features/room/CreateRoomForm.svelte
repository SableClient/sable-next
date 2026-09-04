<script lang="ts">
  import ChatsIcon from 'phosphor-svelte/lib/ChatsIcon';
  import GlobeIcon from 'phosphor-svelte/lib/GlobeIcon';
  import LockIcon from 'phosphor-svelte/lib/LockIcon';
  import SpeakerHighIcon from 'phosphor-svelte/lib/SpeakerHighIcon';
  import UsersThreeIcon from 'phosphor-svelte/lib/UsersThreeIcon';
  import XIcon from 'phosphor-svelte/lib/XIcon';

  import { goto } from '$app/navigation';
  import { resolve } from '$app/paths';
  import { useCoreClient } from '#lib/core/context.js';
  import { i18n } from '#lib/i18n.js';
  import type { CreateJoinRuleView } from '#src/generated/CreateJoinRuleView';
  import type { CreateRoomKind } from '#src/generated/CreateRoomKind';
  import type { RoomVersionsView } from '#src/generated/RoomVersionsView';
  import { roomPathParamFromId, useRoomList } from '#lib/rooms/room-list.svelte.js';
  import Alert from '#lib/ui/primitives/Alert.svelte';
  import Button from '#lib/ui/primitives/Button.svelte';
  import IconButton from '#lib/ui/primitives/IconButton.svelte';
  import Label from '#lib/ui/primitives/Label.svelte';
  import OptionCards from '#lib/ui/primitives/OptionCards.svelte';
  import Select from '#lib/ui/primitives/Select.svelte';
  import Switch from '#lib/ui/primitives/Switch.svelte';
  import TextArea from '#lib/ui/primitives/TextArea.svelte';
  import TextInput from '#lib/ui/primitives/TextInput.svelte';

  import { validateRoomAliasLocalpart, type RoomAliasLocalpartError } from './room-alias-localpart';

  type PrivateJoinRule = Exclude<CreateJoinRuleView, 'public'>;

  interface Props {
    /** Preselects the parent space, so creating from inside a space stays there. */
    parentSpaceId?: string | null;
  }

  let { parentSpaceId = null }: Props = $props();
  const core = useCoreClient();
  const roomList = useRoomList();
  const userIdPattern = /^@[^:\s]+:\S+$/;

  let name = $state('');
  let topic = $state('');
  let kind = $state<CreateRoomKind>('text');
  let access = $state<'private' | 'public'>('private');
  let encrypted = $state(true);
  // `parentSpaceId` arrives once the room list has loaded, so the field follows
  // it until the user picks something else.
  let parentChoice = $state<string | null>(null);
  let parentSpace = $derived(parentChoice ?? parentSpaceId ?? '');
  let joinRuleChoice = $state<PrivateJoinRule>('invite');
  let alias = $state('');
  let roomVersionChoice = $state('');
  let federate = $state(true);
  let roomVersions = $state.raw<RoomVersionsView | null>(null);
  let inviteDraft = $state('');
  let invites = $state<string[]>([]);
  let inviteInvalid = $state(false);
  let submitting = $state(false);
  let failed = $state(false);

  let spaces = $derived(roomList.rooms.filter((room) => room.is_space && room.state === 'joined'));
  // The core ignores `encrypted` for a space or a public room.
  let encryptable = $derived(kind !== 'space' && access === 'private');
  let parentSpaceSummary = $derived(spaces.find((space) => space.room_id === parentSpace) ?? null);
  let knockSupported = $derived(roomList.rooms.some((room) => room.supports_knock));
  let restrictedSupported = $derived(parentSpaceSummary?.supports_restricted ?? false);
  let knockRestrictedSupported = $derived(parentSpaceSummary?.supports_knock_restricted ?? false);
  let effectiveJoinRule: PrivateJoinRule = $derived.by(() => {
    if (joinRuleChoice === 'knock' && !knockSupported) return 'invite';
    if (joinRuleChoice === 'restricted' && !restrictedSupported) return 'invite';
    if (joinRuleChoice === 'knock_restricted' && !knockRestrictedSupported) return 'invite';
    return joinRuleChoice;
  });
  let joinRuleToSend: CreateJoinRuleView | null = $derived(
    access === 'public' || effectiveJoinRule === 'invite' ? null : effectiveJoinRule
  );
  let aliasTrimmed = $derived(alias.trim());
  let aliasError: RoomAliasLocalpartError | null = $derived(
    access === 'public' && aliasTrimmed !== '' ? validateRoomAliasLocalpart(aliasTrimmed) : null
  );
  let aliasToSend = $derived(access === 'public' && aliasTrimmed !== '' ? aliasTrimmed : null);
  let roomVersionToSend = $derived(roomVersionChoice === '' ? null : roomVersionChoice);
  let versionItems = $derived([
    {
      value: '',
      label: roomVersions
        ? $i18n.t('room.createVersionDefault', { version: roomVersions.default })
        : $i18n.t('room.createVersionDefaultUnknown'),
    },
    ...(roomVersions?.available ?? []).map((entry) => ({
      value: entry.id,
      label: entry.stable ? entry.id : $i18n.t('room.createVersionUnstable', { version: entry.id }),
    })),
  ]);
  let canSubmit = $derived(name.trim() !== '' && aliasError === null && !submitting);

  $effect(() => {
    let cancelled = false;
    core.commands
      .roomVersions()
      .then((result) => {
        if (!cancelled) roomVersions = result;
      })
      .catch((error: unknown) => {
        if (!cancelled) console.warn('[sable room] room versions unavailable', error);
      });
    return () => {
      cancelled = true;
    };
  });

  function aliasErrorMessageKey(error: RoomAliasLocalpartError): string {
    switch (error) {
      case 'empty':
        return 'room.createAliasInvalidEmpty';
      case 'colon':
        return 'room.createAliasInvalidColon';
      case 'whitespace':
        return 'room.createAliasInvalidWhitespace';
      case 'control':
        return 'room.createAliasInvalidControl';
    }
  }

  function joinRuleHint(keyStem: string): string {
    return parentSpaceSummary
      ? $i18n.t(`room.${keyStem}Hint`, {
          space: parentSpaceSummary.name ?? parentSpaceSummary.room_id,
        })
      : $i18n.t('room.createJoinRuleRequiresSpace');
  }

  function addInvite(): void {
    const candidate = inviteDraft.trim();
    if (candidate === '') return;
    if (!userIdPattern.test(candidate)) {
      inviteInvalid = true;
      return;
    }
    inviteInvalid = false;
    if (!invites.includes(candidate)) invites = [...invites, candidate];
    inviteDraft = '';
  }

  function removeInvite(userId: string): void {
    invites = invites.filter((invite) => invite !== userId);
  }

  function onInviteKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Enter') return;
    // Enter adds the invite; the form must not submit.
    event.preventDefault();
    addInvite();
  }

  async function submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (!canSubmit) return;

    submitting = true;
    failed = false;
    try {
      const roomId = await core.commands.createRoom({
        name: name.trim(),
        topic: topic.trim() === '' ? null : topic.trim(),
        kind,
        public: access === 'public',
        encrypted: encryptable && encrypted,
        // A `$state` array is a Proxy, which postMessage cannot clone.
        invite: [...invites],
        parentSpace: parentSpace === '' ? null : parentSpace,
        alias: aliasToSend,
        roomVersion: roomVersionToSend,
        joinRule: joinRuleToSend,
        federate,
      });
      const target = roomPathParamFromId(roomId);
      if (kind === 'space') {
        await goto(resolve('/(app)/space/[spaceId]', { spaceId: target }));
      } else if (parentSpace !== '') {
        // A child opens inside its space, so the rail and room list stay put.
        await goto(
          resolve('/(app)/space/[spaceId]/[roomId]', {
            spaceId: roomPathParamFromId(parentSpace),
            roomId: target,
          })
        );
      } else {
        await goto(resolve('/(app)/rooms/[roomId]', { roomId: target }));
      }
    } catch (error) {
      console.warn('[sable room] create failed', error);
      failed = true;
    } finally {
      submitting = false;
    }
  }
</script>

<form class="create-room" onsubmit={submit}>
  <div class="field">
    <Label for="create-room-name">{$i18n.t('room.createNameLabel')}</Label>
    <TextInput
      id="create-room-name"
      bind:value={name}
      required
      autocomplete="off"
      placeholder={$i18n.t('room.createNamePlaceholder')}
    />
  </div>

  <div class="field">
    <Label for="create-room-topic">{$i18n.t('room.createTopicLabel')}</Label>
    <TextArea
      id="create-room-topic"
      bind:value={topic}
      placeholder={$i18n.t('room.createTopicPlaceholder')}
    />
    <p class="hint">{$i18n.t('room.createTopicHint')}</p>
  </div>

  <div class="field">
    <span class="field-label">{$i18n.t('room.createKindLabel')}</span>
    <OptionCards
      label={$i18n.t('room.createKindLabel')}
      value={kind}
      onSelect={(next: CreateRoomKind) => {
        kind = next;
      }}
      options={[
        {
          value: 'text',
          label: $i18n.t('room.createKindRoom'),
          hint: $i18n.t('room.createKindRoomHint'),
          icon: ChatsIcon,
        },
        {
          value: 'voice',
          label: $i18n.t('room.createKindVoice'),
          hint: $i18n.t('room.createKindVoiceHint'),
          icon: SpeakerHighIcon,
        },
        {
          value: 'space',
          label: $i18n.t('room.createKindSpace'),
          hint: $i18n.t('room.createKindSpaceHint'),
          icon: UsersThreeIcon,
        },
      ]}
    />
  </div>

  {#if spaces.length > 0}
    <div class="field">
      <Label for="create-room-parent">{$i18n.t('room.createParentLabel')}</Label>
      <Select
        id="create-room-parent"
        value={parentSpace}
        items={[
          { value: '', label: $i18n.t('room.createParentNone') },
          ...spaces.map((space) => ({ value: space.room_id, label: space.name ?? space.room_id })),
        ]}
        onValueChange={(value: string) => {
          parentChoice = value;
        }}
      />
    </div>
  {/if}

  <div class="field">
    <span class="field-label">{$i18n.t('room.createAccessLabel')}</span>
    <OptionCards
      label={$i18n.t('room.createAccessLabel')}
      value={access}
      onSelect={(next: 'private' | 'public') => {
        access = next;
      }}
      options={[
        {
          value: 'private',
          label: $i18n.t('room.createAccessPrivate'),
          hint: $i18n.t('room.createAccessPrivateHint'),
          icon: LockIcon,
        },
        {
          value: 'public',
          label: $i18n.t('room.createAccessPublic'),
          hint: $i18n.t('room.createAccessPublicHint'),
          icon: GlobeIcon,
        },
      ]}
    />
  </div>

  {#if access === 'private'}
    <div class="field">
      <span class="field-label">{$i18n.t('room.createJoinRuleLabel')}</span>
      <OptionCards
        label={$i18n.t('room.createJoinRuleLabel')}
        value={effectiveJoinRule}
        onSelect={(next: PrivateJoinRule) => {
          joinRuleChoice = next;
        }}
        options={[
          {
            value: 'invite',
            label: $i18n.t('room.createJoinRuleInvite'),
            hint: $i18n.t('room.createJoinRuleInviteHint'),
          },
          {
            value: 'knock',
            label: $i18n.t('room.createJoinRuleKnock'),
            hint: $i18n.t('room.createJoinRuleKnockHint'),
            disabled: !knockSupported,
          },
          {
            value: 'restricted',
            label: $i18n.t('room.createJoinRuleRestricted'),
            hint: joinRuleHint('createJoinRuleRestricted'),
            disabled: !restrictedSupported,
          },
          {
            value: 'knock_restricted',
            label: $i18n.t('room.createJoinRuleKnockRestricted'),
            hint: joinRuleHint('createJoinRuleKnockRestricted'),
            disabled: !knockRestrictedSupported,
          },
        ]}
      />
    </div>
  {/if}

  {#if access === 'public'}
    <div class="field">
      <Label for="create-room-alias">{$i18n.t('room.createAliasLabel')}</Label>
      <TextInput
        id="create-room-alias"
        bind:value={alias}
        autocomplete="off"
        placeholder={$i18n.t('room.createAliasPlaceholder')}
        aria-invalid={aliasError !== null}
      />
      {#if aliasError}
        <p class="error">{$i18n.t(aliasErrorMessageKey(aliasError))}</p>
      {:else}
        <p class="hint">{$i18n.t('room.createAliasHint')}</p>
      {/if}
    </div>
  {/if}

  <div class="row">
    <div class="row-text">
      <span class="field-label">{$i18n.t('room.createEncryptionLabel')}</span>
      <p class="hint">
        {encryptable
          ? $i18n.t('room.createEncryptionHint')
          : $i18n.t('room.createEncryptionUnavailable')}
      </p>
    </div>
    <Switch
      checked={encryptable && encrypted}
      disabled={!encryptable}
      label={$i18n.t('room.createEncryptionLabel')}
      onCheckedChange={(next: boolean) => {
        encrypted = next;
      }}
    />
  </div>

  <details class="advanced">
    <summary>{$i18n.t('room.createAdvancedLabel')}</summary>
    <div class="advanced-content">
      <div class="row">
        <div class="row-text">
          <span class="field-label">{$i18n.t('room.createFederationLabel')}</span>
          <p class="hint">{$i18n.t('room.createFederationHint')}</p>
        </div>
        <Switch
          checked={federate}
          label={$i18n.t('room.createFederationLabel')}
          onCheckedChange={(next: boolean) => {
            federate = next;
          }}
        />
      </div>

      <div class="field">
        <Label for="create-room-version">{$i18n.t('room.createVersionLabel')}</Label>
        <Select
          id="create-room-version"
          value={roomVersionChoice}
          items={versionItems}
          onValueChange={(value: string) => {
            roomVersionChoice = value;
          }}
        />
      </div>
    </div>
  </details>

  <div class="field">
    <Label for="create-room-invite">{$i18n.t('room.createInviteLabel')}</Label>
    <div class="invite-row">
      <TextInput
        id="create-room-invite"
        bind:value={inviteDraft}
        autocomplete="off"
        placeholder={$i18n.t('room.createInvitePlaceholder')}
        aria-invalid={inviteInvalid}
        onkeydown={onInviteKeydown}
      />
      <Button onclick={addInvite}>{$i18n.t('room.createInviteAdd')}</Button>
    </div>
    {#if inviteInvalid}
      <p class="error">{$i18n.t('room.createInviteInvalid')}</p>
    {/if}
    {#if invites.length > 0}
      <ul class="invites">
        {#each invites as invite (invite)}
          <li>
            <span>{invite}</span>
            <IconButton
              variant="ghost"
              size="small"
              label={$i18n.t('room.createInviteRemove', { user: invite })}
              onclick={() => {
                removeInvite(invite);
              }}
            >
              <XIcon />
            </IconButton>
          </li>
        {/each}
      </ul>
    {/if}
  </div>

  {#if failed}
    <Alert variant="critical" role="alert">{$i18n.t('room.createFailed')}</Alert>
  {/if}

  <Button type="submit" variant="primary" disabled={!canSubmit} loading={submitting}>
    {kind === 'space' ? $i18n.t('room.createSubmitSpace') : $i18n.t('room.createSubmit')}
  </Button>
</form>

<style>
  .create-room {
    display: grid;
    gap: var(--space-500);
  }

  .field {
    display: grid;
    gap: var(--space-200);
  }

  .field-label {
    font-size: var(--font-size-small);
    font-weight: var(--font-weight-medium);
    line-height: var(--line-height-heading);
  }

  .hint {
    color: var(--sable-surface-var-on-container);
    font-size: var(--font-size-small);
    line-height: var(--line-height-body);
    margin: 0;
  }

  .error {
    color: var(--sable-crit-main);
    font-size: var(--font-size-small);
    margin: 0;
  }

  .row {
    align-items: center;
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-400);
    justify-content: space-between;
  }

  .row-text {
    display: grid;
    gap: var(--space-100);
    min-width: 0;
  }

  .advanced {
    border: var(--border-width) solid var(--sable-surface-container-line);
    border-radius: var(--radii-400);
  }

  .advanced summary {
    align-items: center;
    cursor: pointer;
    display: flex;
    font-size: var(--font-size-small);
    font-weight: var(--font-weight-medium);
    min-height: 2.75rem;
    padding: var(--space-300);
  }

  .advanced-content {
    display: grid;
    gap: var(--space-500);
    padding: 0 var(--space-300) var(--space-300);
  }

  .invite-row {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-300);
  }

  .invite-row :global(.text-input) {
    flex: 1;
    min-width: 0;
  }

  .invites {
    display: grid;
    gap: var(--space-100);
    list-style: none;
    margin: var(--space-200) 0 0;
    padding: 0;
  }

  .invites li {
    align-items: center;
    background: var(--sable-surface-container);
    border-radius: var(--radius);
    display: flex;
    gap: var(--space-300);
    justify-content: space-between;
    padding: var(--space-100) var(--space-100) var(--space-100) var(--space-300);
  }

  .invites span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
