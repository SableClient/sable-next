<script lang="ts">
  import BottomSheet from './BottomSheet.svelte';
  import EmoteBoard from './EmoteBoard.svelte';
</script>

<BottomSheet open label="Emotes" closeLabel="Close" expandable>
  <EmoteBoard roomId="!room:example.test" variant="sheet" tab="sticker" unicode onPick={() => {}} />
</BottomSheet>
