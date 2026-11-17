<script module lang="ts">
  import { defineMeta } from '@storybook/addon-svelte-csf';
  import { expect } from 'storybook/test';

  import Slider from './Slider.svelte';

  const { Story } = defineMeta({
    title: 'Primitives/Slider',
    component: Slider,
    tags: ['autodocs'],
    argTypes: { max: { control: 'number' }, disabled: { control: 'boolean' } },
    args: { label: 'Choose quantity', max: 12, value: 8, disabled: false },
  });
</script>

<Story
  name="Playground"
  play={async ({ canvas, userEvent }) => {
    const thumb = canvas.getByRole('slider', { name: 'Choose quantity' });
    await expect(thumb).toHaveAttribute('aria-valuenow', '8');
    thumb.focus();
    await userEvent.keyboard('{ArrowRight}');
    await expect(thumb).toHaveAttribute('aria-valuenow', '9');
  }}
/>
