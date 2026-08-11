<script lang="ts">
  import { goto } from '$app/navigation';
  import { resolve } from '$app/paths';
  import { useCoreClient } from '$lib/core/context';
  import { onMount } from 'svelte';

  const core = useCoreClient();

  onMount(() => {
    if (core.status === 'ready') void goto(resolve('/home'));
    else void goto(resolve('/login'));
  });
</script>
