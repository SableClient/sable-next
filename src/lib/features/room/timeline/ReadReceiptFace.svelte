<script lang="ts">
  import { useCoreClient } from '#lib/core/context.js';
  import { i18n } from '#lib/i18n.js';
  import { UserProfile } from '#lib/profile/user-profile.svelte.js';
  import Avatar from '#lib/ui/primitives/Avatar.svelte';
  import Tooltip from '#lib/ui/primitives/Tooltip.svelte';

  import { useSenderColors } from '../members/members.js';
  import '../members/sender-identity.css';
  import ReadReceiptTime from './ReadReceiptTime.svelte';

  interface Props {
    userId: string;
    name: string;
    avatar: string | null;
    timestamp?: number;
    onProfile?: (userId: string, anchor: HTMLElement) => void;
    onHover: () => void;
  }

  let { userId, name, avatar, timestamp, onProfile, onHover }: Props = $props();

  const core = useCoreClient();
  const senderColors = useSenderColors();
  const profile = new UserProfile(core, () => userId);
  let colors = $derived(senderColors(userId, profile.current));
</script>

{#snippet faceTrigger({ props }: { props: Record<string, unknown> })}
  <button
    {...props}
    class={['t-avatar', 'face', { interactive: onProfile }]}
    type="button"
    aria-label={onProfile ? i18n.t('timeline.senderProfile', { name }) : name}
    onmouseenter={onHover}
    onclick={(event) => onProfile?.(userId, event.currentTarget)}
  >
    <Avatar class="receipt-face" src={avatar} {name} id={userId} />
  </button>
{/snippet}

{#snippet nameTooltip()}
  <span
    class={['sender-identity-name', 'receipt-name', { tinted: colors.tinted }]}
    style:color={colors.tinted ? undefined : colors.nameColor}
    style:--name-color-on-light={colors.nameColorLight ?? undefined}
    style:--name-color-on-dark={colors.nameColorDark ?? undefined}
  >
    {name}
  </span>
  <ReadReceiptTime {timestamp} />
{/snippet}

<Tooltip label={name} trigger={faceTrigger} content={nameTooltip} />

<style>
  .receipt-name {
    display: block;
    max-width: none;
    overflow-wrap: anywhere;
    white-space: normal;
  }

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
