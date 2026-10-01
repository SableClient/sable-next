<script lang="ts">
  import XIcon from 'phosphor-svelte/lib/XIcon';
  import { untrack } from 'svelte';

  import type { MemberView, RoomSummary } from '#src/generated/protocol';

  import { i18n } from '#lib/i18n.js';
  import Avatar from '#lib/ui/primitives/Avatar.svelte';
  import Button from '#lib/ui/primitives/Button.svelte';
  import IconButton from '#lib/ui/primitives/IconButton.svelte';
  import Select from '#lib/ui/primitives/Select.svelte';
  import Switch from '#lib/ui/primitives/Switch.svelte';
  import TextInput from '#lib/ui/primitives/TextInput.svelte';

  import {
    acceptsType,
    buildInvocation,
    isBooleanParameter,
    itemSchemaOf,
    literalChoices,
    literalLabel,
    type ArgumentDrafts,
    type BotCommand,
    type BotCommandInvocation,
    type BotCommandParameter,
    type LiteralValue,
    type PrimitiveType,
  } from './bot-commands';

  interface Props {
    command: BotCommand;
    drafts: ArgumentDrafts;
    members: readonly MemberView[];
    rooms: readonly RoomSummary[];
    prefix: string;
    sending?: boolean;
    onSubmit: (body: string, invocation: BotCommandInvocation) => void;
    onCancel: () => void;
  }

  let {
    command,
    drafts,
    members,
    rooms,
    prefix,
    sending = false,
    onSubmit,
    onCancel,
  }: Props = $props();

  const uid = $props.id();
  const fieldId = (key: string): string => `bot-command-${uid}-${key}`;
  const labelOf = (key: string): string => key.replaceAll('_', ' ');

  const values = $state<ArgumentDrafts>(untrack(() => ({ ...drafts })));
  const pending = $state<Record<string, string>>({});
  let errors = $state<Record<string, 'required' | 'invalid'>>({});

  const PLACEHOLDERS: Partial<Record<PrimitiveType, string>> = {
    integer: '0',
    user_id: '@user:example.org',
    server_name: 'example.org',
    room_alias: '#room:example.org',
    room_id: '!room:example.org',
    event_id: 'https://matrix.to/#/!room:example.org/$event',
  };

  function placeholderFor(parameter: BotCommandParameter): string | undefined {
    const item = itemSchemaOf(parameter.schema);
    const types =
      item.schema_type === 'primitive'
        ? [item.type]
        : item.schema_type === 'union'
          ? item.variants.flatMap((variant) =>
              variant.schema_type === 'primitive' ? [variant.type] : []
            )
          : [];
    const found = types.map((type) => PLACEHOLDERS[type]).filter((value) => value !== undefined);
    return found.length > 0 ? found.join(' / ') : undefined;
  }

  type Option = { value: string; label: string };

  function choiceOption(choice: LiteralValue): Option {
    return { value: literalLabel(choice), label: literalLabel(choice) };
  }

  function optionsFor(parameter: BotCommandParameter): Option[] {
    const options = (literalChoices(itemSchemaOf(parameter.schema)) ?? []).map(choiceOption);
    if (acceptsType(parameter.schema, 'user_id')) {
      for (const member of members) {
        if (member.membership !== 'join') continue;
        options.push({ value: member.user_id, label: member.display_name ?? member.user_id });
      }
    }
    for (const room of rooms) {
      const name = room.name ?? room.canonical_alias ?? room.room_id;
      if (acceptsType(parameter.schema, 'room_id')) {
        options.push({ value: room.room_id, label: name });
      }
      if (acceptsType(parameter.schema, 'room_alias') && room.canonical_alias) {
        options.push({ value: room.canonical_alias, label: name });
      }
    }
    return options;
  }

  function selectChoices(parameter: BotCommandParameter): Option[] | null {
    if (parameter.schema.schema_type === 'array') return null;
    return literalChoices(parameter.schema)?.map(choiceOption) ?? null;
  }

  function clearError(key: string): void {
    if (!(key in errors)) return;
    errors = Object.fromEntries(Object.entries(errors).filter(([found]) => found !== key));
  }

  function entries(key: string): string[] {
    const value = values[key];
    return Array.isArray(value) ? value : [];
  }

  function addEntry(key: string): void {
    const text = (pending[key] ?? '').trim();
    if (text === '') return;
    values[key] = [...entries(key), text];
    pending[key] = '';
    clearError(key);
  }

  function removeEntry(key: string, index: number): void {
    values[key] = entries(key).filter((_, at) => at !== index);
  }

  function errorText(key: string): string | null {
    const error = errors[key];
    if (!error) return null;
    return error === 'required'
      ? $i18n.t('composer.botCommandRequired')
      : $i18n.t('composer.botCommandInvalid');
  }

  function describedBy(parameter: BotCommandParameter): string | undefined {
    const ids = [
      parameter.description ? `${fieldId(parameter.key)}-hint` : null,
      errors[parameter.key] ? `${fieldId(parameter.key)}-error` : null,
    ].filter((id) => id !== null);
    return ids.length > 0 ? ids.join(' ') : undefined;
  }

  function submit(event: SubmitEvent & { currentTarget: HTMLFormElement }): void {
    event.preventDefault();
    for (const parameter of command.parameters) {
      if (parameter.schema.schema_type === 'array') addEntry(parameter.key);
    }
    const result = buildInvocation(command, values, prefix);
    if (!result.ok) {
      errors = result.errors;
      const [first] = Object.keys(result.errors);
      event.currentTarget.querySelector<HTMLElement>(`#${CSS.escape(fieldId(first))}`)?.focus();
      return;
    }
    errors = {};
    onSubmit(result.body, result.invocation);
  }

  function focusFirstField(node: HTMLFormElement): void {
    node.querySelector<HTMLElement>('.bot-command-fields :is(input, button)')?.focus();
  }
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<form
  class="bot-command"
  aria-label={$i18n.t('composer.botCommandForm', { command: `${prefix}${command.command}` })}
  onsubmit={submit}
  onkeydown={(event: KeyboardEvent) => {
    if (event.key !== 'Escape' || event.defaultPrevented) return;
    event.preventDefault();
    onCancel();
  }}
  {@attach focusFirstField}
>
  <div class="bot-command-header">
    <Avatar
      size="small"
      src={command.senderAvatar}
      id={command.sender}
      name={command.senderName ?? command.sender}
    />
    <span class="bot-command-name">{prefix}{command.command}</span>
    <span class="bot-command-bot">{command.senderName ?? command.sender}</span>
    {#if command.description}
      <span class="bot-command-description">{command.description}</span>
    {/if}
    <IconButton
      size="small"
      variant="ghost"
      class="bot-command-close"
      label={$i18n.t('composer.botCommandCancel')}
      onclick={onCancel}
    >
      <XIcon />
    </IconButton>
  </div>

  {#if command.parameters.length > 0}
    <div class="bot-command-fields">
      {#each command.parameters as parameter (parameter.key)}
        {@const id = fieldId(parameter.key)}
        {@const choices = selectChoices(parameter)}
        {@const error = errorText(parameter.key)}
        <div class={['bot-command-field', { switch: isBooleanParameter(parameter.schema) }]}>
          <label class="bot-command-label" for={id}>
            {labelOf(parameter.key)}
            {#if parameter.optional}
              <span class="bot-command-optional">{$i18n.t('composer.botCommandOptional')}</span>
            {/if}
          </label>
          {#if isBooleanParameter(parameter.schema)}
            <Switch
              {id}
              label={labelOf(parameter.key)}
              checked={values[parameter.key] === true}
              onCheckedChange={(checked: boolean) => {
                values[parameter.key] = checked;
              }}
            />
          {:else if choices}
            <Select
              {id}
              items={choices}
              aria-label={labelOf(parameter.key)}
              value={typeof values[parameter.key] === 'string'
                ? (values[parameter.key] as string)
                : ''}
              onValueChange={(value: string) => {
                values[parameter.key] = value;
                clearError(parameter.key);
              }}
            />
          {:else if parameter.schema.schema_type === 'array'}
            <div class="bot-command-list">
              {#each entries(parameter.key) as entry, index (index)}
                <span class="bot-command-entry">
                  {entry}
                  <IconButton
                    size="small"
                    variant="ghost"
                    label={$i18n.t('composer.botCommandRemove', { value: entry })}
                    onclick={() => {
                      removeEntry(parameter.key, index);
                    }}
                  >
                    <XIcon />
                  </IconButton>
                </span>
              {/each}
              <TextInput
                {id}
                list="{id}-options"
                placeholder={placeholderFor(parameter) ?? $i18n.t('composer.botCommandAdd')}
                autocomplete="off"
                aria-invalid={error !== null}
                aria-describedby={describedBy(parameter)}
                bind:value={
                  () => pending[parameter.key] ?? '',
                  (value: string) => {
                    pending[parameter.key] = value;
                  }
                }
                onkeydown={(event: KeyboardEvent) => {
                  if (event.key !== 'Enter' || (pending[parameter.key] ?? '').trim() === '') return;
                  event.preventDefault();
                  addEntry(parameter.key);
                }}
              />
            </div>
          {:else}
            <TextInput
              {id}
              list="{id}-options"
              placeholder={placeholderFor(parameter)}
              inputmode={acceptsType(parameter.schema, 'integer') ? 'numeric' : undefined}
              autocomplete="off"
              aria-invalid={error !== null}
              aria-describedby={describedBy(parameter)}
              bind:value={
                () =>
                  typeof values[parameter.key] === 'string'
                    ? (values[parameter.key] as string)
                    : '',
                (value: string) => {
                  values[parameter.key] = value;
                  clearError(parameter.key);
                }
              }
            />
          {/if}
          {#if !isBooleanParameter(parameter.schema) && !choices}
            <datalist id="{id}-options">
              {#each optionsFor(parameter) as option (option.value)}
                <option value={option.value}>{option.label}</option>
              {/each}
            </datalist>
          {/if}
          {#if parameter.description}
            <p class="bot-command-hint" id="{id}-hint">{parameter.description}</p>
          {/if}
          {#if error}
            <p class="bot-command-error" id="{id}-error" role="alert">{error}</p>
          {/if}
        </div>
      {/each}
    </div>
  {/if}

  <div class="bot-command-actions">
    <Button type="submit" variant="primary" size="small" loading={sending}>
      {$i18n.t('composer.botCommandSend')}
    </Button>
  </div>
</form>

<style>
  .bot-command {
    border-bottom: var(--border-width) solid var(--surface-container-line);
    display: grid;
    gap: var(--space-200);
    margin-inline: var(--space-150);
    padding-block: var(--space-150);
  }

  .bot-command-header {
    align-items: center;
    display: flex;
    font-size: var(--font-size-small);
    gap: var(--space-150);
    min-width: 0;
  }

  .bot-command-name {
    color: var(--primary-main);
    flex: 0 0 auto;
    font-weight: var(--font-weight-medium);
  }

  .bot-command-bot,
  .bot-command-description {
    color: var(--surface-var-on-container);
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .bot-command-bot {
    flex: 0 1 auto;
  }

  .bot-command-description {
    flex: 1 1 0;
  }

  .bot-command-header :global(.bot-command-close) {
    margin-inline-start: auto;
  }

  .bot-command-fields {
    display: grid;
    gap: var(--space-200);
    grid-template-columns: minmax(0, 1fr);
    max-height: min(40dvh, calc((100dvh - var(--keyboard-overlap)) / 2));
    overflow: hidden auto;
  }

  .bot-command-field {
    display: grid;
    gap: var(--space-100);
  }

  .bot-command-field.switch {
    align-items: center;
    column-gap: var(--space-200);
    grid-template-columns: minmax(0, 1fr) auto;
  }

  .bot-command-field.switch :global(.switch-root) {
    grid-column: 2;
    grid-row: 1 / span 2;
  }

  .bot-command-label {
    font-size: var(--font-size-small);
    font-weight: var(--font-weight-medium);
  }

  .bot-command-optional,
  .bot-command-hint {
    color: var(--surface-var-on-container);
    font-size: var(--font-size-small);
    font-weight: var(--font-weight-normal);
  }

  .bot-command-hint,
  .bot-command-error {
    margin: 0;
  }

  .bot-command-error {
    color: var(--crit-main);
    font-size: var(--font-size-small);
  }

  .bot-command-list {
    align-items: center;
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-100);
  }

  .bot-command-list :global(.text-input) {
    flex: 1 1 12rem;
    width: auto;
  }

  .bot-command-entry {
    align-items: center;
    background: var(--surface-var-container);
    border: var(--border-width) solid var(--surface-var-container-line);
    border-radius: var(--radii-pill);
    color: var(--surface-var-on-container);
    display: inline-flex;
    font-size: var(--font-size-small);
    gap: var(--space-050);
    max-width: 100%;
    overflow-wrap: anywhere;
    padding-inline-start: var(--space-150);
  }

  .bot-command-actions {
    display: flex;
    justify-content: flex-end;
  }
</style>
