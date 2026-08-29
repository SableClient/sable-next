<script lang="ts">
  import TrashIcon from 'phosphor-svelte/lib/TrashIcon';

  import { i18n } from '#lib/i18n.js';
  import Button from '#lib/ui/primitives/Button.svelte';
  import DialogFrame from '#lib/ui/primitives/DialogFrame.svelte';
  import FormField from '#lib/ui/primitives/FormField.svelte';
  import Switch from '#lib/ui/primitives/Switch.svelte';
  import TextInput from '#lib/ui/primitives/TextInput.svelte';

  interface Props {
    open?: boolean;
    onCreate: (question: string, answers: string[], undisclosed: boolean) => void;
  }

  /** MSC3381's ceiling; the core rejects anything past it. */
  const MAX_ANSWERS = 20;

  let { open = $bindable(false), onCreate }: Props = $props();
  let question = $state('');
  let answers = $state(['', '']);
  let undisclosed = $state(false);
  let filled = $derived(
    answers.map((answer) => answer.trim()).filter((answer) => answer.length > 0)
  );
  let valid = $derived(question.trim().length > 0 && filled.length > 0);

  function reset(): void {
    question = '';
    answers = ['', ''];
    undisclosed = false;
  }

  function create(): void {
    if (!valid) return;
    const asked = question.trim();
    const options = filled;
    open = false;
    reset();
    onCreate(asked, options, undisclosed);
  }

  function cancel(): void {
    open = false;
    reset();
  }
</script>

<DialogFrame bind:open variant="verification" label={$i18n.t('composer.pollTitle')}>
  <div class="poll-composer">
    <h2>{$i18n.t('composer.pollTitle')}</h2>

    <FormField fieldId="poll-question" label={$i18n.t('composer.pollQuestion')}>
      <TextInput id="poll-question" bind:value={question} autocomplete="off" />
    </FormField>

    <fieldset class="answers">
      <legend>{$i18n.t('composer.pollAnswers')}</legend>
      {#each answers.map((_, at) => at) as index (index)}
        <div class="answer">
          <TextInput
            id={`poll-answer-${String(index)}`}
            bind:value={answers[index]}
            autocomplete="off"
            aria-label={$i18n.t('composer.pollAnswerNumber', { number: index + 1 })}
          />
          {#if answers.length > 1}
            <Button
              variant="ghost"
              aria-label={$i18n.t('composer.pollRemoveAnswer', { number: index + 1 })}
              onclick={() => {
                answers = answers.filter((_, at) => at !== index);
              }}
            >
              <TrashIcon />
            </Button>
          {/if}
        </div>
      {/each}
      {#if answers.length < MAX_ANSWERS}
        <Button
          variant="ghost"
          class="add-answer"
          onclick={() => {
            answers = [...answers, ''];
          }}
        >
          {$i18n.t('composer.pollAddAnswer')}
        </Button>
      {/if}
    </fieldset>

    <div class="undisclosed">
      <Switch bind:checked={undisclosed} label={$i18n.t('composer.pollUndisclosed')} />
      <span>{$i18n.t('composer.pollUndisclosed')}</span>
    </div>

    <div class="actions">
      <Button variant="ghost" onclick={cancel}>{$i18n.t('composer.pollCancel')}</Button>
      <Button disabled={!valid} onclick={create}>{$i18n.t('composer.pollCreate')}</Button>
    </div>
  </div>
</DialogFrame>

<style>
  .poll-composer {
    display: grid;
    gap: var(--space-3);
  }

  h2 {
    font-size: var(--font-size-large);
    margin: 0;
  }

  .answers {
    border: 0;
    display: grid;
    gap: var(--space-2);
    margin: 0;
    padding: 0;
  }

  legend {
    color: var(--sable-surface-var-on-container);
    font-size: var(--font-size-small);
    padding: 0 0 var(--space-1);
  }

  .answer {
    align-items: center;
    display: flex;
    gap: var(--space-1);
  }

  .answer :global(input) {
    flex: 1;
  }

  .undisclosed {
    align-items: center;
    display: flex;
    gap: var(--space-2);
  }

  .actions {
    display: flex;
    gap: var(--space-2);
    justify-content: flex-end;
  }
</style>
