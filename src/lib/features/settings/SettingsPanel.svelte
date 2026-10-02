<script lang="ts">
  import { afterNavigate, goto } from '$app/navigation';
  import { resolve } from '$app/paths';
  import type { Snippet } from 'svelte';
  import { BREAKPOINTS } from '#lib/ui/breakpoints.js';
  import DialogFrame from '#lib/ui/primitives/DialogFrame.svelte';
  import SettingsSectionContent from './SettingsSectionContent.svelte';
  import SettingsNavigator from './SettingsNavigator.svelte';

  interface Props {
    section: string | null;
    shallow?: boolean;
    focus?: string | null;
    children?: Snippet;
  }

  let { section, shallow = false, focus = null, children }: Props = $props();
  let enteredFromList = false;
  let returnToOpeningPage = false;
  let settingsDepth = 0;

  afterNavigate((navigation) => {
    if (navigation.shallow || matchMedia(BREAKPOINTS.appLayout).matches) return;
    const from = navigation.from?.url.pathname;
    enteredFromList = navigation.type !== 'popstate' && from === resolve('settings');
    if (from && from !== resolve('settings') && !from.startsWith(`${resolve('settings')}/`)) {
      returnToOpeningPage = navigation.type !== 'popstate';
      settingsDepth = returnToOpeningPage ? 1 : 0;
    } else if (navigation.type === 'popstate') {
      settingsDepth = Math.max(0, settingsDepth + navigation.delta);
    } else if (from && section !== null) {
      settingsDepth += 1;
    }
  });

  function close(): void {
    if (shallow) {
      history.back();
      return;
    }
    const mobile = !matchMedia(BREAKPOINTS.appLayout).matches;
    if (mobile && returnToOpeningPage && settingsDepth > 0) {
      history.go(-settingsDepth);
      return;
    }
    void goto(resolve('/(app)/rooms'), { replace: mobile });
  }

  function select(nextSection: string, focus?: string): void {
    const query = focus === undefined ? '' : `?focus=${encodeURIComponent(focus)}`;
    if (shallow) {
      void goto(resolve(`settings/${nextSection}${query}`), {
        shallow: true,
        replace: true,
        state: { settings: { section: nextSection, focus } },
      });
      return;
    }
    void goto(resolve(`settings/${nextSection}${query}`));
  }

  function focusPanel(event: Event): void {
    if (!matchMedia('(pointer: coarse)').matches) return;
    event.preventDefault();
    document.querySelector<HTMLElement>('.dialog-content-settings')?.focus({ preventScroll: true });
  }

  function back(): void {
    if (enteredFromList) history.back();
    else void goto(resolve('settings'), { replace: true });
  }
</script>

{#snippet content(activeSection: string)}
  {#if shallow}
    <SettingsSectionContent section={activeSection} {focus} />
  {:else}
    {@render children?.()}
  {/if}
{/snippet}

<DialogFrame
  open
  ownsBack
  variant="settings"
  onOpenAutoFocus={focusPanel}
  onOpenChange={(open) => {
    if (!open) close();
  }}
>
  <SettingsNavigator {section} onSelect={select} onBack={back} onClose={close} {content} />
</DialogFrame>
