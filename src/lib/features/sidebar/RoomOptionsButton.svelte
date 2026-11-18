<script lang="ts">
  import DotsThreeVerticalIcon from 'phosphor-svelte/lib/DotsThreeVerticalIcon';

  import { i18n } from '#lib/i18n.js';

  interface Props {
    open: boolean;
    onToggle: (trigger: HTMLElement) => void;
  }

  let { open, onToggle }: Props = $props();
</script>

<button
  type="button"
  class="room-options-trigger selection-open"
  tabindex="-1"
  aria-hidden="true"
  aria-label={i18n.t('room.menuLabel')}
  aria-haspopup="menu"
  aria-expanded={open}
  data-state={open ? 'open' : 'closed'}
  onclick={(event) => {
    onToggle(event.currentTarget);
  }}
>
  <DotsThreeVerticalIcon />
</button>
