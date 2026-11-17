<script module lang="ts">
  import { defineMeta } from '@storybook/addon-svelte-csf';

  import IconContext from 'phosphor-svelte/lib/IconContext';

  import Pill from './Pill.svelte';
  import PresenceDot from './PresenceDot.svelte';
  import PronounPill from './PronounPill.svelte';
  import RoomIcon from './RoomIcon.svelte';
  import TypingDots from './TypingDots.svelte';
  import UnreadBadge from './UnreadBadge.svelte';

  const { Story } = defineMeta({
    title: 'Primitives/Badges',
    tags: ['autodocs'],
  });

  const decorative = { 'aria-hidden': 'true' } as const;

  const pronouns = [
    { summary: 'she/her', language: null },
    { summary: 'they/them', language: null },
    { summary: 'elle/iel', language: 'fr' },
  ];

  const rooms = [
    { name: 'Text room', roomKind: 'text', hasParent: true, joinRule: 'restricted' },
    { name: 'Public room', roomKind: 'text', hasParent: false, joinRule: 'public' },
    { name: 'Private room', roomKind: 'text', hasParent: false, joinRule: 'invite' },
    { name: 'Voice room', roomKind: 'voice', hasParent: true, joinRule: 'restricted' },
    { name: 'Space', roomKind: 'space', hasParent: false, joinRule: 'public' },
    { name: 'Private space', roomKind: 'space', hasParent: false, joinRule: 'invite' },
  ] as const;
</script>

<Story name="Pill" asChild>
  <div class="row">
    <Pill>Unread</Pill>
    <Pill variant="primary">Mentions</Pill>
    <Pill disabled>Archived</Pill>
  </div>
</Story>

<Story name="Pronoun pill" asChild>
  <div class="stack">
    <PronounPill {pronouns} />
    <div class="narrow">
      <PronounPill {pronouns} />
    </div>
  </div>
</Story>

<Story name="Unread badge" asChild>
  <div class="row">
    <UnreadBadge
      counts={{ unread: 3, notifying: 3, highlight: 0, marked: false }}
      label="3 unread"
    />
    <UnreadBadge
      counts={{ unread: 12, notifying: 12, highlight: 2, marked: false }}
      label="2 mentions"
    />
    <UnreadBadge
      counts={{ unread: 128, notifying: 128, highlight: 0, marked: false }}
      label="128 unread"
    />
    <UnreadBadge
      counts={{ unread: 0, notifying: 0, highlight: 0, marked: true }}
      dm
      label="Marked unread"
    />
  </div>
</Story>

<Story name="Presence dot" asChild>
  <div class="row">
    <span class="item"><PresenceDot presence="online" label="Online" />Online</span>
    <span class="item"><PresenceDot presence="unavailable" label="Away" />Away</span>
    <span class="item"><PresenceDot presence="busy" label="Busy" />Busy</span>
    <span class="item"><PresenceDot presence="offline" label="Offline" />Offline</span>
  </div>
  <div class="row">
    <PresenceDot presence="online" label="Online" size="small" />
    <PresenceDot presence="online" label="Online" size="medium" />
    <PresenceDot presence="online" label="Online" size="large" />
  </div>
</Story>

<Story name="Typing dots" asChild>
  <span class="item"><TypingDots />Ana is typing</span>
</Story>

<Story name="Room icon" asChild>
  <IconContext values={decorative}>
    <div class="row">
      {#each rooms as room (room.name)}
        <span class="item">
          <RoomIcon roomKind={room.roomKind} hasParent={room.hasParent} joinRule={room.joinRule} />
          {room.name}
        </span>
      {/each}
    </div>
    <div class="row">
      <RoomIcon roomKind="text" joinRule="public" weight="fill" />
      <RoomIcon roomKind="space" weight="fill" />
    </div>
  </IconContext>
</Story>

<style>
  .stack {
    display: grid;
    gap: var(--space-400);
    max-width: 26rem;
  }

  .row {
    align-items: center;
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-400);
    margin-bottom: var(--space-400);
  }

  .item {
    align-items: center;
    display: inline-flex;
    gap: var(--space-200);
  }

  .narrow {
    width: 9rem;
  }
</style>
