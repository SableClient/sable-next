import { isRecord } from '#lib/guards.js';

export type PolicyKind = 'user' | 'room' | 'server';
export type PolicyAction = 'ban' | 'takedown' | 'unban' | 'mute';

export interface PolicyRule {
  key: string;
  kind: PolicyKind;
  /** `null` when the list hides the entity behind a hash. */
  entity: string | null;
  action: PolicyAction | null;
  recommendation: string;
  reason: string | null;
}

/** Stable type first: when one rule exists under several types, Meowlnir follows the stable one. */
const RULE_TYPES: Record<PolicyKind, readonly string[]> = {
  user: ['m.policy.rule.user', 'm.room.rule.user', 'org.matrix.mjolnir.rule.user'],
  room: ['m.policy.rule.room', 'm.room.rule.room', 'org.matrix.mjolnir.rule.room'],
  server: ['m.policy.rule.server', 'm.room.rule.server', 'org.matrix.mjolnir.rule.server'],
};

const ACTIONS: Record<string, PolicyAction> = {
  'm.ban': 'ban',
  'org.matrix.mjolnir.ban': 'ban',
  'org.matrix.msc4204.takedown': 'takedown',
  'fi.mau.meowlnir.unban': 'unban',
  'fi.mau.meowlnir.mute': 'mute',
};

function text(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function hashed(content: Record<string, unknown>): boolean {
  const hashes = content['org.matrix.msc4205.hashes'];
  return isRecord(hashes) && text(hashes.sha256) !== null;
}

/** The rules a policy list holds, from its full room state. */
export function parsePolicyRules(events: readonly unknown[]): PolicyRule[] {
  const rules: PolicyRule[] = [];
  for (const kind of Object.keys(RULE_TYPES) as PolicyKind[]) {
    const seen = new Set<string>();
    for (const type of RULE_TYPES[kind]) {
      for (const event of events) {
        if (!isRecord(event) || event.type !== type || typeof event.state_key !== 'string')
          continue;
        if (seen.has(event.state_key)) continue;
        seen.add(event.state_key);
        const content = isRecord(event.content) ? event.content : {};
        const recommendation = text(content.recommendation);
        const entity = text(content.entity);
        if (recommendation === null || (entity === null && !hashed(content))) continue;
        rules.push({
          key: `${kind}:${event.state_key}`,
          kind,
          entity,
          action: ACTIONS[recommendation] ?? null,
          recommendation,
          reason: text(content.reason),
        });
      }
    }
  }
  return rules;
}

export function filterPolicyRules(rules: readonly PolicyRule[], query: string): PolicyRule[] {
  const needle = query.trim().toLocaleLowerCase();
  if (needle === '') return [...rules];
  return rules.filter((rule) =>
    [rule.entity, rule.reason].some((value) => value?.toLocaleLowerCase().includes(needle))
  );
}

/** How Meowlnir sorts an entity into a rule type, or `null` when it would refuse it. */
export function policyKindOf(entity: string): PolicyKind | null {
  const value = entity.trim();
  if (value === '' || /\s/.test(value)) return null;
  if (value.startsWith('@')) return 'user';
  if (value.startsWith('!')) return 'room';
  return /^[\w.*?:[\]-]+$/.test(value) ? 'server' : null;
}
