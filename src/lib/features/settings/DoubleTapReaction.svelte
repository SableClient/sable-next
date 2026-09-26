<script lang="ts">
  import ReactionSheet from '#lib/features/room/ReactionSheet.svelte';
  import { isCustomReaction } from '#lib/features/room/reaction-emote-label.js';
  import { i18n } from '#lib/i18n.js';
  import { preferences, setPreference } from '#lib/settings/preferences.svelte.js';
  import { settingFocusId } from '#lib/settings/registry.js';
  import MediaImage from '#lib/ui/MediaImage.svelte';
  import Button from '#lib/ui/primitives/Button.svelte';
  import SettingsRow from '#lib/ui/primitives/SettingsRow.svelte';
  import '#lib/ui/primitives/settings-row.css';

  const anchor = settingFocusId('doubleTapReaction');
  let open = $state(false);
  let trigger = $state<HTMLElement | null>(null);
  let disabled = $derived(!preferences.doubleTapReact);
</script>

<ul class="settings-rows">
  <SettingsRow
    id={anchor}
    data-settings-focus={anchor}
    title={$i18n.t('settings.doubleTapReaction')}
    description={$i18n.t('settings.doubleTapReactionHint')}
    {disabled}
    badge={disabled
      ? $i18n.t('settings.needsSetting', { name: $i18n.t('settings.doubleTapReact') })
      : undefined}
    class="gated"
  >
    <span class="trigger" bind:this={trigger}>
      <Button
        {disabled}
        aria-label={$i18n.t('settings.doubleTapReaction')}
        onclick={() => {
          open = true;
        }}
      >
        {#if isCustomReaction(preferences.doubleTapReaction)}
          <MediaImage
            class="double-tap-emote"
            source={preferences.doubleTapReaction}
            alt=""
            width={64}
            height={64}
            original
          />
        {:else}
          {preferences.doubleTapReaction}
        {/if}
      </Button>
    </span>
  </SettingsRow>
</ul>

<ReactionSheet
  bind:open
  roomId=""
  anchor={trigger}
  onPick={(key) => {
    setPreference('doubleTapReaction', key);
  }}
/>

<style>
  .settings-rows {
    border-top: var(--border-width) solid var(--bg-container-line);
  }

  .trigger :global(.double-tap-emote) {
    display: block;
    height: 1.125rem;
    object-fit: contain;
    width: 1.125rem;
  }
</style>
