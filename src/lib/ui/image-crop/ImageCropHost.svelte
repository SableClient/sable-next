<script lang="ts">
  import { onMount } from 'svelte';

  import ImageCropDialog from './ImageCropDialog.svelte';
  import { cropRequest, holdCropHost } from './crop-request.svelte.js';

  onMount(holdCropHost);
</script>

{#if cropRequest.current}
  {#key cropRequest.current}
    <ImageCropDialog
      file={cropRequest.current.file}
      preset={cropRequest.current.preset}
      onDone={(file) => cropRequest.settle(file)}
    />
  {/key}
{/if}
