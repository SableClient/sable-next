<script module lang="ts">
  import { defineMeta } from '@storybook/addon-svelte-csf';

  import Slider from './Slider.svelte';

  const { Story } = defineMeta({
    title: 'Primitives/Slider',
    component: Slider,
    tags: ['autodocs'],
    argTypes: { max: { control: 'number' }, disabled: { control: 'boolean' } },
    args: { label: 'Choose quanity', max: 12, value: 8, disabled: false },
  });
</script>

<Story name="Playground" />
