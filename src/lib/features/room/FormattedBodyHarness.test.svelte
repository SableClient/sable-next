<script lang="ts">
  import FormattedBody from './FormattedBody.svelte';
  import { provideRoomAbbreviations, RoomAbbreviations } from './room-abbreviations.svelte.js';
  import type { AbbreviationEntry } from './settings/abbreviations';

  interface Props {
    html: string;
    entries: AbbreviationEntry[];
  }

  let { html, entries }: Props = $props();
  const abbreviations = new RoomAbbreviations({
    roomStateEvent: () => Promise.resolve({ entries }),
  });
  provideRoomAbbreviations(abbreviations);
  void abbreviations.load('!room:example.org', []);
</script>

<FormattedBody {html} />
