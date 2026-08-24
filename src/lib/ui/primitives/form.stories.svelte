<script module lang="ts">
  import { defineMeta } from '@storybook/addon-svelte-csf';

  import FormActions from './FormActions.svelte';
  import FormField from './FormField.svelte';
  import Button from './Button.svelte';
  import TextArea from './TextArea.svelte';
  import TextInput from './TextInput.svelte';

  const { Story } = defineMeta({
    title: 'Primitives/Form',
    tags: ['autodocs'],
  });
</script>

<Story name="Text input" asChild>
  <div class="stack">
    <TextInput placeholder="Placeholder" aria-label="Placeholder" />
    <TextInput value="Filled" aria-label="Filled" />
    <TextInput value="Invalid" aria-label="Invalid" aria-invalid="true" />
    <TextInput value="Disabled" aria-label="Disabled" disabled />
  </div>
</Story>

<Story name="Text area" asChild>
  <div class="stack">
    <TextArea placeholder="Write a message" aria-label="Write a message" />
    <TextArea value="A body that has been typed into." aria-label="Body" />
    <TextArea value="Rejected" aria-label="Rejected" error />
  </div>
</Story>

<Story name="Field" asChild>
  <div class="stack">
    <FormField fieldId="homeserver" label="Homeserver">
      <TextInput id="homeserver" value="matrix.org" />
    </FormField>
    <FormField fieldId="password" label="Password" error="That password is too short.">
      <TextInput id="password" type="password" value="hunter2" aria-invalid="true" />
    </FormField>
    <FormActions>
      <Button variant="primary">Continue</Button>
      <Button variant="ghost">Cancel</Button>
    </FormActions>
  </div>
</Story>

<style>
  .stack {
    display: grid;
    gap: var(--space-400);
    max-width: 22rem;
  }
</style>
