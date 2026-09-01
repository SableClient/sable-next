<script lang="ts">
  import type { ProfileView } from '#src/generated/ProfileView';

  import { useCoreClient } from '#lib/core/context.js';
  import { i18n } from '#lib/i18n.js';

  import { senderDisplayColors } from './members.js';
  import SenderName from './SenderName.svelte';

  interface Props {
    userId: string;
    name: string;
    onProfile?: (userId: string, anchor: HTMLElement) => void;
  }

  let { userId, name, onProfile }: Props = $props();
  const core = useCoreClient();
  let profile = $state<ProfileView | null>(null);
  let colors = $derived(senderDisplayColors(userId, profile));

  $effect(() => {
    profile = null;
    let current = true;
    void core.userProfile(userId).then(
      (next) => {
        if (current) profile = next;
      },
      () => undefined
    );
    return () => {
      current = false;
    };
  });

  function openProfile(anchor: HTMLElement): void {
    onProfile?.(userId, anchor);
  }
</script>

<SenderName
  displayName={name}
  {colors}
  nameClass="state-subject"
  compact
  profileLabel={$i18n.t('timeline.senderProfile', { name })}
  onProfile={onProfile ? openProfile : undefined}
/>
