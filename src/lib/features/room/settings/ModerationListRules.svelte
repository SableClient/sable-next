<script lang="ts">
  import ArrowsClockwiseIcon from 'phosphor-svelte/lib/ArrowsClockwiseIcon';
  import TrashIcon from 'phosphor-svelte/lib/TrashIcon';

  import { useCoreClient } from '#lib/core/context.js';
  import { joinRoom } from '#lib/core/api/rooms.js';
  import { i18n } from '#lib/i18n.js';
  import { addPolicy, removePolicy } from '#lib/rooms/meowlnir-commands.js';
  import {
    filterPolicyRules,
    parsePolicyRules,
    policyKindOf,
    type PolicyAction,
    type PolicyRule,
  } from '#lib/rooms/meowlnir-policies.js';
  import { useRoomList } from '#lib/rooms/room-list.svelte.js';
  import Button from '#lib/ui/primitives/Button.svelte';
  import ConfirmDialog from '#lib/ui/primitives/ConfirmDialog.svelte';
  import FormField from '#lib/ui/primitives/FormField.svelte';
  import IconButton from '#lib/ui/primitives/IconButton.svelte';
  import SearchField from '#lib/ui/primitives/SearchField.svelte';
  import Select from '#lib/ui/primitives/Select.svelte';
  import SettingsRow from '#lib/ui/primitives/SettingsRow.svelte';
  import Spinner from '#lib/ui/primitives/Spinner.svelte';
  import TextInput from '#lib/ui/primitives/TextInput.svelte';
  import { toasts } from '#lib/ui/toasts.svelte.js';

  const PAGE = 50;
  const ACTIONS: readonly PolicyAction[] = ['ban', 'takedown', 'unban', 'mute'];

  interface Props {
    managementRoomId: string;
    listRoomId: string;
    name: string;
    /** Meowlnir names a list by its short name in commands, so a list without one is read-only. */
    shortcode: string | null;
    canEdit: boolean;
  }

  let { managementRoomId, listRoomId, name, shortcode, canEdit }: Props = $props();
  const core = useCoreClient();
  const roomList = useRoomList();
  const fieldId = $props.id();

  let joined = $derived(roomList.byId(listRoomId)?.state === 'joined');
  let rules = $state.raw<PolicyRule[] | null>(null);
  let failed = $state(false);
  let joining = $state(false);
  let query = $state('');
  let shown = $state(PAGE);
  let draft = $state({ action: 'ban' as string, entity: '', reason: '' });
  let sending = $state(false);
  let pendingRemoval = $state<PolicyRule | null>(null);
  let run = 0;

  let matching = $derived(filterPolicyRules(rules ?? [], query));
  let entity = $derived(draft.entity.trim());
  let writable = $derived(canEdit && shortcode !== null);

  async function load(): Promise<void> {
    const current = ++run;
    failed = false;
    try {
      const events = await core.rpc.room_state.fullState({ room_id: listRoomId });
      if (current === run) rules = parsePolicyRules(events);
    } catch (error) {
      console.warn('[sable room] policy list unavailable', error);
      if (current === run) failed = true;
    }
  }

  $effect(() => {
    if (joined) void load();
    return () => {
      run += 1;
    };
  });

  async function join(): Promise<void> {
    joining = true;
    try {
      await joinRoom(core.rpc, listRoomId);
    } catch (error) {
      console.warn('[sable room] joining the policy list failed', error);
      toasts.error(i18n.t('room.moderationListJoinFailed'));
    } finally {
      joining = false;
    }
  }

  async function command(send: () => Promise<void>): Promise<boolean> {
    sending = true;
    try {
      await send();
      toasts.info(i18n.t('room.moderationRuleSent'));
      return true;
    } catch (error) {
      console.warn('[sable room] meowlnir command failed', error);
      toasts.error(i18n.t('errors.actionFailed'));
      return false;
    } finally {
      sending = false;
    }
  }

  async function add(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (shortcode === null || policyKindOf(entity) === null) return;
    const sent = await command(() =>
      addPolicy(
        core,
        managementRoomId,
        draft.action as PolicyAction,
        shortcode,
        entity,
        draft.reason.trim()
      )
    );
    if (sent) draft = { action: draft.action, entity: '', reason: '' };
  }

  function confirmRemoval(): void {
    const rule = pendingRemoval;
    pendingRemoval = null;
    if (!rule?.entity || shortcode === null) return;
    const target = rule.entity;
    void command(() => removePolicy(core, managementRoomId, shortcode, target));
  }
</script>

{#if !joined}
  <SettingsRow class="nested" title={i18n.t('room.moderationListNotJoined')}>
    <Button size="small" loading={joining} onclick={() => void join()}>
      {i18n.t('common.join')}
    </Button>
  </SettingsRow>
{:else if rules === null}
  <SettingsRow class="nested">
    {#snippet copy()}
      {#if failed}
        <p class="settings-note" role="alert">{i18n.t('room.moderationRulesFailed')}</p>
      {:else}
        <span role="status"><Spinner small label={i18n.t('room.moderationRulesLoading')} /></span>
      {/if}
    {/snippet}
    {#if failed}
      <Button size="small" onclick={() => void load()}>{i18n.t('common.refresh')}</Button>
    {/if}
  </SettingsRow>
{:else}
  <SettingsRow class="nested" title={i18n.t('room.moderationRulesCount', { count: rules.length })}>
    {#if rules.length > PAGE / 5}
      <SearchField
        class="rule-search"
        label={i18n.t('room.moderationRulesSearch', { name })}
        placeholder={i18n.t('room.moderationRulesSearchPlaceholder')}
        bind:value={query}
        oninput={() => {
          shown = PAGE;
        }}
      />
    {/if}
    <IconButton
      variant="subtle"
      size="small"
      label={i18n.t('room.moderationRulesRefresh', { name })}
      onclick={() => void load()}
    >
      <ArrowsClockwiseIcon />
    </IconButton>
  </SettingsRow>
  {#each matching.slice(0, shown) as rule (rule.key)}
    <SettingsRow
      class="nested"
      title={rule.entity ?? i18n.t('room.moderationRuleHidden')}
      description={rule.reason ?? undefined}
      badge={rule.action ? i18n.t(`room.moderationRuleAction.${rule.action}`) : rule.recommendation}
    >
      {#if writable && rule.entity !== null}
        <IconButton
          variant="subtle"
          size="small"
          disabled={sending}
          label={i18n.t('room.moderationRuleRemove', { entity: rule.entity })}
          onclick={() => {
            pendingRemoval = rule;
          }}
        >
          <TrashIcon />
        </IconButton>
      {/if}
    </SettingsRow>
  {/each}
  {#if matching.length > shown}
    <SettingsRow
      class="nested"
      title={i18n.t('room.moderationRulesMore', { count: matching.length - shown })}
    >
      <Button
        size="small"
        onclick={() => {
          shown += PAGE;
        }}
      >
        {i18n.t('common.loadMore')}
      </Button>
    </SettingsRow>
  {:else if matching.length === 0 && rules.length > 0}
    <SettingsRow class="nested" title={i18n.t('room.moderationRulesNoMatch')} />
  {/if}
  {#if writable}
    <li class="add-rule">
      <form class="settings-form" onsubmit={add}>
        <FormField fieldId="{fieldId}-entity" label={i18n.t('room.moderationRuleEntity')}>
          <TextInput
            id="{fieldId}-entity"
            bind:value={draft.entity}
            placeholder={i18n.t('room.moderationRuleEntityPlaceholder')}
            autocapitalize="off"
            autocomplete="off"
            spellcheck={false}
          />
        </FormField>
        <FormField fieldId="{fieldId}-action" label={i18n.t('room.moderationRuleActionLabel')}>
          <Select
            id="{fieldId}-action"
            bind:value={draft.action}
            items={ACTIONS.map((action) => ({
              value: action,
              label: i18n.t(`room.moderationRuleActionChoice.${action}`),
            }))}
            forceDropdown
          />
        </FormField>
        <FormField fieldId="{fieldId}-reason" label={i18n.t('room.moderationRuleReason')}>
          <TextInput id="{fieldId}-reason" bind:value={draft.reason} />
        </FormField>
        <div class="actions">
          <Button type="submit" loading={sending} disabled={policyKindOf(entity) === null}>
            {i18n.t('room.moderationRuleAdd')}
          </Button>
        </div>
      </form>
    </li>
  {:else if canEdit}
    <SettingsRow class="nested" description={i18n.t('room.moderationRulesNoShortcode')} />
  {/if}
{/if}

<ConfirmDialog
  open={pendingRemoval !== null}
  onOpenChange={(next: boolean) => {
    if (!next) pendingRemoval = null;
  }}
  title={i18n.t('room.moderationRuleRemoveConfirm', { entity: pendingRemoval?.entity ?? '' })}
  description={i18n.t('room.moderationRuleRemoveConfirmHint', { name })}
  confirmLabel={i18n.t('common.remove')}
  onConfirm={confirmRemoval}
/>

<style>
  .add-rule {
    box-shadow: inset 0 var(--border-width) 0 var(--bg-container-line);
    padding-inline-start: var(--space-400);
  }

  .actions {
    display: flex;
    justify-content: flex-end;
  }

  :global(.rule-search) {
    flex: 1 1 calc(3 * var(--space-900));
  }
</style>
