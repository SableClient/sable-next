<script lang="ts">
  import PlusIcon from 'phosphor-svelte/lib/PlusIcon';
  import TrashIcon from 'phosphor-svelte/lib/TrashIcon';

  import { useCoreClient } from '#lib/core/context.js';
  import { i18n } from '#lib/i18n.js';
  import Alert from '#lib/ui/primitives/Alert.svelte';
  import Button from '#lib/ui/primitives/Button.svelte';
  import IconButton from '#lib/ui/primitives/IconButton.svelte';
  import Spinner from '#lib/ui/primitives/Spinner.svelte';
  import TextInput from '#lib/ui/primitives/TextInput.svelte';

  const core = useCoreClient();

  let alive = true;
  let keywords = $state<string[]>([]);
  let loading = $state(true);
  let draft = $state('');
  let adding = $state(false);
  let removingKeyword = $state<string | null>(null);
  let error = $state<string | null>(null);

  const trimmedDraft = $derived(draft.trim());
  const canAdd = $derived(trimmedDraft !== '' && !keywords.includes(trimmedDraft));

  async function reload(): Promise<void> {
    try {
      const result = await core.commands.notificationKeywords();
      if (!alive) return;
      keywords = result;
      error = null;
    } catch (cause) {
      console.warn('[sable notifications] loading keywords failed', cause);
      if (alive) error = 'settings.notificationKeywordsLoadFailed';
    }
  }

  $effect(() => {
    loading = true;
    void reload().finally(() => {
      if (alive) loading = false;
    });

    return () => {
      alive = false;
    };
  });

  async function addKeyword(): Promise<void> {
    const keyword = trimmedDraft;
    if (keyword === '' || keywords.includes(keyword)) return;

    adding = true;
    error = null;
    try {
      await core.commands.addNotificationKeyword(keyword);
      if (!alive) return;
      draft = '';
      await reload();
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
      await reload();
    } catch (cause) {
      console.warn('[sable notifications] removing a keyword failed', cause);
      if (alive) error = 'settings.notificationKeywordsRemoveFailed';
    } finally {
      if (alive) removingKeyword = null;
    }
  }
</script>

<section class="keywords" aria-labelledby="notification-keywords">
  <h3 id="notification-keywords">{$i18n.t('settings.notificationKeywords')}</h3>
  <p class="hint">{$i18n.t('settings.notificationKeywordsHint')}</p>

  {#if error}
    <Alert variant="warning" role="status">
      <p>{$i18n.t(error)}</p>
    </Alert>
  {/if}

  {#if loading}
    <p class="keywords-empty"><Spinner small /></p>
  {:else if keywords.length === 0}
    <p class="keywords-empty">{$i18n.t('settings.notificationKeywordsEmpty')}</p>
  {:else}
    <ul class="keyword-list">
      {#each keywords as keyword (keyword)}
        <li>
          <span class="keyword-text">{keyword}</span>
          <IconButton
            variant="ghost"
            size="large"
            disabled={removingKeyword === keyword}
            label={$i18n.t('settings.notificationKeywordsRemove', { keyword })}
            onclick={() => void removeKeyword(keyword)}
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

<style>
  .keywords {
    background: var(--sable-surface-var-container);
    border-radius: var(--radius);
    display: grid;
    gap: var(--space-300);
    padding: var(--space-400);
  }

  h3 {
    font-size: var(--font-size-heading);
    margin: 0;
  }

  .hint {
    color: var(--sable-surface-var-on-container);
    font-size: var(--font-size-small);
    margin: 0;
  }

  .keywords-empty {
    color: var(--sable-surface-var-on-container);
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
    background: var(--sable-surface-container);
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
