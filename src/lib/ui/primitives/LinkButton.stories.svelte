<script module lang="ts">
  import { defineMeta } from '@storybook/addon-svelte-csf';
  import type { ComponentProps } from 'svelte';
  import { expect } from 'storybook/test';

  import LinkButton from './LinkButton.svelte';

  const { Story } = defineMeta({
    title: 'Primitives/LinkButton',
    component: LinkButton,
    tags: ['autodocs'],
    argTypes: {
      variant: {
        control: 'select',
        options: ['primary', 'secondary', 'subtle', 'ghost', 'danger'],
      },
      size: { control: 'select', options: ['small', 'medium', 'large'] },
    },
    args: { href: 'https://sable.moe', variant: 'secondary', size: 'medium' },
  });
</script>

{#snippet template(args: ComponentProps<typeof LinkButton>)}
  <LinkButton {...args}>Read the docs</LinkButton>
{/snippet}

<Story
  name="Playground"
  {template}
  play={async ({ args, canvas }) => {
    await expect(canvas.getByRole('link', { name: 'Read the docs' })).toHaveAttribute(
      'href',
      args.href
    );
  }}
/>

<Story name="Variants" asChild>
  <div class="row">
    <LinkButton href="https://sable.moe" variant="primary">Download Sable</LinkButton>
    <LinkButton href="https://sable.moe">Release notes</LinkButton>
    <LinkButton href="https://sable.moe" variant="ghost">Privacy policy</LinkButton>
  </div>
</Story>

<style>
  .row {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-300);
  }
</style>
