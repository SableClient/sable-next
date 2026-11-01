<script lang="ts">
  import { resolve } from '$app/paths';

  import { useCoreClient } from '#lib/core/context.js';
  import { i18n } from '#lib/i18n.js';
  import { readJson, writeJson } from '#lib/platform/local-json.js';
  import {
    settingFocusId,
    settingsCategories,
    settingsContext,
    settingsTargets,
    type SettingsTargetDefinition,
  } from '#lib/settings/registry.js';
  import Button from '#lib/ui/primitives/Button.svelte';
  import settingsChanges from '../../../generated/settings-changes.json';

  interface Change {
    added: string[];
    changed: { key: string }[];
  }

  interface Props {
    changes?: Record<string, Change>;
    version?: string;
  }

  const DISMISSED_KEY = 'sable.dismissed-settings-changes';

  let { changes = settingsChanges, version = import.meta.env.VITE_APP_VERSION ?? '' }: Props =
    $props();
  const core = useCoreClient();

  const section = $derived(!version || version.includes('-nightly.') ? 'upcoming' : `v${version}`);

  function find(
    key: string
  ): { categoryId: string; setting: SettingsTargetDefinition } | undefined {
    for (const category of settingsCategories) {
      const setting = settingsTargets(category).find((target) => target.key === key);
      if (setting && (setting.supported?.(settingsContext(core)) ?? true))
        return { categoryId: category.id, setting };
    }
    return undefined;
  }

  const entries = $derived.by(() => {
    const change = changes[section];
    const rows = [
      ...(change?.added ?? []).map((key) => ({ key, label: 'home.settingsChangesNew' })),
      ...(change?.changed ?? []).map(({ key }) => ({ key, label: 'home.settingsChangesDefault' })),
    ];
    return rows.flatMap((row) => {
      const found = find(row.key);
      if (!found) return [];
      const focus = found.setting.focusId ?? settingFocusId(found.setting.key);
      return [
        {
          ...row,
          name: found.setting.name,
          href: resolve(`settings/${found.categoryId}?focus=${encodeURIComponent(focus)}`),
        },
      ];
    });
  });

  const dismissalId = $derived(`${section}:${entries.length}`);
  let dismissedId = $state(
    readJson(DISMISSED_KEY, (value) => (typeof value === 'string' ? value : ''), '')
  );

  function dismiss() {
    dismissedId = dismissalId;
    writeJson(DISMISSED_KEY, dismissedId);
  }
</script>

{#if entries.length > 0 && dismissedId !== dismissalId}
  <section class="settings-changes" aria-labelledby="settings-changes-title">
    <div class="header">
      <h2 id="settings-changes-title">{i18n.t('home.settingsChangesTitle')}</h2>
      <Button variant="ghost" size="small" onclick={dismiss}>{i18n.t('common.dismiss')}</Button>
    </div>
    <ul>
      {#each entries as entry (entry.key)}
        <li>
          <!-- eslint-disable svelte/no-navigation-without-resolve -- href is resolved above -->
          <a href={entry.href}>{i18n.t(entry.name)}</a>
          <!-- eslint-enable svelte/no-navigation-without-resolve -->
          <span class="badge">{i18n.t(entry.label)}</span>
        </li>
      {/each}
    </ul>
  </section>
{/if}

<style>
  .settings-changes {
    background: var(--bg-container);
    border: var(--border-width) solid var(--bg-container-line);
    border-radius: var(--radius);
    margin-top: var(--space-600);
    padding: var(--space-400);
  }

  .header {
    align-items: center;
    display: flex;
    gap: var(--space-300);
    justify-content: space-between;
  }

  h2 {
    font-size: var(--font-size-heading);
    line-height: var(--line-height-heading);
    margin: 0;
  }

  ul {
    display: flex;
    flex-direction: column;
    gap: var(--space-300);
    list-style: none;
    margin: var(--space-400) 0 0;
    padding: 0;
  }

  li {
    align-items: center;
    display: flex;
    gap: var(--space-300);
    justify-content: space-between;
  }

  a {
    color: var(--primary-main);
  }

  .badge {
    color: var(--surface-var-on-container);
  }
</style>
