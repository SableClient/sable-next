<script lang="ts">
  import { goto } from '$app/navigation';
  import { resolve } from '$app/paths';
  import BugReportForm from '#lib/features/bug-report/BugReportForm.svelte';
  import { i18n } from '#lib/i18n.js';
  import AppPageShell from '#lib/ui/primitives/AppPageShell.svelte';

  function close(): void {
    void goto(resolve('/(app)/rooms'));
  }
</script>

<AppPageShell
  title={$i18n.t('bugReport.titlePage')}
  description={$i18n.t('bugReport.descriptionPage')}
  eyebrow={$i18n.t('bugReport.eyebrow')}
>
  <BugReportForm onDone={close} />
</AppPageShell>
