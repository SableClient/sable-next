<script lang="ts">
  import { i18n } from '#lib/i18n.js';

  import { badgeFor, type SupporterBadgeData } from './award.js';
  import SupporterBadge from './SupporterBadge.svelte';

  type Props = {
    userId: string;
    awards: string | null;
  };

  let { userId, awards }: Props = $props();
  let badge = $state.raw<SupporterBadgeData | null>(null);

  $effect(() => {
    const raw = awards;
    const id = userId;
    let current = true;
    void badgeFor(raw, id).then(
      (next) => {
        if (current) badge = next;
      },
      () => {
        if (current) badge = null;
      }
    );
    return () => {
      current = false;
    };
  });
</script>

{#if badge}
  <SupporterBadge label={badge.label} title={$i18n.t('timeline.profileSupporter')} />
{/if}
