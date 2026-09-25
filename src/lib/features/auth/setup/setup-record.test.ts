// @vitest-environment happy-dom

import { afterEach, describe, expect, test, vi } from 'vitest';

import type { CoreClient } from '#lib/core/client.svelte.js';

import {
  accountFinishedFrom,
  hasPendingSetup,
  markAccountFinished,
  ONBOARDING_ACCOUNT_DATA_TYPE,
  pendingStep,
  readSetupRecord,
  restartSetup,
  setupRecordKey,
  writeSetupRecord,
  type SetupRecord,
} from './setup-record';

const record = (overrides: Partial<SetupRecord> = {}): SetupRecord => ({
  full: true,
  registering: false,
  homeserver: '',
  steps: ['device', 'recovery'],
  finished: [],
  ...overrides,
});

afterEach(() => {
  localStorage.clear();
});

describe('the device record', () => {
  test('is keyed by account and device, so another device starts its own', () => {
    writeSetupRecord(localStorage, setupRecordKey('@a:x', 'ONE'), record());
    expect(hasPendingSetup(localStorage, '@a:x', 'ONE')).toBe(true);
    expect(hasPendingSetup(localStorage, '@a:x', 'TWO')).toBe(false);
  });

  test('resumes at the first step that is not finished', () => {
    expect(pendingStep(record({ finished: ['device'] }))).toBe('recovery');
    expect(pendingStep(record({ finished: ['device', 'recovery'] }))).toBeNull();
  });

  test('a finished record is not pending', () => {
    writeSetupRecord(
      localStorage,
      setupRecordKey('@a:x', 'ONE'),
      record({ finished: ['device', 'recovery'] })
    );
    expect(hasPendingSetup(localStorage, '@a:x', 'ONE')).toBe(false);
  });

  test('an unreadable or unknown record is ignored rather than trusted', () => {
    localStorage.setItem('k', '{not json');
    expect(readSetupRecord(localStorage, 'k')).toBeNull();
    localStorage.setItem('k', JSON.stringify({ ...record(), steps: ['device', 'teleport'] }));
    expect(readSetupRecord(localStorage, 'k')).toBeNull();
  });
});

describe('account progress', () => {
  test('reads only the steps this version knows', () => {
    expect(accountFinishedFrom({ finished: ['profile', 'future-step', 3] })).toEqual(['profile']);
    expect(accountFinishedFrom(null)).toEqual([]);
  });

  test('a write keeps what another version or device already stored', async () => {
    const setAccountData = vi.fn(() => Promise.resolve());
    const core = {
      commands: {
        accountData: vi.fn(() => Promise.resolve({ finished: ['future-step'], extra: 1 })),
        setAccountData,
      },
    } as unknown as CoreClient;

    await markAccountFinished(core, 'recovery');

    expect(setAccountData).toHaveBeenCalledWith(ONBOARDING_ACCOUNT_DATA_TYPE, {
      extra: 1,
      finished: ['future-step', 'recovery'],
    });
  });

  test('a step already stored is not written again', async () => {
    const setAccountData = vi.fn(() => Promise.resolve());
    const core = {
      commands: {
        accountData: vi.fn(() => Promise.resolve({ finished: ['recovery'] })),
        setAccountData,
      },
    } as unknown as CoreClient;

    await markAccountFinished(core, 'recovery');

    expect(setAccountData).not.toHaveBeenCalled();
  });
});

describe('running setup again', () => {
  test('forgets the account steps, keeps unknown fields and starts a full run here', async () => {
    const setAccountData = vi.fn(() => Promise.resolve());
    const core = {
      commands: {
        accountData: vi.fn(() => Promise.resolve({ finished: ['notifications'], extra: 1 })),
        setAccountData,
      },
    } as unknown as CoreClient;

    await restartSetup(core, localStorage, '@a:x', 'ONE');

    expect(setAccountData).toHaveBeenCalledWith(ONBOARDING_ACCOUNT_DATA_TYPE, {
      extra: 1,
      finished: [],
    });
    expect(readSetupRecord(localStorage, setupRecordKey('@a:x', 'ONE'))).toMatchObject({
      full: true,
      registering: true,
      finished: [],
    });
  });
});
