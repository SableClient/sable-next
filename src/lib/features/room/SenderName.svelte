<script lang="ts">
  import type { ClassValue } from 'svelte/elements';
  import type { PronounView } from '#src/generated/PronounView';

  import { i18n } from '#lib/i18n.js';
  import { formatPronouns } from '#lib/personas/pronouns.js';
  import PronounPill from '#lib/ui/primitives/PronounPill.svelte';

  import type { SenderDisplayColors } from './members.js';

  import './sender-identity.css';

  interface Props {
    displayName: string;
    colors: SenderDisplayColors;
    pronouns?: { visible: readonly PronounView[]; overflow: readonly PronounView[] };
    nameClass?: ClassValue;
    mentionLabel?: string;
    profileLabel?: string;
    onMention?: () => void;
    onProfile?: (anchor: HTMLElement) => void;
    compact?: boolean;
  }

  let {
    displayName,
    colors,
    pronouns = { visible: [], overflow: [] },
    nameClass = 'sender',
    mentionLabel,
    profileLabel,
    onMention,
    onProfile,
    compact = false,
  }: Props = $props();
</script>

{#snippet name()}
  {#if onMention}
    <button
      class={[nameClass, 'name-button', 'sender-identity-name']}
      class:tinted={colors.tinted}
      style:color={colors.tinted ? undefined : colors.nameColor}
      style:--name-color-on-light={colors.nameColorLight ?? undefined}
      style:--name-color-on-dark={colors.nameColorDark ?? undefined}
      type="button"
      aria-label={mentionLabel ?? $i18n.t('timeline.mentionSender', { name: displayName })}
      onclick={onMention}>{displayName}</button
    >
  {:else if onProfile}
    <button
      class={[nameClass, 'name-button', 'sender-identity-name']}
      class:tinted={colors.tinted}
      style:color={colors.tinted ? undefined : colors.nameColor}
      style:--name-color-on-light={colors.nameColorLight ?? undefined}
      style:--name-color-on-dark={colors.nameColorDark ?? undefined}
      type="button"
      aria-label={profileLabel ?? $i18n.t('timeline.senderProfile', { name: displayName })}
      onclick={(event) => {
        onProfile(event.currentTarget);
      }}>{displayName}</button
    >
  {:else}
    <span
      class={[nameClass, 'sender-identity-name']}
      class:tinted={colors.tinted}
      style:color={colors.tinted ? undefined : colors.nameColor}
      style:--name-color-on-light={colors.nameColorLight ?? undefined}
      style:--name-color-on-dark={colors.nameColorDark ?? undefined}
    >
      {displayName}
    </span>
  {/if}
{/snippet}

{#if compact}
  {@render name()}
{:else}
  <span
    class="sender-identity"
    style:--name-color-on-light={colors.nameColorLight ?? undefined}
    style:--name-color-on-dark={colors.nameColorDark ?? undefined}
  >
    {@render name()}
    {#each pronouns.visible as pronoun, index (index)}
      <PronounPill
        lang={pronoun.language ?? undefined}
        class={['timeline-pronoun', 'sender-identity-pronoun', { tinted: colors.tinted }]}
        style={colors.tinted
          ? undefined
          : colors.nameColor
            ? `color: ${colors.nameColor};`
            : undefined}>{pronoun.summary}</PronounPill
      >
    {/each}
    {#if pronouns.overflow.length > 0}
      <PronounPill
        class={['timeline-pronoun', 'sender-identity-pronoun', { tinted: colors.tinted }]}
        style={colors.tinted
          ? undefined
          : colors.nameColor
            ? `color: ${colors.nameColor};`
            : undefined}
        title={formatPronouns(pronouns.overflow)}
        >{$i18n.t('timeline.morePronouns', {
          count: pronouns.overflow.length,
        })}</PronounPill
      >
    {/if}
  </span>
{/if}
