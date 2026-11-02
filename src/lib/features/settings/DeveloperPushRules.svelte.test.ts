// @vitest-environment happy-dom

import { fireEvent, render, screen } from '@testing-library/svelte';
import { flushSync, tick } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';

vi.mock('$app/state', () => import('#lib/test-support/app-state.js'));
vi.mock('#lib/core/context.js');

import { core as baseCore } from '#lib/core/__mocks__/context.js';

const pushRules = vi.fn<() => Promise<unknown>>();
const setPushRuleEnabled = vi.fn<(params: unknown) => Promise<void>>();
const setPushRuleActions = vi.fn<(params: unknown) => Promise<void>>();
const deletePushRule = vi.fn<(params: unknown) => Promise<void>>();
const addPushRule = vi.fn<(params: unknown) => Promise<void>>();
const core = Object.assign(baseCore, {
  rpc: {
    notifications: {
      pushRules,
      setPushRuleEnabled,
      setPushRuleActions,
      deletePushRule,
      addPushRule,
    },
  },
});

import { settingsChanges } from '#lib/features/notifications/notifications.svelte.js';

import DeveloperPushRules from './DeveloperPushRules.svelte';

const ruleset = {
  override: [{ rule_id: '.m.rule.master', default: true, enabled: false, actions: [] }],
  underride: [
    { rule_id: 'moe.sable.shape.message.!a:b', default: false, enabled: true, actions: [] },
  ],
};

afterEach(() => {
  for (const mock of [
    pushRules,
    setPushRuleEnabled,
    setPushRuleActions,
    deletePushRule,
    addPushRule,
  ]) {
    mock.mockReset();
  }
  core.session = null;
  document.body.innerHTML = '';
});

async function settle(): Promise<void> {
  await tick();
  await Promise.resolve();
  await Promise.resolve();
  flushSync();
}

async function opened(ruleId: string): Promise<void> {
  core.session = { account_id: 'account' };
  pushRules.mockResolvedValue(ruleset);
  render(DeveloperPushRules);
  await settle();
  await fireEvent.click(screen.getByRole('button', { name: new RegExp(ruleId) }));
  await settle();
}

test('server default rules cannot be deleted', async () => {
  await opened('.m.rule.master');

  expect(screen.queryByRole('button', { name: 'Delete rule' })).toBeNull();
});

test('actions are written through the push rules API', async () => {
  await opened('moe.sable.shape');
  const field = document.getElementById('developer-push-rule-actions') as HTMLTextAreaElement;
  await fireEvent.input(field, { target: { value: '["notify"]' } });
  await fireEvent.submit(field.closest('form') as HTMLFormElement);
  await settle();

  expect(setPushRuleActions).toHaveBeenCalledWith({
    kind: 'underride',
    rule_id: 'moe.sable.shape.message.!a:b',
    actions: ['notify'],
  });
});

test('actions that are not a JSON array are refused locally', async () => {
  await opened('moe.sable.shape');
  const field = document.getElementById('developer-push-rule-actions') as HTMLTextAreaElement;
  await fireEvent.input(field, { target: { value: '{"notify": true}' } });
  await fireEvent.submit(field.closest('form') as HTMLFormElement);
  await settle();

  expect(setPushRuleActions).not.toHaveBeenCalled();
  expect(screen.getByText('Actions must be a JSON array.')).toBeTruthy();
});

test('custom rules can be deleted', async () => {
  await opened('moe.sable.shape');

  expect(screen.getByRole('button', { name: 'Delete rule' })).toBeTruthy();
});

test('a refused toggle reloads the rules and resets the switch', async () => {
  setPushRuleEnabled.mockRejectedValue(new Error('refused'));
  await opened('moe.sable.shape');
  const calls = pushRules.mock.calls.length;

  await fireEvent.click(screen.getByRole('switch'));
  await settle();

  expect(pushRules.mock.calls.length).toBeGreaterThan(calls);
  expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('true');
});

test('a rule change from elsewhere reloads the list', async () => {
  await opened('moe.sable.shape');
  pushRules.mockResolvedValue({
    underride: [
      { rule_id: 'moe.sable.shape.message.!a:b', default: false, enabled: false, actions: [] },
    ],
  });

  settingsChanges.version += 1;
  await settle();

  expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('false');
});

async function drafting(rule: string): Promise<HTMLTextAreaElement> {
  core.session = { account_id: 'account' };
  pushRules.mockResolvedValue(ruleset);
  render(DeveloperPushRules);
  await settle();
  await fireEvent.click(screen.getByRole('button', { name: 'New rule' }));
  await settle();
  const field = document.getElementById('developer-push-rule-new') as HTMLTextAreaElement;
  await fireEvent.input(field, { target: { value: rule } });
  await fireEvent.submit(field.closest('form') as HTMLFormElement);
  await settle();
  return field;
}

test('a new rule is created through the push rules API', async () => {
  addPushRule.mockResolvedValue();
  await drafting('{"rule_id": "bots", "conditions": [], "actions": []}');

  expect(addPushRule).toHaveBeenCalledWith({
    kind: 'override',
    rule: { rule_id: 'bots', conditions: [], actions: [] },
  });
});

test('a new rule that is not a JSON object is refused locally', async () => {
  await drafting('["notify"]');

  expect(addPushRule).not.toHaveBeenCalled();
  expect(screen.getByText('The rule must be a JSON object.')).toBeTruthy();
});

test('a new rule without a rule id is refused with a reason', async () => {
  await drafting('{"rule_id": "", "conditions": [], "actions": []}');

  expect(addPushRule).not.toHaveBeenCalled();
  expect(screen.getByText('The rule needs a "rule_id".')).toBeTruthy();
});
