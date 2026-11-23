<script lang="ts">
  import type {
    RoomPermissionsView,
    RoomPowerLevelsView,
    RoomListItemView,
    RoomRulesSettingsView,
  } from '#src/generated/protocol';

  import { useCoreClient } from '#lib/core/context.js';
  import { i18n } from '#lib/i18n.js';
  import { useRoomList } from '#lib/rooms/room-list.svelte.js';
  import { ancestorSpaceIds } from '#lib/rooms/spaces.js';
  import Alert from '#lib/ui/primitives/Alert.svelte';
  import Button from '#lib/ui/primitives/Button.svelte';
  import ConfirmDialog from '#lib/ui/primitives/ConfirmDialog.svelte';
  import FormField from '#lib/ui/primitives/FormField.svelte';
  import SaveBar from '#lib/ui/primitives/SaveBar.svelte';
  import Select from '#lib/ui/primitives/Select.svelte';
  import SettingsRow from '#lib/ui/primitives/SettingsRow.svelte';
  import SettingsSection from '#lib/ui/primitives/SettingsSection.svelte';
  import Switch from '#lib/ui/primitives/Switch.svelte';
  import { holdUnsaved } from '#lib/ui/unsaved-guard.js';

  import BioEditor from '#lib/features/settings/BioEditor.svelte';
  import { bioContent, bioHtml } from '#lib/features/settings/bio-content.js';

  import FormattedBody from '../messages/FormattedBody.svelte';
  import { ROOM_RULES_EVENT_TYPE } from '../room-rules.svelte.js';
  import { canSendState } from './permission-groups';

  import '#lib/ui/primitives/settings-row.css';

  const NO_DELEGATE = 'none';
  const EMPTY: RoomRulesSettingsView = { html: '', require_acceptance: false, delegate_to: null };

  interface Props {
    room: RoomListItemView | null;
    permissions: RoomPermissionsView | null;
    levels: RoomPowerLevelsView | null;
  }

  let { room, permissions, levels }: Props = $props();
  const core = useCoreClient();
  const roomList = useRoomList();
  const requireId = $props.id();
  const notifyId = `${requireId}-notify`;

  let leaving = $state.raw<{ proceed: () => void; stay?: () => void } | null>(null);

  let roomId = $derived(room?.room_id ?? null);
  let canEdit = $derived(
    canSendState(levels, permissions?.own_power_level ?? 0, ROOM_RULES_EVENT_TYPE)
  );
  let attempt = $state(0);
  let loaded = $derived(roomId === null ? EMPTY : await ownRules(roomId));
  // An editor filled with blanks would overwrite rules that could not be read.
  let unavailable = $derived(loaded === null);
  let saved = $derived<RoomRulesSettingsView>(loaded ?? EMPTY);
  let applied = $derived(
    roomId === null || canEdit
      ? null
      : await core.rpc.room_state.rules({ room_id: roomId }).catch((error: unknown) => {
          console.debug('[sable room] rules unavailable', error);
          return null;
        })
  );
  let savedText = $derived(bioContent(saved.html));
  let text = $derived(savedText);
  // The switch shows off without text, so stored acceptance alone must not count as an edit.
  let savedRequired = $derived(saved.require_acceptance && saved.html !== '');
  let requireAcceptance = $derived(savedRequired);
  let delegate = $derived(saved.delegate_to ?? NO_DELEGATE);
  let notify = $state(false);
  let saving = $state(false);
  let savedNotice = $state(false);
  let failed = $state(false);

  let delegates = $derived.by(() => {
    const ids = roomId === null ? [] : ancestorSpaceIds(roomList.roomSpaces(roomId));
    if (saved.delegate_to !== null && !ids.includes(saved.delegate_to)) ids.push(saved.delegate_to);
    return [
      { value: NO_DELEGATE, label: i18n.t('room.rulesDelegateNone') },
      ...ids.map((id) => ({ value: id, label: spaceName(id) })),
    ];
  });
  let empty = $derived(text.body.trim() === '');
  let required = $derived(requireAcceptance && !empty);
  let textChanged = $derived(
    text.body !== savedText.body || text.formatted !== savedText.formatted
  );
  let canNotify = $derived(saved.html !== '' && textChanged && required);
  let dirty = $derived(
    textChanged || required !== savedRequired || delegate !== (saved.delegate_to ?? NO_DELEGATE)
  );
  // After the awaited state, since a remounted page can mount before that state is assigned.
  holdUnsaved({
    dirty: () => canEdit && !unavailable && dirty && leaving === null,
    ask: (proceed, stay) => {
      leaving = { proceed, stay };
    },
  });

  let isSpace = $derived(room?.room_kind === 'space');
  let notice = $derived.by(() => {
    if (required && !savedRequired) {
      return i18n.t('room.rulesSaveLocks');
    }
    return notify && canNotify ? i18n.t('room.rulesSaveAsksAgain') : null;
  });

  async function ownRules(target: string): Promise<RoomRulesSettingsView | null> {
    // Read before the first await, so that Retry runs the load again.
    void attempt;
    try {
      return await core.rpc.room_state.ownRules({ room_id: target });
    } catch (error) {
      console.warn('[sable room] rules unavailable', error);
      return null;
    }
  }

  function spaceName(id: string): string {
    return roomList.byId(id)?.name ?? id;
  }

  function touched(): void {
    failed = false;
    savedNotice = false;
  }

  function reset(): void {
    text = savedText;
    requireAcceptance = savedRequired;
    delegate = saved.delegate_to ?? NO_DELEGATE;
    notify = false;
    touched();
  }

  async function save(): Promise<void> {
    const target = roomId;
    if (!target || saving) return;

    const next: RoomRulesSettingsView = {
      html: empty ? '' : (bioHtml(text) ?? ''),
      require_acceptance: required,
      delegate_to: delegate === NO_DELEGATE ? null : delegate,
    };
    saving = true;
    failed = false;
    try {
      await core.rpc.room_state.setRules({
        room_id: target,
        body: empty ? '' : text.body,
        formatted: text.formatted,
        require_acceptance: next.require_acceptance,
        delegate_to: next.delegate_to,
        notify: notify && canNotify,
      });
      saved = next;
      notify = false;
      savedNotice = true;
    } catch (error) {
      console.warn('[sable room] rules save failed', error);
      failed = true;
    } finally {
      saving = false;
    }
  }

  function stay(): void {
    const pending = leaving;
    leaving = null;
    pending?.stay?.();
  }

  function discardAndLeave(): void {
    const pending = leaving;
    leaving = null;
    reset();
    pending?.proceed();
  }
</script>

<SettingsSection
  headingId="room-settings-rules"
  title={i18n.t('room.rulesTitle')}
  description={canEdit
    ? i18n.t(isSpace ? 'room.rulesSettingsHintSpace' : 'room.rulesSettingsHint')
    : undefined}
>
  {#if canEdit && unavailable}
    <Alert variant="critical" role="alert" class="settings-form">
      <p>{i18n.t('room.rulesLoadFailed')}</p>
      <div>
        <Button size="small" onclick={() => (attempt += 1)}>{i18n.t('common.retry')}</Button>
      </div>
    </Alert>
  {:else if canEdit}
    <div class="settings-form">
      <FormField fieldId="room-rules-text" label={i18n.t('room.rulesText')}>
        <BioEditor
          id="room-rules-text"
          bind:value={
            () => text,
            (next) => {
              text = next;
              touched();
            }
          }
          label={i18n.t('room.rulesText')}
          formattingLabel={i18n.t('room.rulesFormatting')}
          placeholder={i18n.t('room.rulesTextPlaceholder')}
        />
      </FormField>
      <ul class="settings-rows">
        <SettingsRow
          title={i18n.t('room.rulesRequire')}
          description={empty
            ? i18n.t('room.rulesRequireEmpty')
            : i18n.t(isSpace ? 'room.rulesRequireHintSpace' : 'room.rulesRequireHint')}
          disabled={empty}
          control={requireId}
        >
          <Switch
            id={requireId}
            checked={required}
            disabled={empty}
            label={i18n.t('room.rulesRequire')}
            onCheckedChange={(next: boolean) => {
              requireAcceptance = next;
              touched();
            }}
          />
        </SettingsRow>
        {#if canNotify}
          <SettingsRow
            title={i18n.t('room.rulesNotify')}
            description={i18n.t('room.rulesNotifyHint')}
            control={notifyId}
          >
            <Switch id={notifyId} bind:checked={notify} label={i18n.t('room.rulesNotify')} />
          </SettingsRow>
        {/if}
        {#if delegates.length > 1}
          <SettingsRow
            title={i18n.t('room.rulesDelegate')}
            description={delegate === NO_DELEGATE
              ? i18n.t('room.rulesDelegateHint')
              : i18n.t('room.rulesDelegateActive', { name: spaceName(delegate) })}
          >
            <Select
              bind:value={delegate}
              aria-label={i18n.t('room.rulesDelegate')}
              items={delegates}
              onValueChange={touched}
            />
          </SettingsRow>
        {/if}
      </ul>
    </div>
  {:else if applied}
    <div class="settings-form">
      {#if applied.source_room_id !== roomId}
        <p class="settings-note">
          {i18n.t('room.rulesFromSpace', { name: spaceName(applied.source_room_id) })}
        </p>
      {/if}
      <div class="rules-body"><FormattedBody html={applied.html} /></div>
      {#if applied.require_acceptance}
        <p class="settings-note">{i18n.t('room.rulesMustAccept')}</p>
      {/if}
    </div>
  {:else}
    <p class="settings-note settings-form">{i18n.t('room.rulesNone')}</p>
  {/if}
</SettingsSection>

{#if canEdit && !unavailable}
  <SaveBar
    {dirty}
    {saving}
    saved={savedNotice}
    {failed}
    {notice}
    onReset={reset}
    onSave={() => void save()}
  />
{/if}

<ConfirmDialog
  open={leaving !== null}
  onOpenChange={(next: boolean) => {
    if (!next) stay();
  }}
  title={i18n.t('room.rulesDiscardTitle')}
  confirmLabel={i18n.t('emotes.leaveDiscard')}
  cancelLabel={i18n.t('emotes.leaveStay')}
  onConfirm={discardAndLeave}
  onCancel={stay}
/>

<style>
  .rules-body {
    overflow-wrap: anywhere;
  }
</style>
