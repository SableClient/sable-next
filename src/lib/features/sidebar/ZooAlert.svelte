<script lang="ts" module>
  import { preferences } from '#lib/settings/preferences.svelte.ts';
  import AlertBanner from '#lib/ui/primitives/AlertBanner.svelte';
  import Progress from '#lib/ui/primitives/Progress.svelte';
  import type { AlertProgress, Priority, PriorityLevel, PriorityProvider } from './alerts';

  export const zooAlertState = $state({
    visible: false,
    level: 'task' as PriorityLevel,
    progress: undefined as AlertProgress | undefined,
  });

  export function priorityProvider() {
    return {
      get priority(): Priority {
        if (preferences.showAlertZoo && zooAlertState.visible) {
          return {
            level: zooAlertState.level,
            icon: CubeIcon,
          };
        } else {
          return null;
        }
      },

      get progress(): AlertProgress | undefined {
        return zooAlertState.progress;
      },
    };
  }
</script>

<script lang="ts">
  import Button from '#lib/ui/primitives/Button.svelte';
  import CubeIcon from 'phosphor-svelte/lib/CubeIcon';

  let { progress }: PriorityProvider = $props();
</script>

<AlertBanner icon={CubeIcon}>
  {#snippet title()}
    Etaoin shrdlu
  {/snippet}
  {#snippet body()}
    {#if progress}
      <Progress value={progress.value ? progress.value * 100 : null} label="" />
    {/if}
    <div>
      Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut
      labore et dolore magna aliqua.
    </div>
  {/snippet}
  {#snippet actions()}
    <Button variant="ghost" size="small">Despair</Button>
    <Button variant="primary" size="small">Rejoice</Button>
  {/snippet}
</AlertBanner>
