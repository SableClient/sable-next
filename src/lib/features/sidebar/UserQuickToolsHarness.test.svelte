<script lang="ts">
  import TooltipProvider from '#lib/ui/primitives/TooltipProvider.svelte';
  import { provideAlertProviders } from './alerts';
  import UserQuickTools from './UserQuickTools.svelte';

  interface Props {
    mobile?: boolean;
    compact?: boolean;
  }

  let { mobile, compact }: Props = $props();

  provideAlertProviders([]);
</script>

<TooltipProvider>
  <UserQuickTools {mobile} {compact} />
</TooltipProvider>
