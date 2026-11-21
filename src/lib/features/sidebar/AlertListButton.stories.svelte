<script module lang="ts">
  import { defineMeta } from '@storybook/addon-svelte-csf';
  import AlertListButton from './AlertListButton.svelte';
  import AlertProvider from './AlertProvider.svelte';
  import { provideAlertProviders, type PriorityProvider } from './alerts';
  import CubeIcon from 'phosphor-svelte/lib/CubeIcon';
  import AlertDrawer from './AlertDrawer.svelte';

  const mockProvider = {
    priority: {
      level: 'critical',
      icon: CubeIcon,
    },
    progress: undefined,
  } satisfies PriorityProvider<unknown>;
  const { Story } = defineMeta({
    title: 'foo',
    decorators: [() => AlertProvider],
  });
</script>

<Story name="Default">
  <AlertListButton mode="desktop" />
  <AlertDrawer />
</Story>
