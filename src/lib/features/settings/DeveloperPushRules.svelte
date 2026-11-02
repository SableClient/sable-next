<script lang="ts">
  import { useCoreClient } from '#lib/core/context.js';
  import { settingsChanges } from '#lib/features/notifications/notifications.svelte.js';
  import { i18n } from '#lib/i18n.js';
  import Alert from '#lib/ui/primitives/Alert.svelte';
  import Button from '#lib/ui/primitives/Button.svelte';
  import ConfirmDialog from '#lib/ui/primitives/ConfirmDialog.svelte';
  import FormField from '#lib/ui/primitives/FormField.svelte';
  import Select from '#lib/ui/primitives/Select.svelte';
  import Skeleton from '#lib/ui/primitives/Skeleton.svelte';
  import Switch from '#lib/ui/primitives/Switch.svelte';
  import TextArea from '#lib/ui/primitives/TextArea.svelte';
  import { scrollHint } from '#lib/ui/scroll-hint.js';

  interface Rule {
    rule_id: string;
    default: boolean;
    enabled: boolean;
    actions: unknown[];
  }

  interface Entry {
    kind: string;
    rule: Rule;
  }

  const KINDS = ['override', 'content', 'postcontent', 'room', 'sender', 'underride'];
  const NEW_RULE_TEMPLATES: Record<string, object> = {
    override: { rule_id: '', conditions: [], actions: ['notify'] },
    content: { rule_id: '', pattern: '', actions: ['notify'] },
    room: { rule_id: '!room:example.org', actions: ['notify'] },
    sender: { rule_id: '@user:example.org', actions: ['notify'] },
    underride: { rule_id: '', conditions: [], actions: ['notify'] },
  };

  const core = useCoreClient();
  let entries = $state.raw<Entry[]>([]);
  let selected = $state<{ kind: string; ruleId: string } | null>(null);
  let actions = $state('[]');
  let busy = $state(false);
  let error = $state<'json' | 'failed' | null>(null);
  let problem = $state<string | null>(null);
  let saved = $state(false);
  let confirmingDelete = $state(false);
  let draft = $state<{ kind: string; rule: string } | null>(null);
  let loaded = $state(false);

  const current = $derived(
    selected === null
      ? undefined
      : entries.find(
          (entry) => entry.kind === selected?.kind && entry.rule.rule_id === selected.ruleId
        )
  );

  async function refresh(): Promise<void> {
    if (!core.session) return;
    try {
      const ruleset = (await core.rpc.notifications.pushRules()) as Record<
        string,
        Rule[] | undefined
      >;
      entries = KINDS.flatMap((kind) => (ruleset[kind] ?? []).map((rule) => ({ kind, rule })));
    } catch {
      entries = [];
    } finally {
      loaded = true;
    }
  }

  $effect(() => {
    void settingsChanges.version;
    if (core.session?.account_id === undefined) {
      entries = [];
      selected = null;
      return;
    }
    void refresh();
  });

  function template(kind: string): string {
    return JSON.stringify(NEW_RULE_TEMPLATES[kind], null, 2);
  }

  function startDraft(): void {
    selected = null;
    draft = { kind: 'override', rule: template('override') };
    error = null;
    saved = false;
  }

  function ruleProblem(kind: string, rule: Record<string, unknown>): string | null {
    const ruleId = rule.rule_id;
    if (typeof ruleId !== 'string' || ruleId.trim() === '') return 'developerPushRulesNeedsId';
    if (kind === 'room' && !ruleId.startsWith('!')) return 'developerPushRulesNeedsRoomId';
    if (kind === 'sender' && !ruleId.startsWith('@')) return 'developerPushRulesNeedsUserId';
    if (kind === 'content' && typeof rule.pattern !== 'string')
      return 'developerPushRulesNeedsPattern';
    if ('conditions' in rule && !Array.isArray(rule.conditions)) {
      return 'developerPushRulesNeedsConditions';
    }
    if (!Array.isArray(rule.actions)) return 'developerPushRulesInvalidActions';
    return null;
  }

  async function create(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (draft === null || busy) return;
    let rule: unknown;
    try {
      rule = JSON.parse(draft.rule);
    } catch {
      rule = null;
    }
    if (typeof rule !== 'object' || rule === null || Array.isArray(rule)) {
      error = 'json';
      problem = 'developerPushRulesInvalidRule';
      return;
    }
    const { kind } = draft;
    problem = ruleProblem(kind, rule as Record<string, unknown>);
    if (problem !== null) {
      error = 'json';
      return;
    }
    busy = true;
    error = null;
    try {
      await core.rpc.notifications.addPushRule({ kind, rule });
      draft = null;
      await refresh();
      const ruleId = (rule as { rule_id?: unknown }).rule_id;
      if (typeof ruleId === 'string') selected = { kind, ruleId };
      saved = true;
    } catch {
      error = 'failed';
    } finally {
      busy = false;
    }
  }

  function open(entry: Entry): void {
    draft = null;
    selected = { kind: entry.kind, ruleId: entry.rule.rule_id };
    actions = JSON.stringify(entry.rule.actions, null, 2);
    error = null;
    saved = false;
  }

  async function write(change: (entry: Entry) => Promise<unknown>): Promise<boolean> {
    if (!current || busy) return false;
    busy = true;
    error = null;
    saved = false;
    try {
      await change(current);
      saved = true;
      return true;
    } catch {
      error = 'failed';
      settingsChanges.version += 1;
      return false;
    } finally {
      busy = false;
    }
  }

  function setEnabled(enabled: boolean): void {
    void write(({ kind, rule }) =>
      core.rpc.notifications.setPushRuleEnabled({ kind, rule_id: rule.rule_id, enabled })
    );
  }

  function saveActions(event: SubmitEvent): void {
    event.preventDefault();
    let parsed: unknown;
    try {
      parsed = JSON.parse(actions);
    } catch {
      parsed = null;
    }
    if (!Array.isArray(parsed)) {
      error = 'json';
      saved = false;
      return;
    }
    void write(({ kind, rule }) =>
      core.rpc.notifications.setPushRuleActions({ kind, rule_id: rule.rule_id, actions: parsed })
    );
  }

  async function remove(): Promise<void> {
    const removed = await write(({ kind, rule }) =>
      core.rpc.notifications.deletePushRule({ kind, rule_id: rule.rule_id })
    );
    confirmingDelete = false;
    if (removed) selected = null;
  }
</script>

<div class="settings-form push-rules">
  <p class="description">{i18n.t('settings.developerPushRulesDescription')}</p>
  <div class="editor-actions">
    <Button size="small" disabled={draft !== null} onclick={startDraft}>
      {i18n.t('settings.developerPushRulesNew')}
    </Button>
  </div>
  {#if !loaded}
    <ul class="rule-list" aria-busy="true" aria-label={i18n.t('settings.developerPushRulesTitle')}>
      {#each { length: 6 }, index (index)}
        <li><Skeleton class="rule-loading" /></li>
      {/each}
    </ul>
  {:else if entries.length === 0}
    <p class="empty">{i18n.t('settings.developerPushRulesEmpty')}</p>
  {:else}
    <ul class="rule-list" {@attach scrollHint}>
      {#each entries as entry (`${entry.kind}/${entry.rule.rule_id}`)}
        {@const active = selected?.kind === entry.kind && selected.ruleId === entry.rule.rule_id}
        <li>
          <Button
            variant={active ? 'primary' : 'ghost'}
            size="small"
            class={['choice', !entry.rule.enabled && 'disabled-rule']}
            aria-pressed={active}
            block
            onclick={() => open(entry)}
          >
            <span class="kind">{entry.kind}</span>
            {entry.rule.rule_id}
          </Button>
        </li>
      {/each}
    </ul>
  {/if}

  {#if draft}
    <form class="editor" onsubmit={(event) => void create(event)}>
      <Select
        aria-label={i18n.t('settings.developerPushRulesKind')}
        value={draft.kind}
        items={Object.keys(NEW_RULE_TEMPLATES).map((kind) => ({ value: kind, label: kind }))}
        onValueChange={(kind) => {
          draft = { kind, rule: template(kind) };
        }}
      />
      <FormField
        fieldId="developer-push-rule-new"
        label={i18n.t('settings.developerPushRulesRule')}
      >
        <TextArea
          id="developer-push-rule-new"
          bind:value={draft.rule}
          error={error === 'json'}
          spellcheck={false}
          class="push-rule-json"
        />
      </FormField>
      {#if error === 'json' && problem !== null}
        <Alert variant="critical">{i18n.t(`settings.${problem}`)}</Alert>
      {:else if error === 'failed'}
        <Alert variant="critical">{i18n.t('settings.developerPushRulesFailed')}</Alert>
      {/if}
      <div class="editor-actions">
        <Button variant="ghost" size="small" onclick={() => (draft = null)}>
          {i18n.t('common.cancel')}
        </Button>
        <Button type="submit" variant="primary" size="small" loading={busy}>
          {i18n.t('settings.developerPushRulesCreate')}
        </Button>
      </div>
    </form>
  {:else if current}
    <form class="editor" onsubmit={saveActions}>
      <div class="enabled">
        <span>{i18n.t('settings.developerPushRulesEnabled')}</span>
        <Switch
          checked={current.rule.enabled}
          disabled={busy}
          label={i18n.t('settings.developerPushRulesEnabled')}
          onCheckedChange={setEnabled}
        />
      </div>
      <FormField fieldId="developer-push-rule" label={i18n.t('settings.developerPushRulesRule')}>
        <TextArea
          id="developer-push-rule"
          value={JSON.stringify(current.rule, null, 2)}
          readonly
          spellcheck={false}
          class="push-rule-json"
        />
      </FormField>
      <FormField
        fieldId="developer-push-rule-actions"
        label={i18n.t('settings.developerPushRulesActions')}
      >
        <TextArea
          id="developer-push-rule-actions"
          bind:value={actions}
          error={error === 'json'}
          spellcheck={false}
          class="push-rule-json"
        />
      </FormField>
      {#if error === 'json'}
        <Alert variant="critical">{i18n.t('settings.developerPushRulesInvalidActions')}</Alert>
      {:else if error === 'failed'}
        <Alert variant="critical">{i18n.t('settings.developerPushRulesFailed')}</Alert>
      {:else if saved}
        <Alert variant="success">{i18n.t('settings.developerPushRulesSaved')}</Alert>
      {/if}
      <div class="editor-actions">
        {#if !current.rule.default}
          <Button
            variant="danger"
            size="small"
            disabled={busy}
            onclick={() => (confirmingDelete = true)}
          >
            {i18n.t('settings.developerPushRulesDelete')}
          </Button>
        {/if}
        <Button variant="ghost" size="small" onclick={() => (selected = null)}>
          {i18n.t('common.close')}
        </Button>
        <Button type="submit" variant="primary" size="small" loading={busy}>
          {i18n.t('common.save')}
        </Button>
      </div>
    </form>
  {/if}
</div>

<ConfirmDialog
  bind:open={confirmingDelete}
  title={i18n.t('settings.developerPushRulesDeleteConfirm', { rule: current?.rule.rule_id ?? '' })}
  description={i18n.t('settings.developerPushRulesDeleteDescription')}
  confirmLabel={i18n.t('settings.developerPushRulesDelete')}
  {busy}
  onConfirm={() => void remove()}
/>

<style>
  .push-rules,
  .editor {
    display: grid;
    gap: var(--space-300);
  }

  .description,
  .empty {
    font-size: var(--font-size-small);
    margin: 0;
  }

  .rule-list {
    display: grid;
    gap: var(--space-200);
    list-style: none;
    margin: 0;
    max-height: 18rem;
    overflow: auto;
    padding: 0;
  }

  .kind {
    color: var(--surface-var-on-container);
    font-family: var(--font-family-mono);
    font-size: var(--font-size-small);
    margin-inline-end: var(--space-200);
  }

  .rule-list :global(.rule-loading) {
    height: 2rem;
  }

  :global(.disabled-rule) {
    text-decoration: line-through;
  }

  .enabled {
    align-items: center;
    display: flex;
    justify-content: space-between;
  }

  :global(.push-rule-json) {
    font-family: var(--font-family-mono);
    font-size: var(--font-size-small);
    font-variant-ligatures: none;
  }

  .editor-actions {
    display: flex;
    gap: var(--space-300);
    justify-content: flex-end;
  }
</style>
