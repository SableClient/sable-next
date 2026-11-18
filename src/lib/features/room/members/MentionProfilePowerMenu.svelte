<script lang="ts">
  import IconContext from 'phosphor-svelte/lib/IconContext';
  import ShieldIcon from 'phosphor-svelte/lib/ShieldIcon';

  import { i18n } from '#lib/i18n.js';
  import ActionMenuItem from '#lib/ui/primitives/ActionMenuItem.svelte';
  import ActionMenuSub from '#lib/ui/primitives/ActionMenuSub.svelte';

  import { FOUNDER_POWER_LEVEL, type PowerLevelTagMap } from '../settings/power-level-tags.js';
  import { powerTag } from './power-tags.js';

  interface Props {
    ownPowerLevel: number;
    currentLevel: number;
    powerTags: PowerLevelTagMap | null;
    onSelect: (level: number) => void;
  }

  let { ownPowerLevel, currentLevel, powerTags, onSelect }: Props = $props();

  // The spec caps what you may grant at your own level.
  let powerRoles = $derived(
    [...new Set([100, 50, 0, -1, ...Object.keys(powerTags ?? {}).map(Number)])]
      .filter(
        (level) => level <= ownPowerLevel && level !== FOUNDER_POWER_LEVEL && level !== currentLevel
      )
      .sort((left, right) => right - left)
      .map((level) => ({ level, label: powerTag(level, i18n.t, powerTags ?? {}).name }))
  );
</script>

<ActionMenuSub label={i18n.t('timeline.profileChangePower')}>
  {#snippet trigger()}
    <ShieldIcon />
    {i18n.t('timeline.profileChangePower')}
  {/snippet}
  <IconContext values={{ 'aria-hidden': 'true' }}>
    {#each powerRoles as role (role.level)}
      <ActionMenuItem
        onSelect={() => {
          onSelect(role.level);
        }}
      >
        <span class="profile-power-name">{role.label}</span>
        <span class="profile-power-level">{role.level}</span>
      </ActionMenuItem>
    {/each}
  </IconContext>
</ActionMenuSub>

<style>
  :global(.profile-power-name) {
    flex: 1;
  }

  :global(.profile-power-level) {
    color: var(--surface-var-on-container);
    font-size: var(--font-size-small);
    font-variant-numeric: tabular-nums;
  }
</style>
