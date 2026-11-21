<script module lang="ts">
  import { defineMeta } from '@storybook/addon-svelte-csf';

  import AlertBanner from './AlertBanner.svelte';
  import type {
    AlertProgress,
    Priority,
    PriorityLevel,
    PriorityProvider,
  } from '#lib/features/sidebar/alerts.js';
  import CubeIcon from 'phosphor-svelte/lib/CubeIcon';
  import Progress from '#lib/ui/primitives/Progress.svelte';
  import Button from '#lib/ui/primitives/Button.svelte';

  const { Story } = defineMeta({
    title: 'AlertBanner',
    argTypes: { progressPercent: { control: { type: 'range', min: 0, max: 1, step: 0.01 } } },
  });
</script>

<Story name="Default" args={{ progressEnabled: false, progressPercent: 0 }}>
  {#snippet template(args)}
    {@const progress = args.progressEnabled
      ? ({
          value: args.progressPercent,
        } satisfies AlertProgress)
      : null}
    <AlertBanner icon={CubeIcon}>
      {#snippet title()}
        Etaoin shrdlu
      {/snippet}
      {#snippet body()}
        {#if progress}
          <Progress value={progress.value ? progress.value * 100 : null} label="" />
        {/if}
        <div>
          Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt
          ut labore et dolore magna aliqua.
        </div>
      {/snippet}
      {#snippet actions()}
        <Button variant="ghost" size="small">Despair</Button>
        <Button variant="primary" size="small">Rejoice</Button>
      {/snippet}
    </AlertBanner>
  {/snippet}
</Story>
