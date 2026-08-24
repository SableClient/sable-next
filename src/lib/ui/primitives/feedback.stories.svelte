<script module lang="ts">
  import { defineMeta } from '@storybook/addon-svelte-csf';

  import Alert from './Alert.svelte';
  import Button from './Button.svelte';
  import EmptyState from './EmptyState.svelte';
  import Progress from './Progress.svelte';
  import Skeleton from './Skeleton.svelte';

  const { Story } = defineMeta({
    title: 'Primitives/Feedback',
    tags: ['autodocs'],
  });
</script>

<Story name="Alert" asChild>
  <div class="stack">
    <Alert variant="info" title="Heads up">Your session will expire in an hour.</Alert>
    <Alert variant="success" title="Verified">This device can now read old messages.</Alert>
    <Alert variant="warning" title="Unverified">Some devices in this room are unverified.</Alert>
    <Alert variant="critical" title="Failed to send">Check your connection and try again.</Alert>
  </div>
</Story>

<Story name="Progress" asChild>
  <div class="stack">
    <Progress value={12} label="Uploading" />
    <Progress value={64} label="Uploading" />
    <Progress value={100} label="Uploaded" />
  </div>
</Story>

<Story name="Skeleton" asChild>
  <div class="stack">
    <Skeleton style="height: 1rem; width: 60%" />
    <Skeleton style="height: 1rem; width: 90%" />
    <Skeleton style="height: 1rem; width: 40%" />
  </div>
</Story>

<Story name="Empty state" asChild>
  <EmptyState
    eyebrow="No rooms"
    title="Nothing here yet"
    description="Join a room or start a direct message to get going."
  >
    {#snippet actions()}
      <Button variant="primary">Explore rooms</Button>
      <Button variant="ghost">Start a chat</Button>
    {/snippet}
  </EmptyState>
</Story>

<style>
  .stack {
    display: grid;
    gap: var(--space-400);
    max-width: 26rem;
  }
</style>
