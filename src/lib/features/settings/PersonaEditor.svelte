<script lang="ts">
  import PlusIcon from 'phosphor-svelte/lib/PlusIcon';
  import TrashIcon from 'phosphor-svelte/lib/TrashIcon';

  import type { PersonaTriggerView } from '#src/generated/PersonaTriggerView';
  import type { PersonaView } from '#src/generated/PersonaView';

  import { useCoreClient } from '#lib/core/context.js';
  import { i18n } from '#lib/i18n.js';
  import { formatPronouns, parsePronouns } from '#lib/personas/pronouns.js';
  import Alert from '#lib/ui/primitives/Alert.svelte';
  import Avatar from '#lib/ui/primitives/Avatar.svelte';
  import Button from '#lib/ui/primitives/Button.svelte';
  import DialogFrame from '#lib/ui/primitives/DialogFrame.svelte';
  import IconButton from '#lib/ui/primitives/IconButton.svelte';
  import Switch from '#lib/ui/primitives/Switch.svelte';
  import TextInput from '#lib/ui/primitives/TextInput.svelte';

  interface Props {
    open?: boolean;
    persona: PersonaView | null;
    onSave: (persona: PersonaView, previousId: string | null) => Promise<void>;
    onOpenChange: (open: boolean) => void;
  }

  let { open = $bindable(false), persona, onSave, onOpenChange }: Props = $props();
  const core = useCoreClient();

  let name = $state('');
  let avatarUrl = $state<string | null>(null);
  let pronouns = $state('');
  let colorLight = $state('');
  let colorDark = $state('');
  let triggers = $state<PersonaTriggerView[]>([]);
  let saving = $state(false);
  let error = $state<string | null>(null);

  $effect(() => {
    if (!open) return;
    name = persona?.display_name ?? '';
    avatarUrl = persona?.avatar_url ?? null;
    pronouns = formatPronouns(persona?.pronouns ?? []);
    colorLight = persona?.color_on_light ?? '';
    colorDark = persona?.color_on_dark ?? '';
    triggers = persona?.triggers.map((trigger) => ({ ...trigger })) ?? [];
    error = null;
  });

  async function pickAvatar(event: Event & { currentTarget: HTMLInputElement }): Promise<void> {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';
    if (!file) return;

    saving = true;
    error = null;
    try {
      avatarUrl = await core.commands.uploadMedia(
        file.type || 'image/*',
        new Uint8Array(await file.arrayBuffer())
      );
    } catch (cause) {
      console.warn('[sable personas] uploading the picture failed', cause);
      error = $i18n.t('personas.saveFailed');
    } finally {
      saving = false;
    }
  }

  function addTrigger(): void {
    triggers = [...triggers, { prefix: '', suffix: null, keep_trigger: false }];
  }

  function removeTrigger(index: number): void {
    triggers = triggers.filter((_, position) => position !== index);
  }

  async function submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    const displayName = name.trim();
    if (displayName === '') {
      error = $i18n.t('personas.nameRequired');
      return;
    }

    saving = true;
    error = null;
    try {
      await onSave(
        {
          id: displayName,
          display_name: displayName,
          avatar_url: avatarUrl,
          pronouns: parsePronouns(pronouns),
          color_on_light: colorLight.trim() || null,
          color_on_dark: colorDark.trim() || null,
          triggers: triggers
            .map((trigger) => ({
              prefix: trigger.prefix?.trim() || null,
              suffix: trigger.suffix?.trim() || null,
              keep_trigger: trigger.keep_trigger,
            }))
            .filter((trigger) => trigger.prefix !== null || trigger.suffix !== null),
          pluralkit: persona?.pluralkit ?? null,
        },
        persona?.id ?? null
      );
      onOpenChange(false);
    } catch (cause) {
      console.warn('[sable personas] saving failed', cause);
      error = $i18n.t('personas.saveFailed');
    } finally {
      saving = false;
    }
  }
</script>

<DialogFrame bind:open variant="settings" label={$i18n.t('personas.editorTitle')} {onOpenChange}>
  <form class="persona-editor" onsubmit={(event) => void submit(event)}>
    <h2>{$i18n.t('personas.editorTitle')}</h2>
    {#if error}<Alert variant="critical" aria-live="polite">{error}</Alert>{/if}

    <div class="identity">
      <Avatar src={avatarUrl} {name} size="large" />
      <div class="identity-actions">
        <label class="file-button sable-button sable-button-secondary sable-button-small">
          <input type="file" accept="image/*" onchange={(event) => void pickAvatar(event)} />
          {$i18n.t('personas.avatarChoose')}
        </label>
        {#if avatarUrl}
          <Button
            variant="danger"
            size="small"
            onclick={() => {
              avatarUrl = null;
            }}
          >
            {$i18n.t('personas.avatarRemove')}
          </Button>
        {/if}
      </div>
    </div>

    <label class="field">
      <span>{$i18n.t('personas.name')}</span>
      <TextInput bind:value={name} required maxlength={128} />
      <small>{$i18n.t('personas.nameHint')}</small>
    </label>

    <label class="field">
      <span>{$i18n.t('personas.pronouns')}</span>
      <TextInput bind:value={pronouns} placeholder={$i18n.t('personas.pronounsPlaceholder')} />
    </label>

    <div class="colors">
      <label class="field">
        <span>{$i18n.t('personas.colorLight')}</span>
        <TextInput bind:value={colorLight} type="color" />
      </label>
      <label class="field">
        <span>{$i18n.t('personas.colorDark')}</span>
        <TextInput bind:value={colorDark} type="color" />
      </label>
    </div>

    <fieldset class="triggers">
      <legend>{$i18n.t('personas.triggers')}</legend>
      <p>{$i18n.t('personas.triggersHint')}</p>
      {#each triggers as trigger, index (index)}
        <div class="trigger-row">
          <label class="field">
            <span>{$i18n.t('personas.triggerPrefix')}</span>
            <TextInput
              value={trigger.prefix ?? ''}
              oninput={(event: Event & { currentTarget: HTMLInputElement }) => {
                triggers[index] = { ...trigger, prefix: event.currentTarget.value };
              }}
            />
          </label>
          <label class="field">
            <span>{$i18n.t('personas.triggerSuffix')}</span>
            <TextInput
              value={trigger.suffix ?? ''}
              oninput={(event: Event & { currentTarget: HTMLInputElement }) => {
                triggers[index] = { ...trigger, suffix: event.currentTarget.value };
              }}
            />
          </label>
          <Switch
            label={$i18n.t('personas.triggerKeep')}
            checked={trigger.keep_trigger}
            onCheckedChange={(checked: boolean) => {
              triggers[index] = { ...trigger, keep_trigger: checked };
            }}
          />
          <IconButton
            variant="ghost"
            size="small"
            label={$i18n.t('personas.triggerRemove')}
            onclick={() => {
              removeTrigger(index);
            }}
          >
            <TrashIcon />
          </IconButton>
        </div>
      {/each}
      <Button variant="secondary" size="small" onclick={addTrigger}>
        <PlusIcon />
        {$i18n.t('personas.triggerAdd')}
      </Button>
    </fieldset>

    <div class="actions">
      <Button
        variant="secondary"
        onclick={() => {
          onOpenChange(false);
        }}
      >
        {$i18n.t('personas.cancel')}
      </Button>
      <Button type="submit" loading={saving}>{$i18n.t('personas.save')}</Button>
    </div>
  </form>
</DialogFrame>

<style>
  .persona-editor {
    display: grid;
    gap: var(--space-3);
    padding: var(--space-3);
  }

  h2 {
    font-size: var(--font-size-large);
    line-height: var(--line-height-heading);
    margin: 0;
  }

  .identity {
    align-items: center;
    display: flex;
    gap: var(--space-3);
  }

  .identity-actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
  }

  .file-button {
    cursor: pointer;
  }

  .file-button input {
    height: 1px;
    opacity: 0;
    position: absolute;
    width: 1px;
  }

  .field {
    display: grid;
    gap: var(--space-1);
    min-width: 0;
  }

  .field span {
    font-weight: var(--font-weight-medium);
  }

  .field small {
    color: var(--sable-surface-var-on-container);
    font-size: var(--font-size-small);
  }

  .colors {
    display: grid;
    gap: var(--space-2);
  }

  .triggers {
    border: var(--border-width) solid var(--sable-bg-container-line);
    border-radius: var(--radius);
    display: grid;
    gap: var(--space-2);
    margin: 0;
    padding: var(--space-2) var(--space-3) var(--space-3);
  }

  .triggers legend {
    font-weight: var(--font-weight-medium);
    padding: 0 var(--space-1);
  }

  .triggers p {
    color: var(--sable-surface-var-on-container);
    font-size: var(--font-size-small);
    margin: 0;
  }

  .trigger-row {
    align-items: end;
    display: grid;
    gap: var(--space-2);
  }

  .actions {
    display: flex;
    gap: var(--space-2);
    justify-content: flex-end;
  }

  @media (width >= 34rem) {
    .colors {
      grid-template-columns: 1fr 1fr;
    }

    .trigger-row {
      grid-template-columns: 1fr 1fr auto auto;
    }
  }
</style>
