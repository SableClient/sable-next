<script lang="ts">
  import { useCoreClient } from '#lib/core/context.js';
  import { settingsChanges } from '#lib/features/notifications/notifications.svelte.js';
  import { i18n } from '#lib/i18n.js';
  import { useRoomList } from '#lib/rooms/room-list.svelte.js';
  import Alert from '#lib/ui/primitives/Alert.svelte';
  import Button from '#lib/ui/primitives/Button.svelte';
  import ConfirmDialog from '#lib/ui/primitives/ConfirmDialog.svelte';
  import FormField from '#lib/ui/primitives/FormField.svelte';
  import CopyValue from '#lib/ui/primitives/CopyValue.svelte';
  import ExplorerShell, { type ExplorerGroup } from '#lib/ui/primitives/ExplorerShell.svelte';
  import PlusIcon from 'phosphor-svelte/lib/PlusIcon';
  import Select from '#lib/ui/primitives/Select.svelte';
  import Switch from '#lib/ui/primitives/Switch.svelte';
  import CodeTextArea from '#lib/ui/primitives/CodeTextArea.svelte';

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
  const roomList = useRoomList();
  let query = $state('');
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

  const shown = $derived.by(() => {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return entries;
    return entries.filter((entry) =>
      [entry.kind, entry.rule.rule_id, roomName(entry) ?? ''].some((text) =>
        text.toLocaleLowerCase().includes(needle)
      )
    );
  });

  const ruleGroups = $derived<ExplorerGroup[]>(
    KINDS.map((kind) => ({
      id: kind,
      label: kind,
      items: shown
        .filter((entry) => entry.kind === kind)
        .map((entry) => ({
          id: `${entry.kind}/${entry.rule.rule_id}`,
          label: entry.rule.rule_id,
          hint: roomName(entry) ?? undefined,
          muted: !entry.rule.enabled,
        })),
    })).filter((group) => group.items.length > 0)
  );

  function roomName(entry: Entry): string | null {
    if (entry.kind !== 'room') return null;
    return roomList.rooms.find((room) => room.room_id === entry.rule.rule_id)?.display_name ?? null;
  }

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
  <ExplorerShell
    label={i18n.t('settings.developerPushRulesTitle')}
    groups={ruleGroups}
    selected={draft ? null : selected ? `${selected.kind}/${selected.ruleId}` : undefined}
    bind:query
    filterLabel={i18n.t('settings.developerPushRulesFilter')}
    empty={i18n.t('settings.developerPushRulesEmpty')}
    noMatches={i18n.t('common.noMatches')}
    placeholder={i18n.t('settings.developerPushRulesPick')}
    loading={!loaded}
    onSelect={(id) => {
      const entry = entries.find((item) => `${item.kind}/${item.rule.rule_id}` === id);
      if (entry) open(entry);
    }}
    onBack={() => {
      draft = null;
      selected = null;
    }}
  >
    {#snippet toolbar()}
      <Button size="field" variant="secondary" disabled={draft !== null} onclick={startDraft}>
        <PlusIcon aria-hidden="true" />
        {i18n.t('settings.developerPushRulesNew')}
      </Button>
    {/snippet}
    {#snippet head()}
      {#if draft}
        <Select
          aria-label={i18n.t('settings.developerPushRulesKind')}
          value={draft.kind}
          items={Object.keys(NEW_RULE_TEMPLATES).map((kind) => ({ value: kind, label: kind }))}
          onValueChange={(kind) => {
            draft = { kind, rule: template(kind) };
          }}
        />
      {:else if current}
        <h4 class="rule-head"><CopyValue value={current.rule.rule_id} mono={false} /></h4>
        <span class="kind">{current.kind}</span>
        <div class="enabled">
          <Switch
            checked={current.rule.enabled}
            disabled={busy}
            label={i18n.t('settings.developerPushRulesEnabled')}
            onCheckedChange={setEnabled}
          />
        </div>
      {/if}
    {/snippet}
    {#if draft}
      <form class="editor" onsubmit={(event) => void create(event)}>
        <FormField
          fieldId="developer-push-rule-new"
          label={i18n.t('settings.developerPushRulesRule')}
        >
          <CodeTextArea
            id="developer-push-rule-new"
            language="json"
            rows={12}
            bind:value={draft.rule}
            error={error === 'json'}
          />
        </FormField>
        {#if error === 'json' && problem !== null}
          <Alert variant="critical">{i18n.t(`settings.${problem}`)}</Alert>
        {:else if error === 'failed'}
          <Alert variant="critical">{i18n.t('settings.developerPushRulesFailed')}</Alert>
        {/if}
        <div class="editor-actions">
          <Button type="submit" variant="primary" size="small" loading={busy}>
            {i18n.t('settings.developerPushRulesCreate')}
          </Button>
        </div>
      </form>
    {:else if current}
      <form class="editor" onsubmit={saveActions}>
        <FormField fieldId="developer-push-rule" label={i18n.t('settings.developerPushRulesRule')}>
          <CodeTextArea
            id="developer-push-rule"
            language="json"
            rows={10}
            value={JSON.stringify(current.rule, null, 2)}
            readonly
          />
        </FormField>
        <FormField
          fieldId="developer-push-rule-actions"
          label={i18n.t('settings.developerPushRulesActions')}
        >
          <CodeTextArea
            id="developer-push-rule-actions"
            language="json"
            rows={5}
            bind:value={actions}
            error={error === 'json'}
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
          <Button type="submit" variant="primary" size="small" loading={busy}>
            {i18n.t('common.save')}
          </Button>
        </div>
      </form>
    {/if}
  </ExplorerShell>
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

  .description {
    font-size: var(--font-size-small);
    margin: 0;
  }

  .rule-head {
    font-size: var(--font-size-body);
    font-weight: var(--font-weight-medium);
    margin: 0;
    min-width: 0;
  }

  .kind {
    color: var(--surface-var-on-container);
    font-size: var(--font-size-small);
  }

  .enabled {
    margin-inline-start: auto;
  }

  .editor-actions {
    display: flex;
    gap: var(--space-300);
    justify-content: flex-end;
  }
</style>
