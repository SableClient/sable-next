<script lang="ts">
  import ChatCircleIcon from 'phosphor-svelte/lib/ChatCircleIcon';
  import PaperPlaneRightIcon from 'phosphor-svelte/lib/PaperPlaneRightIcon';

  import { i18n } from '#lib/i18n.js';
  import IconButton from '#lib/ui/primitives/IconButton.svelte';
  import TextInput from '#lib/ui/primitives/TextInput.svelte';
  import Tooltip from '#lib/ui/primitives/Tooltip.svelte';

  interface Props {
    draft: string;
    name: string;
    sending: boolean;
    sendFailed: 'send' | 'open' | null;
    onSubmit: (event: SubmitEvent) => void;
  }

  let { draft = $bindable(), name, sending, sendFailed, onSubmit }: Props = $props();

  let messageLabel = $derived(i18n.t('timeline.messageUser', { name }));
  let hasDraft = $derived(draft.trim() !== '');
</script>

<form class="profile-composer" onsubmit={onSubmit}>
  <TextInput
    bind:value={draft}
    class="profile-composer-input"
    placeholder={messageLabel}
    aria-label={messageLabel}
    disabled={sending}
  />
  <Tooltip label={i18n.t('timeline.openChat')} disabled={hasDraft}>
    {#snippet trigger({ props })}
      <IconButton
        {...props}
        label={hasDraft ? i18n.t('timeline.sendMessage') : i18n.t('timeline.openChat')}
        variant={hasDraft ? 'primary' : 'secondary'}
        size="small"
        type="submit"
        disabled={sending}
      >
        {#if hasDraft}
          <PaperPlaneRightIcon class="mirror-rtl" />
        {:else}
          <ChatCircleIcon />
        {/if}
      </IconButton>
    {/snippet}
  </Tooltip>
</form>
{#if sendFailed}
  <p class="profile-composer-error" role="status">
    {sendFailed === 'send' ? i18n.t('timeline.sendFailed') : i18n.t('timeline.openChatFailed')}
  </p>
{/if}

<style>
  .profile-composer {
    align-items: center;
    display: flex;
    gap: var(--space-200);
  }

  .profile-composer :global(.profile-composer-input) {
    flex: 1 1 auto;
    font-size: max(var(--font-size-small), var(--font-size-input-min));
    height: var(--control-height-small);
    min-height: 0;
    min-width: 0;
    padding-block: 0;
  }

  :global(.profile-card-sheet) .profile-composer :global(.profile-composer-input) {
    height: var(--control-height-medium);
  }

  :global(.profile-card-sheet) .profile-composer :global(.icon-button) {
    min-height: var(--control-height-medium);
    width: var(--control-height-medium);
  }

  .profile-composer-error {
    color: var(--crit-main);
    font-size: var(--font-size-small);
    margin: var(--space-200) 0 0;
  }
</style>
