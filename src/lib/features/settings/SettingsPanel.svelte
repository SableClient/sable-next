<script lang="ts">
  import { afterNavigate, goto } from '$app/navigation';
  import { resolve } from '$app/paths';
  import type { Snippet } from 'svelte';
  import { BREAKPOINTS } from '#lib/ui/breakpoints.js';
  import DialogFrame from '#lib/ui/primitives/DialogFrame.svelte';
  import SettingsSectionContent from './SettingsSectionContent.svelte';
  import SettingsNavigator from './SettingsNavigator.svelte';
  import { SettingsHistory } from './settings-history.js';

  interface Props {
    section: string | null;
    shallow?: boolean;
    focus?: string | null;
    children?: Snippet;
  }

  let { section, shallow = false, focus = null, children }: Props = $props();

  const settingsRoot = resolve('settings');
  const visits = new SettingsHistory(
    (path) => path === settingsRoot || path.startsWith(`${settingsRoot}/`)
  );

  afterNavigate((navigation) => {
    if (navigation.shallow || matchMedia(BREAKPOINTS.appLayout).matches) return;
    visits.visit({
      type: navigation.type,
      delta: navigation.type === 'popstate' ? navigation.delta : undefined,
      fromPath: navigation.from?.url.pathname ?? null,
    });
  });

  function close(): void {
    if (shallow) {
      history.back();
      return;
    }
    if (visits.depth > 0) {
      history.go(-visits.depth);
      return;
    }
    void goto(resolve('/(app)/rooms'), {
      replace: !matchMedia(BREAKPOINTS.appLayout).matches,
    });
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
    if (visits.depth > 0) {
      history.back();
      return;
    }
    visits.replacing();
    void goto(settingsRoot, { replace: true });
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
