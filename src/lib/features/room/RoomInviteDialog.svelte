<script lang="ts">
  import { onDestroy, untrack } from 'svelte';
  import type { RoomListItemView } from '#src/generated/protocol';

  import { useCoreClient } from '#lib/core/context.js';
  import { i18n } from '#lib/i18n.js';
  import { isUserId } from '#lib/guards.js';
  import Alert from '#lib/ui/primitives/Alert.svelte';
  import Avatar from '#lib/ui/primitives/Avatar.svelte';
  import Button from '#lib/ui/primitives/Button.svelte';
  import DialogActions from '#lib/ui/primitives/DialogActions.svelte';
  import DialogFrame from '#lib/ui/primitives/DialogFrame.svelte';
  import FormField from '#lib/ui/primitives/FormField.svelte';
  import TextInput from '#lib/ui/primitives/TextInput.svelte';
  import '#lib/ui/primitives/menu.css';
  import { scrollHint } from '#lib/ui/scroll-hint.js';
  import { UserDirectoryLookup } from './members/user-directory-lookup.svelte.js';

  interface Props {
    open: boolean;
    room: RoomListItemView | null;
    onOpenChange: (open: boolean) => void;
  }

  let { open, room, onOpenChange }: Props = $props();
  const core = useCoreClient();

  let draft = $state('');
  let invalid = $state(false);
  let inviting = $state(false);
  let invited = $state<string | null>(null);
  let failed = $state(false);
  let convertPrompt = $state(false);
  let converting = $state(false);
  const directory = new UserDirectoryLookup(core);

  let roomId = $derived(room?.room_id ?? null);
  let isDirect = $derived(room?.is_direct ?? false);
  let suggestions = $derived(directory.results.filter((entry) => entry.user_id !== draft.trim()));

  $effect(() => {
    void roomId;
    if (!open) return;
    untrack(() => {
      setDraft('');
      invalid = false;
      invited = null;
      failed = false;
      converting = false;
      convertPrompt = isDirect;
    });
  });

  function setDraft(next: string): void {
    draft = next;
    directory.search(next.trim());
  }

  onDestroy(() => {
    directory.cancel();
  });

  async function invite(candidate = draft.trim()): Promise<void> {
    const target = roomId;
    if (!target || inviting) return;
    if (!isUserId(candidate)) {
      invalid = true;
      return;
    }

    invalid = false;
    inviting = true;
    failed = false;
    try {
      await core.rpc.rooms.invite({ room_id: target, user_id: candidate });
      invited = candidate;
      setDraft('');
    } catch (error) {
      console.warn('[sable room] invite failed', error);
      failed = true;
    } finally {
      inviting = false;
    }
  }

  async function convertAndInvite(): Promise<void> {
    const target = roomId;
    if (!target || converting) return;

    converting = true;
    failed = false;
    try {
      await core.rpc.account.setDirect({ room_id: target, direct: false, user_id: null });
      convertPrompt = false;
    } catch (error) {
      console.warn('[sable room] convert failed', error);
      failed = true;
    } finally {
      converting = false;
    }
  }
</script>

<DialogFrame {open} {onOpenChange} variant="verification" label={i18n.t('room.inviteTitle')}>
  <div class="invite">
    <h2>{i18n.t('room.inviteTitle')}</h2>

    {#if convertPrompt}
      <p class="explain">{i18n.t('room.inviteConvertBody')}</p>
      {#if failed}
        <Alert variant="critical" role="alert">{i18n.t('room.inviteSendFailed')}</Alert>
      {/if}
      <DialogActions>
        <Button
          variant="ghost"
          onclick={() => {
            onOpenChange(false);
          }}
        >
          {i18n.t('common.cancel')}
        </Button>
        <Button
          loading={converting}
          onclick={() => {
            void convertAndInvite();
          }}
        >
          {i18n.t('room.inviteConvertConfirm')}
        </Button>
      </DialogActions>
    {:else}
      <p class="explain">
        {i18n.t('room.inviteBody', { name: room?.name ?? room?.room_id ?? '' })}
      </p>

      <FormField fieldId="room-invite-user" label={i18n.t('common.invitePeople')}>
        <TextInput
          id="room-invite-user"
          bind:value={() => draft, setDraft}
          placeholder={i18n.t('room.createInvitePlaceholder')}
          onkeydown={(event: KeyboardEvent) => {
            if (event.key !== 'Enter') return;
            event.preventDefault();
            void invite();
          }}
        />
      </FormField>

      {#if suggestions.length > 0}
        <ul class="suggestions" {@attach scrollHint}>
          {#each suggestions as entry (entry.user_id)}
            {@const name = entry.display_name ?? entry.user_id}
            <li>
              <button
                type="button"
                class="menu-item"
                onclick={() => {
                  setDraft(entry.user_id);
                  document.getElementById('room-invite-user')?.focus();
                }}
              >
                <Avatar size="small" id={entry.user_id} src={entry.avatar_url} {name} />
                <span class="identity">
                  <span class="name">{name}</span>
                  <span class="user-id">{entry.user_id}</span>
                </span>
              </button>
            </li>
          {/each}
        </ul>
      {/if}

      {#if invalid}
        <Alert variant="critical" role="alert">{i18n.t('common.userIdFormatHint')}</Alert>
      {:else if failed}
        <Alert variant="critical" role="alert">{i18n.t('room.inviteSendFailed')}</Alert>
      {:else if invited}
        <Alert variant="success" role="status">
          {i18n.t('room.inviteSent', { user: invited })}
        </Alert>
      {/if}

      <DialogActions>
        <Button
          variant="ghost"
          onclick={() => {
            onOpenChange(false);
          }}
        >
          {i18n.t('common.close')}
        </Button>
        <Button
          loading={inviting}
          onclick={() => {
            void invite();
          }}
        >
          {i18n.t('room.inviteSubmit')}
        </Button>
      </DialogActions>
    {/if}
  </div>
</DialogFrame>

<style>
  .invite {
    display: grid;
    gap: var(--space-400);
    width: min(24rem, calc(100vw - 2rem));
  }

  h2 {
    font-size: var(--font-size-heading);
    line-height: var(--line-height-heading);
    margin: 0;
  }

  .explain {
    color: var(--surface-var-on-container);
    margin: 0;
  }

  .suggestions {
    display: grid;
    list-style: none;
    margin: 0;
    max-height: 16rem;
    overflow: auto;
    padding: 0;
  }

  .suggestions :global(.menu-item) {
    --menu-item-height: var(--control-height-500);
    --menu-item-gap: var(--space-200);
  }

  .identity {
    display: grid;
    min-width: 0;
  }

  .name,
  .user-id {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .user-id {
    color: var(--surface-var-on-container);
    font-size: var(--font-size-small);
  }
</style>
