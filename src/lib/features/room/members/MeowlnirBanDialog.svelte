<script lang="ts">
  import { useCoreClient } from '#lib/core/context.js';
  import { i18n } from '#lib/i18n.js';
  import { addPolicy } from '#lib/rooms/meowlnir-commands.js';
  import type { MeowlnirRoom } from '#lib/rooms/meowlnir-registry.svelte.js';
  import Alert from '#lib/ui/primitives/Alert.svelte';
  import Button from '#lib/ui/primitives/Button.svelte';
  import DialogFrame from '#lib/ui/primitives/DialogFrame.svelte';
  import FormActions from '#lib/ui/primitives/FormActions.svelte';
  import FormField from '#lib/ui/primitives/FormField.svelte';
  import Select from '#lib/ui/primitives/Select.svelte';
  import Switch from '#lib/ui/primitives/Switch.svelte';
  import TextInput from '#lib/ui/primitives/TextInput.svelte';
  import { toasts } from '#lib/ui/toasts.svelte.js';

  interface Props {
    open?: boolean;
    management: MeowlnirRoom;
    userId: string;
    name: string;
  }

  let { open = $bindable(false), management, userId, name }: Props = $props();
  const core = useCoreClient();
  const fieldId = $props.id();

  let list = $derived(management.lists[0]?.shortcode ?? '');
  let takedown = $state(false);
  let reason = $state('');
  let busy = $state(false);
  let failed = $state(false);

  async function submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (busy || list === '') return;
    busy = true;
    failed = false;
    try {
      await addPolicy(
        core,
        management.roomId,
        takedown ? 'takedown' : 'ban',
        list,
        userId,
        reason.trim()
      );
      toasts.info(i18n.t('timeline.meowlnirBanSent'));
      open = false;
    } catch (error) {
      console.warn('[sable room] meowlnir ban failed', error);
      failed = true;
    } finally {
      busy = false;
    }
  }
</script>

<DialogFrame bind:open variant="verification" label={i18n.t('timeline.meowlnirBan')}>
  <form onsubmit={submit}>
    <h2>{i18n.t('timeline.meowlnirBanTitle', { name })}</h2>
    <p class="hint">{i18n.t('timeline.meowlnirBanHint')}</p>
    {#if failed}
      <Alert variant="critical" role="alert">{i18n.t('timeline.profileModerationFailed')}</Alert>
    {/if}
    {#if management.lists.length > 1}
      <FormField fieldId="{fieldId}-list" label={i18n.t('timeline.meowlnirBanList')}>
        <Select
          id="{fieldId}-list"
          bind:value={list}
          items={management.lists.map((entry) => ({ value: entry.shortcode, label: entry.name }))}
          forceDropdown
        />
      </FormField>
    {/if}
    <FormField fieldId="{fieldId}-reason" label={i18n.t('room.moderationRuleReason')}>
      <TextInput id="{fieldId}-reason" bind:value={reason} autocomplete="off" />
    </FormField>
    <label class="takedown">
      <span>{i18n.t('timeline.meowlnirBanTakedown')}</span>
      <Switch bind:checked={takedown} label={i18n.t('timeline.meowlnirBanTakedown')} />
    </label>
    <FormActions>
      <Button type="submit" variant="danger" loading={busy}>
        {i18n.t('timeline.meowlnirBan')}
      </Button>
      <Button
        variant="ghost"
        onclick={() => {
          open = false;
        }}
      >
        {i18n.t('common.cancel')}
      </Button>
    </FormActions>
  </form>
</DialogFrame>

<style>
  form {
    display: grid;
    gap: var(--space-400);
  }

  h2 {
    font-size: var(--font-size-heading);
    line-height: var(--line-height-heading);
    margin: 0;
    overflow-wrap: anywhere;
  }

  .hint {
    color: var(--surface-var-on-container);
    font-size: var(--font-size-small);
    line-height: var(--line-height-small);
    margin: calc(-1 * var(--space-200)) 0 0;
  }

  .takedown {
    align-items: center;
    display: flex;
    gap: var(--space-400);
    justify-content: space-between;
  }
</style>
