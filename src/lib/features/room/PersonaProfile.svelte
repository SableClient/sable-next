<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { PerMessageProfileView } from '#src/generated/protocol';

  import { i18n } from '#lib/i18n.js';
  import ResponsivePopover from '#lib/ui/primitives/ResponsivePopover.svelte';

  import PersonaCard from './PersonaCard.svelte';
  import './avatar-button.css';

  interface Props {
    profile: PerMessageProfileView;
    accountId: string;
    accountName: string;
    label: string;
    onOpenAccount: (anchor: HTMLElement | null) => void;
    onAvatarClick?: (source: string, displayName: string) => void;
    onOpenChange?: (open: boolean) => void;
    children: Snippet;
  }

  let {
    profile,
    accountId,
    accountName,
    label,
    onOpenAccount,
    onAvatarClick,
    onOpenChange,
    children: avatar,
  }: Props = $props();
  let open = $state(false);
  let anchor = $state<HTMLElement | null>(null);

  function openAccount(): void {
    open = false;
    onOpenChange?.(false);
    onOpenAccount(anchor);
  }

  function openAvatar(source: string, displayName: string): void {
    open = false;
    onOpenChange?.(false);
    onAvatarClick?.(source, displayName);
  }
</script>

<ResponsivePopover
  bind:open
  {anchor}
  collisionPadding={12}
  closeOnAnchorHidden
  label={$i18n.t('timeline.personaSheet')}
  closeLabel={$i18n.t('timeline.closeProfile')}
  handleColor="var(--bg-container)"
  handleOpacity={1}
  contentInset={false}
  {onOpenChange}
>
  {#snippet trigger({ props })}
    <button {...props} bind:this={anchor} class="avatar-button selection-open" aria-label={label}>
      {@render avatar()}
    </button>
  {/snippet}
  {#snippet children(sheet)}
    <PersonaCard
      {profile}
      {accountId}
      {accountName}
      onOpenAccount={openAccount}
      onAvatarClick={openAvatar}
      variant={sheet ? 'sheet' : 'popover'}
    />
  {/snippet}
</ResponsivePopover>
