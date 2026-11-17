<script module lang="ts">
  import { defineMeta } from '@storybook/addon-svelte-csf';
  import ArrowLeftIcon from 'phosphor-svelte/lib/ArrowLeftIcon';
  import IconContext from 'phosphor-svelte/lib/IconContext';
  import MagnifyingGlassIcon from 'phosphor-svelte/lib/MagnifyingGlassIcon';
  import PushPinIcon from 'phosphor-svelte/lib/PushPinIcon';
  import UsersIcon from 'phosphor-svelte/lib/UsersIcon';

  import Button from './Button.svelte';
  import PanelHeader from './PanelHeader.svelte';
  import PanelHeaderButton from './PanelHeaderButton.svelte';
  import ProfileCard from './ProfileCard.svelte';

  const { Story } = defineMeta({
    title: 'Primitives/Panel',
    tags: ['autodocs'],
  });

  const decorative = { 'aria-hidden': 'true' } as const;
</script>

<Story name="Panel header" asChild>
  <div class="stack">
    <IconContext values={decorative}>
      <section aria-label="Room header">
        <PanelHeader title="Design Critique" subtitle="Weekly review of mockups" />
      </section>
      <section aria-label="Members header">
        <PanelHeader title="Members" titleSize="h1">
          {#snippet prefix()}
            <PanelHeaderButton label="Back"><ArrowLeftIcon /></PanelHeaderButton>
          {/snippet}
          {#snippet suffix()}
            <PanelHeaderButton label="Search members"><MagnifyingGlassIcon /></PanelHeaderButton>
          {/snippet}
        </PanelHeader>
      </section>
      <section aria-label="Toolbar header">
        <PanelHeader title="Design Critique" suffixToolbarLabel="Room actions">
          {#snippet suffix()}
            <PanelHeaderButton label="Pinned messages"><PushPinIcon /></PanelHeaderButton>
            <PanelHeaderButton label="Members" aria-pressed={true}><UsersIcon /></PanelHeaderButton>
            <PanelHeaderButton label="Search"><MagnifyingGlassIcon /></PanelHeaderButton>
          {/snippet}
        </PanelHeader>
      </section>
    </IconContext>
  </div>
</Story>

<Story name="Profile card" asChild>
  <div class="card">
    <ProfileCard
      displayName="Ana Costa"
      userId="@ana:sable.moe"
      color="#7c5cff"
      presence="online"
      presenceLabel="Online"
      status="Reviewing mockups"
      statusEmoji="🎨"
    >
      {#snippet actions()}
        <Button variant="primary" size="small">Message</Button>
        <Button variant="ghost" size="small">Ignore</Button>
      {/snippet}
      <p>Product designer. Mostly here for the weekly critique.</p>
    </ProfileCard>
  </div>
</Story>

<Story name="Profile card: tinted" asChild>
  <div class="card">
    <ProfileCard
      displayName="Noor Haddad"
      userId="@noor:sable.moe"
      color="#1f6f5c"
      heroColor="#1f6f5c"
      presence="busy"
      presenceLabel="Busy"
    >
      {#snippet actions()}
        <Button variant="primary" size="small">Message</Button>
      {/snippet}
    </ProfileCard>
  </div>
</Story>

<style>
  .stack {
    display: grid;
    gap: var(--space-400);
    max-width: 30rem;
  }

  .card {
    width: min(22rem, 100%);
  }
</style>
