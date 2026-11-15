<script lang="ts">
  import BackIcon from 'phosphor-svelte/lib/CaretLeftIcon';

  import { i18n } from '#lib/i18n.js';
  import PanelHeaderButton from '#lib/ui/primitives/PanelHeaderButton.svelte';
  import UnreadBadge from '#lib/ui/primitives/UnreadBadge.svelte';

  interface Props {
    onBack: () => void;
    unread?: number;
  }

  let { onBack, unread = 0 }: Props = $props();

  let label = $derived(
    unread > 0 ? i18n.t('timeline.backUnread', { count: unread }) : i18n.t('timeline.back')
  );
</script>

<PanelHeaderButton class="back-button" {label} onclick={onBack}>
  <BackIcon class="mirror-rtl" />
  <UnreadBadge class="back-unread" counts={{ unread: 0, highlight: unread }} aria-hidden="true" />
</PanelHeaderButton>

<style>
  :global(.back-button .back-unread) {
    inset-inline-end: 0;
    position: absolute;
    top: 0;
  }
</style>
