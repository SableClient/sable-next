<script lang="ts">
  import type { ComponentProps } from 'svelte';
  import FormattedBody from './FormattedBody.svelte';
  import { provideRoomAbbreviations, RoomAbbreviations } from '../room-abbreviations.svelte.js';
  import type { AbbreviationEntry } from '../settings/abbreviations';
  import TooltipProvider from '#lib/ui/primitives/TooltipProvider.svelte';

  interface Props {
    html: string;
    entries: AbbreviationEntry[];
    senderTimezone?: string | null;
    onMatrixLink?: ComponentProps<typeof FormattedBody>['onMatrixLink'];
  }

  let { html, entries, senderTimezone = null, onMatrixLink }: Props = $props();
  const abbreviations = new RoomAbbreviations({
    roomStateEvent: () => Promise.resolve({ entries }),
  });
  provideRoomAbbreviations(abbreviations);
  void abbreviations.load('!room:example.org', []);
</script>

<TooltipProvider>
  <FormattedBody {html} {senderTimezone} {onMatrixLink} />
</TooltipProvider>
