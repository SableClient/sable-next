<script lang="ts">
  import { goto } from '$app/navigation';
  import { resolve } from '$app/paths';
  import { useCoreClient } from '$lib/core/context';

  const core = useCoreClient();

  /* The root layout starts the core after this page has mounted, so the landing
     decision has to wait for the status to settle rather than sample it once. */
  $effect(() => {
    if (core.status === 'idle' || core.status === 'starting') return;
    void goto(resolve(core.status === 'ready' ? '/home' : '/login'), { replaceState: true });
  });
</script>
