<script lang="ts">
  import ChatsIcon from 'phosphor-svelte/lib/ChatsIcon';
  import GlobeIcon from 'phosphor-svelte/lib/GlobeIcon';
  import LockIcon from 'phosphor-svelte/lib/LockIcon';
  import UsersThreeIcon from 'phosphor-svelte/lib/UsersThreeIcon';
  import XIcon from 'phosphor-svelte/lib/XIcon';

  import { goto } from '$app/navigation';
  import { resolve } from '$app/paths';
  import { useCoreClient } from '$lib/core/context';
  import { i18n } from '$lib/i18n';
  import { roomPathParamFromId, useRoomList } from '$lib/rooms/room-list.svelte';
  import Alert from '$lib/ui/primitives/Alert.svelte';
  import Button from '$lib/ui/primitives/Button.svelte';
  import IconButton from '$lib/ui/primitives/IconButton.svelte';
  import Label from '$lib/ui/primitives/Label.svelte';
  import OptionCards from '$lib/ui/primitives/OptionCards.svelte';
  import Select from '$lib/ui/primitives/Select.svelte';
  import Switch from '$lib/ui/primitives/Switch.svelte';
  import TextArea from '$lib/ui/primitives/TextArea.svelte';
  import TextInput from '$lib/ui/primitives/TextInput.svelte';

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
  let kind = $state<'room' | 'space'>('room');
  let access = $state<'private' | 'public'>('private');
  let encrypted = $state(true);
  // `parentSpaceId` arrives once the room list has loaded, so the field follows
  // it until the user picks something else.
  let parentChoice = $state<string | null>(null);
  let parentSpace = $derived(parentChoice ?? parentSpaceId ?? '');
  let inviteDraft = $state('');
  let invites = $state<string[]>([]);
  let inviteInvalid = $state(false);
  let submitting = $state(false);
  let failed = $state(false);

  let spaces = $derived(roomList.rooms.filter((room) => room.is_space && room.state === 'joined'));
  // The core ignores `encrypted` for a space or a public room.
  let encryptable = $derived(kind === 'room' && access === 'private');
  let canSubmit = $derived(name.trim() !== '' && !submitting);

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
      const roomId = await core.createRoom({
        name: name.trim(),
        topic: topic.trim() === '' ? null : topic.trim(),
        isSpace: kind === 'space',
        public: access === 'public',
        encrypted: encryptable && encrypted,
        // A `$state` array is a Proxy, which postMessage cannot clone.
        invite: [...invites],
        parentSpace: parentSpace === '' ? null : parentSpace,
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
        await goto(resolve('/(app)/home/[roomId]', { roomId: target }));
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
      onSelect={(next: 'room' | 'space') => {
        kind = next;
      }}
      options={[
        {
          value: 'room',
          label: $i18n.t('room.createKindRoom'),
          hint: $i18n.t('room.createKindRoomHint'),
          icon: ChatsIcon,
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

  {#if spaces.length > 0}
    <div class="field">
      <Label for="create-room-parent">{$i18n.t('room.createParentLabel')}</Label>
      <Select
        id="create-room-parent"
        value={parentSpace}
        onchange={(event: Event & { currentTarget: HTMLSelectElement }) => {
          parentChoice = event.currentTarget.value;
        }}
      >
        <option value="">{$i18n.t('room.createParentNone')}</option>
        {#each spaces as space (space.room_id)}
          <option value={space.room_id}>{space.name ?? space.room_id}</option>
        {/each}
      </Select>
    </div>
  {/if}

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
    gap: var(--space-4);
  }

  .field {
    display: grid;
    gap: var(--space-1);
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
    gap: var(--space-3);
    justify-content: space-between;
  }

  .row-text {
    display: grid;
    gap: calc(var(--space-1) / 2);
    min-width: 0;
  }

  .invite-row {
    display: flex;
    gap: var(--space-2);
  }

  .invite-row :global(.text-input) {
    flex: 1;
    min-width: 0;
  }

  .invites {
    display: grid;
    gap: 0.25rem;
    list-style: none;
    margin: var(--space-1) 0 0;
    padding: 0;
  }

  .invites li {
    align-items: center;
    background: var(--sable-surface-container);
    border-radius: var(--radius);
    display: flex;
    gap: var(--space-2);
    justify-content: space-between;
    padding: 0.25rem 0.25rem 0.25rem var(--space-2);
  }

  .invites span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
