<script lang="ts">
  import type { ProfileView } from '#src/generated/protocol';

  import { useCoreClient } from '#lib/core/context.js';
  import { i18n } from '#lib/i18n.js';
  import { useRoomCosmetics } from '#lib/rooms/room-cosmetics.svelte.js';
  import Avatar from '#lib/ui/primitives/Avatar.svelte';
  import Tooltip from '#lib/ui/primitives/Tooltip.svelte';

  import { senderDisplayColors } from '../members/members.js';
  import '../members/sender-identity.css';

  interface Props {
    userId: string;
    name: string;
    avatar: string | null;
    onProfile?: (userId: string, anchor: HTMLElement) => void;
    onHover: () => void;
  }

  let { userId, name, avatar, onProfile, onHover }: Props = $props();

  const core = useCoreClient();
  const roomCosmetics = useRoomCosmetics();
  let profile = $state<ProfileView | null>(null);
  let colors = $derived(
    senderDisplayColors(userId, profile, null, false, roomCosmetics?.for(userId) ?? null)
  );

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
</script>

{#snippet faceTrigger({ props }: { props: Record<string, unknown> })}
  <button
    {...props}
    class={['t-avatar', 'face', { interactive: onProfile }]}
    type="button"
    aria-label={onProfile ? $i18n.t('timeline.senderProfile', { name }) : name}
    onmouseenter={onHover}
    onclick={(event) => onProfile?.(userId, event.currentTarget)}
  >
    <Avatar class="receipt-face" src={avatar} {name} id={userId} />
  </button>
{/snippet}

{#snippet nameTooltip()}
  <span
    class={['sender-identity-name', { tinted: colors.tinted }]}
    style:color={colors.tinted ? undefined : colors.nameColor}
    style:--name-color-on-light={colors.nameColorLight ?? undefined}
    style:--name-color-on-dark={colors.nameColorDark ?? undefined}
  >
    {name}
  </span>
{/snippet}

<Tooltip label={name} trigger={faceTrigger} content={nameTooltip} />

<style>
  .face {
    align-items: center;
    background: transparent;
    border: 0;
    border-radius: 50%;
    cursor: default;
    display: inline-flex;
    margin: 0;
    padding: 0;
    position: relative;
  }

  .face.interactive {
    cursor: pointer;
  }

  .face::after {
    border-radius: 50%;
    content: '';
    inset: -0.35rem 0;
    position: absolute;
  }

  .face:focus-visible {
    outline: var(--focus-ring-width) solid var(--focus-ring);
    outline-offset: 0.15rem;
  }
</style>
