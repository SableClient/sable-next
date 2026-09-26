<script lang="ts">
  import type {
    KeywordNotificationView,
    MentionNotificationModeView,
  } from '#src/generated/protocol';
  import PlusIcon from 'phosphor-svelte/lib/PlusIcon';
  import TrashIcon from 'phosphor-svelte/lib/TrashIcon';

  import { useCoreClient } from '#lib/core/context.js';
  import { i18n } from '#lib/i18n.js';
  import SettingsAnchorLink from '#lib/ui/primitives/SettingsAnchorLink.svelte';
  import Alert from '#lib/ui/primitives/Alert.svelte';
  import Button from '#lib/ui/primitives/Button.svelte';
  import ConfirmDialog from '#lib/ui/primitives/ConfirmDialog.svelte';
  import IconButton from '#lib/ui/primitives/IconButton.svelte';
  import Select from '#lib/ui/primitives/Select.svelte';
  import Spinner from '#lib/ui/primitives/Spinner.svelte';
  import TextInput from '#lib/ui/primitives/TextInput.svelte';
  import { settingsChanges } from '#lib/features/notifications/notifications.svelte.js';
  import '#lib/ui/primitives/settings-row.css';

  const core = useCoreClient();

  let alive = true;
  let version = 0;
  const modes: MentionNotificationModeView[] = ['off', 'notify', 'loud'];
  const modeLabels: Record<MentionNotificationModeView, string> = {
    off: 'settings.mentionsOff',
    notify: 'settings.mentionsNotify',
    loud: 'settings.mentionsLoud',
  };

  let keywords = $state<KeywordNotificationView[]>([]);
  let loading = $state(true);
  let draft = $state('');
  let adding = $state(false);
  let removingKeyword = $state<string | null>(null);
  let pendingRemoval = $state<string | null>(null);
  let error = $state<string | null>(null);

  const trimmedDraft = $derived(draft.trim());
  const canAdd = $derived(
    trimmedDraft !== '' && !keywords.some((entry) => entry.keyword === trimmedDraft)
  );

  function commit(next: KeywordNotificationView[]): void {
    version += 1;
    keywords = next;
  }

  async function reload(): Promise<void> {
    const token = version;
    try {
      const result = await core.commands.notificationKeywords();
      if (!alive || token !== version) return;
      keywords = result;
      error = null;
    } catch (cause) {
      console.warn('[sable notifications] loading keywords failed', cause);
      if (alive && token === version) error = 'settings.notificationKeywordsLoadFailed';
    }
  }

  $effect(() => {
    void settingsChanges.version;
    void reload().finally(() => {
      if (alive) loading = false;
    });
  });

  $effect(() => () => {
    alive = false;
  });

  async function addKeyword(): Promise<void> {
    const keyword = trimmedDraft;
    if (keyword === '' || keywords.some((entry) => entry.keyword === keyword)) return;

    adding = true;
    error = null;
    try {
      await core.commands.addNotificationKeyword(keyword);
      if (!alive) return;
      draft = '';
      commit(
        [...keywords, { keyword, mode: 'notify' as const }].sort((left, right) =>
          left.keyword.localeCompare(right.keyword)
        )
      );
    } catch (cause) {
      console.warn('[sable notifications] adding a keyword failed', cause);
      if (alive) error = 'settings.notificationKeywordsAddFailed';
    } finally {
      if (alive) adding = false;
    }
  }

  async function removeKeyword(keyword: string): Promise<void> {
    removingKeyword = keyword;
    error = null;
    try {
      await core.commands.removeNotificationKeyword(keyword);
      if (!alive) return;
      commit(keywords.filter((existing) => existing.keyword !== keyword));
    } catch (cause) {
      console.warn('[sable notifications] removing a keyword failed', cause);
      if (alive) error = 'settings.notificationKeywordsRemoveFailed';
    } finally {
      if (alive) removingKeyword = null;
    }
  }

  async function setMode(keyword: string, mode: MentionNotificationModeView): Promise<void> {
    error = null;
    commit(keywords.map((entry) => (entry.keyword === keyword ? { keyword, mode } : entry)));
    try {
      await core.commands.setNotificationKeywordMode(keyword, mode);
    } catch (cause) {
      console.warn('[sable notifications] changing a keyword failed', cause);
      if (!alive) return;
      error = 'settings.notificationKeywordsModeFailed';
      await reload();
    }
  }

  async function confirmRemoval(): Promise<void> {
    const keyword = pendingRemoval;
    if (keyword === null) return;
    await removeKeyword(keyword);
    pendingRemoval = null;
  }
</script>

<section class="keywords settings-form" aria-labelledby="notification-keywords">
  <div class="settings-heading-row">
    <h3 id="notification-keywords" data-settings-outline>
      {$i18n.t('settings.notificationKeywords')}
    </h3>
    <SettingsAnchorLink anchor="notification-keywords" />
  </div>
  <p class="hint">{$i18n.t('settings.notificationKeywordsHint')}</p>

  {#if error}
    <Alert variant="warning" role="status">
      <p>{$i18n.t(error)}</p>
    </Alert>
  {/if}

  {#if loading}
    <p class="keywords-empty"><Spinner small label={$i18n.t('a11y.loading')} /></p>
  {:else if keywords.length === 0}
    <p class="keywords-empty">{$i18n.t('settings.notificationKeywordsEmpty')}</p>
  {:else}
    <ul class="keyword-list">
      {#each keywords as { keyword, mode } (keyword)}
        <li>
          <span class="keyword-text">{keyword}</span>
          <Select
            aria-label={$i18n.t('settings.notificationKeywordsMode', { keyword })}
            value={mode}
            items={modes.map((option) => ({ value: option, label: $i18n.t(modeLabels[option]) }))}
            onValueChange={(value) => {
              void setMode(keyword, value as MentionNotificationModeView);
            }}
          />
          <IconButton
            variant="subtle"
            size="large"
            disabled={removingKeyword === keyword}
            label={$i18n.t('settings.notificationKeywordsRemove', { keyword })}
            onclick={() => {
              pendingRemoval = keyword;
            }}
          >
            <TrashIcon />
          </IconButton>
        </li>
      {/each}
    </ul>
  {/if}

  <form
    class="keyword-form"
    onsubmit={(event) => {
      event.preventDefault();
      void addKeyword();
    }}
  >
    <label class="field">
      <span>{$i18n.t('settings.notificationKeywordsLabel')}</span>
      <div class="keyword-input-row">
        <TextInput
          bind:value={draft}
          placeholder={$i18n.t('settings.notificationKeywordsPlaceholder')}
          autocomplete="off"
          spellcheck="false"
        />
        <Button type="submit" size="small" disabled={!canAdd || adding} loading={adding}>
          <PlusIcon />
          {$i18n.t('settings.notificationKeywordsAdd')}
        </Button>
      </div>
    </label>
  </form>
</section>

<ConfirmDialog
  open={pendingRemoval !== null}
  onOpenChange={(next: boolean) => {
    if (!next && removingKeyword === null) pendingRemoval = null;
  }}
  title={$i18n.t('settings.notificationKeywordsConfirm', { keyword: pendingRemoval ?? '' })}
  confirmLabel={$i18n.t('settings.removeButton')}
  busy={removingKeyword !== null}
  onConfirm={() => void confirmRemoval()}
/>

<style>
  .keywords {
    background: var(--surface-var-container);
    border-radius: var(--radius);
    display: grid;
    gap: var(--space-300);
  }

  h3 {
    font-size: var(--font-size-heading);
    margin: 0;
  }

  .hint {
    color: var(--surface-var-on-container);
    font-size: var(--font-size-small);
    margin: 0;
  }

  .keywords-empty {
    color: var(--surface-var-on-container);
    margin: 0;
  }

  .keyword-list {
    display: grid;
    gap: var(--space-200);
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .keyword-list li {
    align-items: center;
    background: var(--surface-container);
    border-radius: var(--radius);
    display: flex;
    gap: var(--space-300);
    padding: var(--space-200) var(--space-300);
  }

  .keyword-text {
    flex: 1;
    min-width: 0;
    overflow-wrap: anywhere;
  }

  .field {
    display: grid;
    gap: var(--space-200);
  }

  .keyword-input-row {
    display: flex;
    flex-direction: column;
    gap: var(--space-300);
  }

  .keyword-input-row :global(.text-input) {
    width: 100%;
  }

  @media (width >= 32rem) {
    .keyword-input-row {
      flex-direction: row;
    }
  }
</style>
