<script lang="ts">
  import { holdOverlayBack } from './overlay-back.svelte.js';

  interface Props {
    open: boolean;
    nested?: boolean;
    onClose: () => void;
    onCloseNested?: () => void;
  }

  let { open, nested = false, onClose, onCloseNested }: Props = $props();

  holdOverlayBack(
    () => open,
    () => onClose()
  );
  holdOverlayBack(
    () => nested,
    () => onCloseNested?.()
  );
</script>
