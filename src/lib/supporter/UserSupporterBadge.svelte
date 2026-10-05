<script lang="ts">
  import type { ClassValue } from 'svelte/elements';

  import { badgeFor, type SupporterBadgeData } from './award.js';
  import { supporterConfig } from './config.js';
  import SupporterBadge from './SupporterBadge.svelte';
  import type { SupporterAppearance } from './variants.js';

  type Props = Partial<SupporterAppearance> & {
    userId: string;
    awards: string | null;
    name?: string;
    class?: ClassValue;
  };

  let { userId, awards, name, ...appearance }: Props = $props();
  let badge = $state.raw<SupporterBadgeData | null>(null);

  $effect(() => {
    const raw = awards;
    const id = userId;
    let current = true;
    void supporterConfig()
      .then((config) => (config ? badgeFor(raw, id, config.keys) : null))
      .then(
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
  <SupporterBadge
    label={badge.label}
    name={name?.trim() || userId.split(':', 1)[0]}
    {...appearance}
  />
{/if}
