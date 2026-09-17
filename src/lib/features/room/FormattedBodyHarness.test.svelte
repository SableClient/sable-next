<script lang="ts">
  import { untrack } from 'svelte';

  import FormattedBody from './FormattedBody.svelte';
  import { provideRoomAbbreviations, RoomAbbreviations } from './room-abbreviations.svelte.js';
  import type { AbbreviationEntry } from './settings/abbreviations';
  import TooltipProvider from '#lib/ui/primitives/TooltipProvider.svelte';

  interface Props {
    html: string;
    entries: AbbreviationEntry[];
  }

  let { html, entries }: Props = $props();
  let currentHtml = $state(untrack(() => html));
  const abbreviations = new RoomAbbreviations({
    roomStateEvent: () => Promise.resolve({ entries }),
  });
  provideRoomAbbreviations(abbreviations);
  void abbreviations.load('!room:example.org', []);

  export function replaceHtml(value: string): void {
    currentHtml = value;
  }
</script>

<TooltipProvider>
  <FormattedBody html={currentHtml} />
</TooltipProvider>
