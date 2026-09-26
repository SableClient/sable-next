<script lang="ts">
  import PronounPill from '#lib/ui/primitives/PronounPill.svelte';
  import type { ClassValue } from 'svelte/elements';
  import type { PronounView } from '#src/generated/protocol';
  import { i18n } from '#lib/i18n.js';
  import type { SenderDisplayColors } from './members.js';

  import './sender-identity.css';

  interface Props {
    displayName: string;
    accountName?: string;
    colors: SenderDisplayColors;
    font?: string | null;
    pronouns?: readonly PronounView[];
    nameClass?: ClassValue;
    mentionLabel?: string;
    profileLabel?: string;
    onMention?: () => void;
    onProfile?: (anchor: HTMLElement) => void;
    onViaProfile?: (anchor: HTMLElement) => void;
    compact?: boolean;
  }

  let {
    displayName,
    accountName,
    colors,
    font = null,
    pronouns = [],
    nameClass = 'sender',
    mentionLabel,
    profileLabel,
    onMention,
    onProfile,
    onViaProfile,
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
      style:font-family={font ?? undefined}
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
      style:font-family={font ?? undefined}
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
      style:font-family={font ?? undefined}
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

    {#if pronouns.length > 0}
      <PronounPill
        class="sender-identity-pronoun"
        style=" color={colors.tinted
          ? undefined
          : colors.nameColor} --name-color-on-light={colors.nameColorLight ??
          undefined} --name-color-on-dark={colors.nameColorDark ?? undefined} "
        {pronouns}
      />
    {/if}

    <!--<span
        class="sender-identity-pronouns"
        class:tinted={colors.tinted}
        style:color={colors.tinted ? undefined : colors.nameColor}
        style:--name-color-on-light={colors.nameColorLight ?? undefined}
        style:--name-color-on-dark={colors.nameColorDark ?? undefined}
      >
        {#each pronouns.visible as pronoun, index (index)}
          <span lang={pronoun.language ?? undefined} class="sender-identity-pronoun"
            >{pronoun.summary}</span
          >
        {/each}{#if pronouns.overflow.length > 0}
          <span class="sender-identity-pronoun" title={formatPronouns(pronouns.overflow)}>
            {$i18n.t('timeline.morePronouns', {
              count: pronouns.overflow.length,
            })}
          </span>
        {/if}</span
      >-->
    {#if accountName}
      <span class="sender-identity-via"
        >|
        {#if onViaProfile}
          <button
            class="name-button"
            type="button"
            aria-label={$i18n.t('timeline.viaAccount', { user: accountName })}
            onclick={(event) => {
              onViaProfile(event.currentTarget);
            }}>{accountName}</button
          >
        {:else}
          {accountName}
        {/if}
      </span>
    {/if}
  </span>
{/if}
