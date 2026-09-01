<script lang="ts">
  import BottomSheet from '#lib/ui/primitives/BottomSheet.svelte';
  import { i18n } from '#lib/i18n.js';
  import SettingsSectionContent from './SettingsSectionContent.svelte';
  import SettingsNavigator from './SettingsNavigator.svelte';

  interface Props {
    open?: boolean;
  }

  let { open = $bindable(false) }: Props = $props();
  let section: string | null = $state(null);
  let focus: string | null = $state(null);

  function close(): void {
    open = false;
    section = null;
    focus = null;
  }

  function select(nextSection: string, nextFocus?: string): void {
    section = nextSection;
    focus = nextFocus ?? null;
  }

  function back(): void {
    section = null;
    focus = null;
  }
</script>

{#snippet content(activeSection: string)}
  <SettingsSectionContent section={activeSection} {focus} />
{/snippet}

<BottomSheet
  bind:open
  fullHeight
  label={$i18n.t('settings.title')}
  closeLabel={$i18n.t('settings.close')}
  onOpenChange={(next) => {
    if (!next) close();
  }}
>
  <SettingsNavigator {section} onSelect={select} onBack={back} onClose={close} {content} />
</BottomSheet>
