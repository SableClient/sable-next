<script module lang="ts">
  import { defineMeta } from '@storybook/addon-svelte-csf';
  import NavigationRail from './NavigationRail.svelte';
  import type { RoomListItemView } from '#src/generated/protocol';

  const spaces: RoomListItemView[] = [];

  const { Story } = defineMeta({
    title: 'Navigation Rail',
    tags: ['autodocs'],
  });
</script>

<Story name="Default">
  <NavigationRail {spaces} />
</Story>
