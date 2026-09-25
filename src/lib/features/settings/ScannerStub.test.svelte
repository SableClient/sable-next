<script lang="ts">
  let { onScan }: { onScan: (data: Uint8Array) => void } = $props();
</script>

<button type="button" onclick={() => onScan(new Uint8Array([0x4d, 0x41, 0xff]))}>scan stub</button>
