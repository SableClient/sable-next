import type { CoreClient } from '#lib/core/client.svelte.js';

import { ACCOUNT_STEPS, type AccountStep, type SetupStep } from './setup-plan';

export const ONBOARDING_ACCOUNT_DATA_TYPE = 'moe.sable.next.onboarding';

const STEPS: readonly SetupStep[] = [
  'device',
  'recovery',
  'profile',
  'notifications',
  'appearance',
  'sync',
  'consent',
  'done',
];

export interface SetupRecord {
  full: boolean;
  registering: boolean;
  homeserver: string;
  steps: SetupStep[];
  finished: SetupStep[];
}

export function setupRecordKey(userId: string, deviceId: string): string {
  return `sable-setup:${userId}:${deviceId}`;
}

function stepList(value: unknown): SetupStep[] | null {
  if (!Array.isArray(value)) return null;
  const steps = value.filter((step): step is SetupStep => STEPS.includes(step as SetupStep));
  return steps.length === value.length ? steps : null;
}

export function readSetupRecord(storage: Storage, key: string): SetupRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(storage.getItem(key) ?? 'null');
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  const steps = stepList(record.steps);
  const finished = stepList(record.finished);
  if (!steps || !finished) return null;
  return {
    full: record.full === true,
    registering: record.registering === true,
    homeserver: typeof record.homeserver === 'string' ? record.homeserver : '',
    steps,
    finished,
  };
}

export function writeSetupRecord(storage: Storage, key: string, record: SetupRecord): void {
  storage.setItem(key, JSON.stringify(record));
}

export function pendingStep(record: SetupRecord): SetupStep | null {
  return record.steps.find((step) => !record.finished.includes(step)) ?? null;
}

function finishedNames(content: unknown): string[] {
  if (typeof content !== 'object' || content === null) return [];
  const finished = (content as { finished?: unknown }).finished;
  if (!Array.isArray(finished)) return [];
  return finished.filter((step): step is string => typeof step === 'string');
}

export function hasPendingSetup(storage: Storage, userId: string, deviceId: string): boolean {
  const record = readSetupRecord(storage, setupRecordKey(userId, deviceId));
  return record !== null && pendingStep(record) !== null;
}

export function accountFinishedFrom(content: unknown): AccountStep[] {
  const finished = finishedNames(content);
  return ACCOUNT_STEPS.filter((step) => finished.includes(step));
}

export async function readAccountFinished(core: CoreClient): Promise<AccountStep[]> {
  return accountFinishedFrom(await core.commands.accountData(ONBOARDING_ACCOUNT_DATA_TYPE));
}

export async function markAccountFinished(core: CoreClient, step: AccountStep): Promise<void> {
  const content = await core.commands.accountData(ONBOARDING_ACCOUNT_DATA_TYPE);
  const finished = finishedNames(content);
  if (finished.includes(step)) return;
  const base = typeof content === 'object' && content !== null ? content : {};
  await core.commands.setAccountData(ONBOARDING_ACCOUNT_DATA_TYPE, {
    ...base,
    finished: [...finished, step],
  });
}

export async function restartSetup(
  core: CoreClient,
  storage: Storage,
  userId: string,
  deviceId: string
): Promise<void> {
  const content = await core.commands.accountData(ONBOARDING_ACCOUNT_DATA_TYPE);
  const base = typeof content === 'object' && content !== null ? content : {};
  await core.commands.setAccountData(ONBOARDING_ACCOUNT_DATA_TYPE, { ...base, finished: [] });
  writeSetupRecord(storage, setupRecordKey(userId, deviceId), {
    full: true,
    registering: true,
    homeserver: '',
    steps: [],
    finished: [],
  });
}
