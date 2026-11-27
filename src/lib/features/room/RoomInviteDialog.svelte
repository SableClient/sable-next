<script lang="ts">
  import { onDestroy, untrack } from 'svelte';
  import type {
    HistoryVisibilityView,
    InviteHistoryView,
    RoomListItemView,
  } from '#src/generated/protocol';

  import { useCoreClient } from '#lib/core/context.js';
  import { i18n } from '#lib/i18n.js';
  import { isUserId } from '#lib/guards.js';
  import { showSettingsOver } from '#lib/features/settings/settings-navigation.js';
  import { SETTINGS_DEVICES_SECTION } from '#lib/settings/registry.js';
  import Alert from '#lib/ui/primitives/Alert.svelte';
  import Button from '#lib/ui/primitives/Button.svelte';
  import DialogActions from '#lib/ui/primitives/DialogActions.svelte';
  import DialogFrame from '#lib/ui/primitives/DialogFrame.svelte';
  import FormField from '#lib/ui/primitives/FormField.svelte';
  import TextInput from '#lib/ui/primitives/TextInput.svelte';
  import { isComposingKey } from '#lib/ui/shortcuts/binding.js';
  import { UserDirectoryLookup } from './members/user-directory-lookup.svelte.js';
  import UserSuggestionList from './members/UserSuggestionList.svelte';

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
  let invited = $state<{ userId: string; history: InviteHistoryView } | null>(null);
  let failed = $state(false);
  let convertPrompt = $state(false);
  let converting = $state(false);
  const directory = new UserDirectoryLookup(core);

  let roomId = $derived(room?.room_id ?? null);
  let encrypted = $derived(room?.encrypted === true);
  let isDirect = $derived(room?.is_direct ?? false);
  let history = $state<HistoryVisibilityView | 'unknown' | null>(null);
  let historyShared = $derived(history === 'shared' || history === 'world_readable');
  let noCrossSigning = $state(false);
  let recipient = $state<{ userId: string; noVerified: boolean; stranger: boolean } | null>(null);
  let candidate = $derived(isUserId(draft.trim()) ? draft.trim() : null);
  let sharesHistory = $derived(historyShared && !noCrossSigning);
  let historyNote = $derived.by(() => {
    if (history === null) return null;
    if (history === 'unknown') return i18n.t('room.inviteHistoryUnknown');
    if (history === 'invited') return i18n.t('room.inviteHistoryFromInvite');
    if (historyShared && noCrossSigning) return i18n.t('room.inviteHistoryNeedsCrossSigning');
    return i18n.t(historyShared ? 'room.inviteHistoryShared' : 'room.inviteHistoryHidden');
  });
  let suggestions = $derived(directory.results.filter((entry) => entry.user_id !== draft.trim()));
  let suggestionList = $state<UserSuggestionList>();

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

  $effect(() => {
    const target = roomId;
    history = null;
    if (!open || !target || !encrypted) return;
    let current = true;
    void core.rpc.room_state
      .historyVisibility({ room_id: target })
      .then((visibility) => {
        if (current) history = visibility;
      })
      .catch((error: unknown) => {
        console.debug('[sable room] history visibility unavailable', error);
        if (current) history = 'unknown';
      });
    return () => {
      current = false;
    };
  });

  $effect(() => {
    noCrossSigning = false;
    if (!historyShared) return;
    let current = true;
    void core.rpc.encryption
      .status()
      .then((status) => {
        if (current) noCrossSigning = status.verification === 'unknown';
      })
      .catch((error: unknown) => {
        console.debug('[sable room] encryption status unavailable', error);
      });
    return () => {
      current = false;
    };
  });

  $effect(() => {
    const userId = candidate;
    recipient = null;
    if (!sharesHistory || !userId) return;
    let current = true;
    const timer = setTimeout(() => {
      void Promise.all([
        core.rpc.encryption.userSecurity({ user_id: userId }),
        core.userRelations(userId),
      ])
        .then(([security, relations]) => {
          if (!current) return;
          recipient = {
            userId,
            noVerified: !security.devices.some((device) => device.cross_signed),
            stranger: relations.mutual_rooms.length === 0,
          };
        })
        .catch((error: unknown) => {
          console.debug('[sable room] invitee checks unavailable', error);
        });
    }, 400);
    return () => {
      current = false;
      clearTimeout(timer);
    };
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
      const history = await core.rpc.rooms.invite({ room_id: target, user_id: candidate });
      invited = { userId: candidate, history };
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
          role="combobox"
          aria-expanded={suggestions.length > 0}
          aria-controls={suggestions.length > 0 ? 'room-invite-suggestions' : undefined}
          aria-activedescendant={suggestionList?.activeOptionId()}
          aria-autocomplete="list"
          bind:value={() => draft, setDraft}
          placeholder={i18n.t('room.createInvitePlaceholder')}
          onkeydown={(event: KeyboardEvent) => {
            if (isComposingKey(event) || suggestionList?.handleKey(event)) return;
            if (event.key !== 'Enter') return;
            event.preventDefault();
            void invite();
          }}
        />
      </FormField>

      {#if suggestions.length > 0}
        <UserSuggestionList
          bind:this={suggestionList}
          id="room-invite-suggestions"
          entries={suggestions}
          onSelect={(userId) => {
            setDraft(userId);
            document.getElementById('room-invite-user')?.focus();
          }}
        />
      {/if}

      {#if invalid}
        <Alert variant="critical" role="alert">{i18n.t('common.userIdFormatHint')}</Alert>
      {:else if failed}
        <Alert variant="critical" role="alert">{i18n.t('room.inviteSendFailed')}</Alert>
      {:else if invited}
        <Alert variant={invited.history === 'failed' ? 'warning' : 'success'} role="status">
          {#if invited.history === 'failed'}
            {i18n.t('room.inviteSentHistoryFailed', { user: invited.userId })}
          {:else}
            {i18n.t(
              invited.history === 'shared' ? 'room.inviteSentWithHistory' : 'room.inviteSent',
              { user: invited.userId }
            )}
          {/if}
        </Alert>
      {/if}

      <p class="explain history-note" aria-live="polite" hidden={!historyNote}>{historyNote}</p>
      {#if historyShared && noCrossSigning}
        <Button
          variant="secondary"
          size="small"
          class="history-action"
          onclick={() => {
            onOpenChange(false);
            showSettingsOver(SETTINGS_DEVICES_SECTION);
          }}
        >
          {i18n.t('composer.openSecuritySettings')}
        </Button>
      {/if}
      {#if recipient && recipient.userId === candidate && (recipient.stranger || recipient.noVerified)}
        <Alert variant="warning" role="status">
          {#if recipient.stranger}
            <p>{i18n.t('room.inviteStranger', { user: recipient.userId })}</p>
          {/if}
          {#if recipient.noVerified}
            <p>{i18n.t('room.inviteNoVerifiedSessions', { user: recipient.userId })}</p>
          {/if}
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

  .history-note {
    font-size: var(--font-size-small);
  }

  .invite :global(.history-action) {
    justify-self: start;
  }
</style>
