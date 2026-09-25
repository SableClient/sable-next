<script lang="ts">
  import { i18n } from '#lib/i18n.js';
  import {
    preferences,
    setPreference,
    type ReplyPreviewStyle,
    type ThemeMode,
    type TimelineLayout,
  } from '#lib/settings/preferences.svelte.js';
  import Button from '#lib/ui/primitives/Button.svelte';
  import Label from '#lib/ui/primitives/Label.svelte';
  import Select from '#lib/ui/primitives/Select.svelte';
  import AuthField from '../shared/AuthField.svelte';
  import AuthInfoBox from '../shared/AuthInfoBox.svelte';
  import AuthSecondaryAction from '../shared/AuthSecondaryAction.svelte';
  import AuthStatusSlot from '../shared/AuthStatusSlot.svelte';

  interface Props {
    onComplete: () => void;
    onSkip: () => void;
  }

  let { onComplete, onSkip }: Props = $props();

  const themes: ThemeMode[] = ['system', 'dark', 'light'];
  const layouts: TimelineLayout[] = ['modern', 'compact', 'bubble'];
  const replies: ReplyPreviewStyle[] = ['connected', 'compact', 'expanded'];
  const themeLabels: Record<ThemeMode, string> = {
    system: 'settings.themeSystem',
    dark: 'settings.themeDark',
    light: 'settings.themeLight',
  };
  const layoutLabels: Record<TimelineLayout, string> = {
    modern: 'settings.layoutModern',
    compact: 'settings.layoutCompact',
    bubble: 'settings.layoutBubble',
  };
  const replyLabels: Record<ReplyPreviewStyle, string> = {
    connected: 'settings.replyPreviewStyleConnected',
    compact: 'settings.replyPreviewStyleCompact',
    expanded: 'settings.replyPreviewStyleExpanded',
  };
</script>

<div class="appearance-setup-card auth-card-surface">
  <AuthField labelId="appearance-setup-title" label={$i18n.t('setup.appearanceTitle')}>
    <AuthInfoBox>{$i18n.t('setup.appearanceDescription')}</AuthInfoBox>
  </AuthField>

  <div class="appearance-setting">
    <Label for="setup-theme">{$i18n.t('settings.theme')}</Label>
    <p>{$i18n.t('settings.themeHint')}</p>
    <Select
      id="setup-theme"
      value={preferences.theme}
      items={themes.map((value) => ({ value, label: $i18n.t(themeLabels[value]) }))}
      onValueChange={(value) => {
        setPreference('theme', value as ThemeMode);
      }}
    />
  </div>

  <div class="appearance-setting">
    <Label for="setup-layout">{$i18n.t('settings.layout')}</Label>
    <p>{$i18n.t('settings.layoutHint')}</p>
    <Select
      id="setup-layout"
      value={preferences.layout}
      items={layouts.map((value) => ({ value, label: $i18n.t(layoutLabels[value]) }))}
      onValueChange={(value) => {
        setPreference('layout', value as TimelineLayout);
      }}
    />
  </div>

  <div class="appearance-setting">
    <Label for="setup-reply">{$i18n.t('settings.replyPreviewStyle')}</Label>
    <p>{$i18n.t('settings.replyPreviewStyleHint')}</p>
    <Select
      id="setup-reply"
      value={preferences.replyPreviewStyle}
      items={replies.map((value) => ({ value, label: $i18n.t(replyLabels[value]) }))}
      onValueChange={(value) => {
        setPreference('replyPreviewStyle', value as ReplyPreviewStyle);
      }}
    />
  </div>

  <AuthStatusSlot />

  <Button variant="primary" block onclick={onComplete}>{$i18n.t('auth.continue')}</Button>
</div>

<AuthSecondaryAction label={$i18n.t('auth.skipForNow')} onclick={onSkip} />

<style>
  .appearance-setup-card {
    min-width: 0;
  }

  .appearance-setting {
    display: grid;
    gap: var(--space-100);
  }

  .appearance-setup-card .appearance-setting p {
    color: var(--surface-var-on-container);
    font-size: var(--font-size-small);
    margin: 0;
  }
</style>
