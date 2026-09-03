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

<Story name="Selection state matrix" asChild>
  <div class="state-matrix">
    <section class="state-card">
      <div>
        <strong>Chosen value</strong>
        <span>Persistent choice, such as a tab, filter, or toggle.</span>
      </div>
      <button class="state-sample sable-choice" type="button" aria-pressed={true}>
        Selected
      </button>
    </section>

    <section class="state-card">
      <div>
        <strong>Current location</strong>
        <span>Where navigation is currently positioned.</span>
      </div>
      <a class="state-sample sable-current" href="#selection-state-matrix" aria-current="page">
        Current page
      </a>
    </section>

    <section class="state-card">
      <div>
        <strong>Open</strong>
        <span>A menu, popover, or disclosure is currently open.</span>
      </div>
      <button class="state-sample sable-open" type="button" data-state="open" aria-expanded={true}>
        Open menu
      </button>
    </section>

    <section class="state-card">
      <div>
        <strong>Keyboard highlight</strong>
        <span>The next item to activate; it is not committed yet.</span>
      </div>
      <button class="state-sample sable-highlight" type="button" data-highlighted={true}>
        Highlighted option
      </button>
    </section>
  </div>
</Story>

<style>
  .stack {
    display: grid;
    gap: var(--space-200);
    max-width: 24rem;
  }

  .state-matrix {
    display: grid;
    gap: var(--space-200);
    max-width: 42rem;
  }

  .state-card {
    align-items: center;
    background: var(--sable-surface-container);
    border: var(--border-width) solid var(--sable-surface-container-line);
    border-radius: var(--radii-400);
    display: grid;
    gap: var(--space-300);
    grid-template-columns: minmax(0, 1fr) auto;
    padding: var(--space-300);
  }

  .state-card > div {
    display: grid;
    gap: var(--space-050);
  }

  .state-card span {
    color: var(--sable-surface-var-on-container);
    font-size: var(--font-size-small);
  }

  .state-sample {
    align-items: center;
    border: var(--border-width) solid transparent;
    border-radius: var(--radius-pill);
    color: inherit;
    cursor: pointer;
    display: inline-flex;
    font: inherit;
    font-weight: var(--font-weight-600);
    justify-content: center;
    min-height: var(--control-height-400);
    padding: 0 var(--space-300);
    text-decoration: none;
    white-space: nowrap;
  }
</style>
