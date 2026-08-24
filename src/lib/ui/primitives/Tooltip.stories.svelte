<script module lang="ts">
  import { defineMeta } from '@storybook/addon-svelte-csf';
  import type { ComponentProps } from 'svelte';
  import InfoIcon from 'phosphor-svelte/lib/InfoIcon';

  import Tooltip from './Tooltip.svelte';

  const { Story } = defineMeta({
    title: 'Primitives/Tooltip',
    component: Tooltip,
    tags: ['autodocs'],
    argTypes: {
      variant: { control: 'select', options: ['icon', 'inline'] },
      side: { control: 'select', options: ['top', 'right', 'bottom', 'left'] },
    },
    args: { label: 'Only you can see this', variant: 'icon', side: 'top' },
  });
</script>

{#snippet template(args: ComponentProps<typeof Tooltip>)}
  <div class="pad">
    <Tooltip {...args} label="Only you can see this"><InfoIcon /></Tooltip>
  </div>
{/snippet}

<Story name="Playground" {template} />

<Story name="Inline" asChild>
  <div class="pad">
    <Tooltip variant="inline" label="A homeserver stores your account and messages.">
      homeserver
    </Tooltip>
  </div>
</Story>

<style>
  .pad {
    padding: var(--space-700);
  }
</style>
