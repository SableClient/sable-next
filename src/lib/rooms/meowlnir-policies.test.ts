import { expect, test } from 'vitest';

import { filterPolicyRules, parsePolicyRules, policyKindOf } from './meowlnir-policies';

function rule(type: string, state_key: string, content: unknown) {
  return { type, state_key, content };
}

const events = [
  rule('m.policy.rule.user', 'a', {
    entity: '@spam:example.org',
    recommendation: 'm.ban',
    reason: 'spam',
  }),
  rule('org.matrix.mjolnir.rule.user', 'a', {
    entity: '@old:example.org',
    recommendation: 'org.matrix.mjolnir.ban',
  }),
  rule('m.room.rule.user', 'b', {
    entity: '@legacy:example.org',
    recommendation: 'org.matrix.mjolnir.ban',
  }),
  rule('m.policy.rule.user', 'removed', {}),
  rule('m.policy.rule.server', 'c', {
    entity: '*.evil.example',
    recommendation: 'org.matrix.msc4204.takedown',
  }),
  rule('m.policy.rule.user', 'd', {
    recommendation: 'm.ban',
    'org.matrix.msc4205.hashes': { sha256: 'abc' },
  }),
  rule('m.policy.rule.room', 'e', { entity: '!room:example.org', recommendation: 'x.custom' }),
  rule('m.room.member', '@mod:example.org', { membership: 'join' }),
];

test('reads the rules of a list, the stable type winning over older ones', () => {
  expect(parsePolicyRules(events)).toEqual([
    {
      key: 'user:a',
      kind: 'user',
      entity: '@spam:example.org',
      action: 'ban',
      recommendation: 'm.ban',
      reason: 'spam',
    },
    {
      key: 'user:d',
      kind: 'user',
      entity: null,
      action: 'ban',
      recommendation: 'm.ban',
      reason: null,
    },
    {
      key: 'user:b',
      kind: 'user',
      entity: '@legacy:example.org',
      action: 'ban',
      recommendation: 'org.matrix.mjolnir.ban',
      reason: null,
    },
    {
      key: 'room:e',
      kind: 'room',
      entity: '!room:example.org',
      action: null,
      recommendation: 'x.custom',
      reason: null,
    },
    {
      key: 'server:c',
      kind: 'server',
      entity: '*.evil.example',
      action: 'takedown',
      recommendation: 'org.matrix.msc4204.takedown',
      reason: null,
    },
  ]);
});

test('a removed stable rule hides the older copy, as it does for Meowlnir', () => {
  const rules = parsePolicyRules([
    rule('m.policy.rule.user', 'a', {}),
    rule('m.room.rule.user', 'a', { entity: '@old:example.org', recommendation: 'm.ban' }),
  ]);
  expect(rules).toEqual([]);
});

test('filters by who is named or why', () => {
  const rules = parsePolicyRules(events);
  expect(filterPolicyRules(rules, 'EVIL').map((entry) => entry.key)).toEqual(['server:c']);
  expect(filterPolicyRules(rules, 'spam').map((entry) => entry.key)).toEqual(['user:a']);
  expect(filterPolicyRules(rules, '  ')).toHaveLength(5);
});

test('sorts an entity the way Meowlnir does', () => {
  expect(policyKindOf('@spam:example.org')).toBe('user');
  expect(policyKindOf('@*:evil.example')).toBe('user');
  expect(policyKindOf('!room:example.org')).toBe('room');
  expect(policyKindOf('*.evil.example')).toBe('server');
  expect(policyKindOf('two words')).toBeNull();
  expect(policyKindOf('')).toBeNull();
});
