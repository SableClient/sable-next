<script module lang="ts">
  import { defineMeta } from '@storybook/addon-svelte-csf';

  import Button from './Button.svelte';
  import Spinner from './Spinner.svelte';

  const { Story } = defineMeta({
    title: 'Primitives/Spinner',
    component: Spinner,
    tags: ['autodocs'],
    argTypes: { small: { control: 'boolean' } },
    args: { small: false },
  });
</script>

<Story name="Playground" />

<Story name="Sizes" asChild>
  <div class="row">
    <Spinner />
    <Spinner small />
  </div>
</Story>

<Story name="On a button" asChild>
  <div class="row">
    <Button variant="primary" loading>Sending</Button>
    <Button variant="secondary" loading>Sending</Button>
    <Button variant="ghost" loading>Sending</Button>
    <Button variant="danger" loading>Deleting</Button>
  </div>
</Story>

<style>
  .row {
    align-items: center;
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-300);
  }
</style>
