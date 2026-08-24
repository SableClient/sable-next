<script module lang="ts">
  import { defineMeta } from '@storybook/addon-svelte-csf';
  import ChatCircleIcon from 'phosphor-svelte/lib/ChatCircleIcon';
  import GlobeIcon from 'phosphor-svelte/lib/GlobeIcon';
  import LockIcon from 'phosphor-svelte/lib/LockIcon';

  import Label from './Label.svelte';
  import OptionCards from './OptionCards.svelte';
  import Select from './Select.svelte';
  import type { OptionCard } from './option-card';

  const { Story } = defineMeta({
    title: 'Primitives/Choice',
    tags: ['autodocs'],
  });

  const visibility: readonly OptionCard<'public' | 'private' | 'direct'>[] = [
    { value: 'public', label: 'Public', hint: 'Anyone can find and join.', icon: GlobeIcon },
    { value: 'private', label: 'Private', hint: 'Invite only.', icon: LockIcon },
    {
      value: 'direct',
      label: 'Direct message',
      hint: 'Just the two of you.',
      icon: ChatCircleIcon,
      disabled: true,
    },
  ];

  const items = [
    { value: 'all', label: 'All messages' },
    { value: 'mentions', label: 'Mentions and keywords' },
    { value: 'mute', label: 'Nothing' },
    { value: 'default', label: 'Match the account default', disabled: true },
  ];
</script>

<Story name="Option cards" asChild>
  <div class="stack">
    <OptionCards label="Room visibility" options={visibility} value="public" onSelect={() => {}} />
  </div>
</Story>

<Story name="Option cards: nothing selected" asChild>
  <div class="stack">
    <OptionCards label="Room visibility" options={visibility} value={null} onSelect={() => {}} />
  </div>
</Story>

<Story name="Select" asChild>
  <div class="stack">
    <Label for="notify">Notify me about</Label>
    <Select id="notify" {items} value="mentions" placeholder="Choose one" />
  </div>
</Story>

<style>
  .stack {
    display: grid;
    gap: var(--space-200);
    max-width: 24rem;
  }
</style>
