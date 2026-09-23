<script lang="ts">
  import BookmarkList from '#lib/features/inbox/BookmarkList.svelte';
  import { i18n } from '#lib/i18n.js';
  import AppPageShell from '#lib/ui/primitives/AppPageShell.svelte';
</script>

<AppPageShell title={$i18n.t('inbox.bookmarks')} density="compact">
  <BookmarkList standalone />
</AppPageShell>
