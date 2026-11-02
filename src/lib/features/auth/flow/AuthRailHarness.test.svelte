<script lang="ts">
  import IconContext from 'phosphor-svelte/lib/IconContext';
  import AuthPage from '../shared/AuthPage.svelte';
  import AuthRail from './AuthRail.svelte';
  import AuthStageCard from './AuthStageCard.svelte';

  let { activeIndex = 0, booting = false }: { activeIndex?: number; booting?: boolean } = $props();
</script>

<IconContext values={{ 'aria-hidden': true }}>
  <AuthPage hasLoggedInBefore={false} status={booting ? 'Starting Sable…' : undefined}>
    <AuthRail
      {activeIndex}
      total={2}
      canBack={activeIndex > 0}
      canForward={activeIndex === 0}
      onBack={() => (activeIndex = 0)}
      onForward={() => (activeIndex = 1)}
    >
      <AuthStageCard active={activeIndex === 0} onActivate={() => (activeIndex = 0)}>
        <h2>Sign in</h2>
        <label for="provider">Account provider</label>
        <input id="provider" />
      </AuthStageCard>
      <AuthStageCard active={activeIndex === 1} onActivate={() => (activeIndex = 1)}>
        <h2>Create account</h2>
        <label for="new-username">New username</label>
        <input id="new-username" />
      </AuthStageCard>
    </AuthRail>
  </AuthPage>
  <button type="button">Outside auth</button>
</IconContext>
