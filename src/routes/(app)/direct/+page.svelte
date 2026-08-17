<script lang="ts">
  import CreateChatForm from '$lib/features/direct/CreateChatForm.svelte';
  import { i18n } from '$lib/i18n';
  import AppPageShell from '$lib/ui/primitives/AppPageShell.svelte';
</script>

<AppPageShell title={$i18n.t('nav.direct')} description={$i18n.t('direct.description')}>
  <CreateChatForm />
</AppPageShell>
