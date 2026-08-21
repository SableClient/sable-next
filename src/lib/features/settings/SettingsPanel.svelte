<script lang="ts">
  import { goto } from '$app/navigation';
  import { resolve } from '$app/paths';
  import type { Snippet } from 'svelte';
  import DialogFrame from '#lib/ui/primitives/DialogFrame.svelte';
  import SettingsSectionContent from './SettingsSectionContent.svelte';
  import SettingsNavigator from './SettingsNavigator.svelte';

  interface Props {
    section: string | null;
    shallow?: boolean;
    children?: Snippet;
  }

  let { section, shallow = false, children }: Props = $props();

  function close(): void {
    if (shallow) {
      history.back();
      return;
    }
    void goto(resolve('home'));
  }

  function select(nextSection: string): void {
    if (shallow) {
      void goto(resolve(`settings/${nextSection}`), {
        shallow: true,
        replace: true,
        state: { settings: { section: nextSection } },
      });
      return;
    }
    void goto(resolve(`settings/${nextSection}`));
  }

  function back(): void {
    void goto(resolve('settings'));
  }
</script>

{#snippet content(activeSection: string)}
  {#if shallow}<SettingsSectionContent section={activeSection} />{:else}{@render children?.()}{/if}
{/snippet}

<DialogFrame
  open
  variant="settings"
  onOpenChange={(open) => {
    if (!open) close();
  }}
>
  <SettingsNavigator {section} onSelect={select} onBack={back} onClose={close} {content} />
</DialogFrame>
