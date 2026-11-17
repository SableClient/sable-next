<script module lang="ts">
  import { defineMeta } from '@storybook/addon-svelte-csf';
  import { expect } from 'storybook/test';

  import Switch from './Switch.svelte';

  const { Story } = defineMeta({
    title: 'Primitives/Switch',
    component: Switch,
    tags: ['autodocs'],
    argTypes: { checked: { control: 'boolean' }, disabled: { control: 'boolean' } },
    args: { label: 'Send read receipts', checked: false, disabled: false },
  });
</script>

<Story
  name="Playground"
  play={async ({ canvas, userEvent }) => {
    const toggle = canvas.getByRole('switch', { name: 'Send read receipts' });
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await userEvent.click(toggle);
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    await userEvent.click(toggle);
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
  }}
/>

<Story name="States" asChild>
  <div class="row">
    <Switch label="Off" checked={false} />
    <Switch label="On" checked />
    <Switch label="Off and disabled" checked={false} disabled />
    <Switch label="On and disabled" checked disabled />
  </div>
</Story>

<style>
  .row {
    align-items: center;
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-400);
  }
</style>
