import { describe, expect, test } from 'vitest';

import { encryptionKnown, planSetup, replan, setupNeeded, type SetupState } from './setup-plan';

const state = (overrides: Partial<SetupState> = {}): SetupState => ({
  registering: false,
  verification: 'verified',
  recovery: 'enabled',
  newRecoveryKey: false,
  accountFinished: ['notifications'],
  permissionAskable: false,
  syncEnabled: true,
  consentPending: false,
  ...overrides,
});

describe('setupNeeded', () => {
  test('a verified login on an account with recovery needs nothing', () => {
    expect(setupNeeded(state())).toBe(false);
  });

  test('registration, an unverified device and a missing recovery each start it', () => {
    expect(setupNeeded(state({ registering: true }))).toBe(true);
    expect(setupNeeded(state({ verification: 'unverified' }))).toBe(true);
    expect(setupNeeded(state({ recovery: 'disabled' }))).toBe(true);
  });

  test('an incomplete recovery is the banner’s, not the flow’s', () => {
    expect(setupNeeded(state({ recovery: 'incomplete' }))).toBe(false);
  });
});

describe('encryptionKnown', () => {
  test('waits for both halves of the status', () => {
    expect(encryptionKnown({ verification: 'unverified', recovery: 'unknown' })).toBe(false);
    expect(encryptionKnown({ verification: 'unknown', recovery: 'enabled' })).toBe(false);
    expect(encryptionKnown({ verification: 'unverified', recovery: 'enabled' })).toBe(true);
  });
});

describe('planSetup', () => {
  test('an unverified login confirms the device and nothing it does not need', () => {
    expect(planSetup(state({ verification: 'unverified' }), true)).toEqual(['device']);
  });

  test('a new account creates recovery and a profile', () => {
    expect(planSetup(state({ registering: true, recovery: 'disabled' }), true)).toEqual([
      'recovery',
      'profile',
    ]);
  });

  test('a second device skips the account steps another device finished', () => {
    const plan = planSetup(
      state({
        verification: 'unverified',
        recovery: 'disabled',
        registering: true,
        accountFinished: ['recovery', 'profile', 'notifications'],
      }),
      true
    );
    expect(plan).toEqual(['device']);
  });

  test('a key from an identity reset is shown even when the account finished recovery', () => {
    const plan = planSetup(
      state({
        recovery: 'enabled',
        newRecoveryKey: true,
        accountFinished: ['recovery', 'notifications'],
      }),
      true
    );
    expect(plan).toEqual(['recovery']);
  });

  test('a login that needs no setup still asks for consent, and only that', () => {
    expect(planSetup(state({ consentPending: true }), false)).toEqual(['consent']);
    expect(planSetup(state({ verification: 'unverified' }), false)).toEqual([]);
  });
});

describe('the notifications step', () => {
  test('asks an account that never chose its group default', () => {
    expect(planSetup(state({ verification: 'unverified', accountFinished: [] }), true)).toEqual([
      'device',
      'notifications',
    ]);
  });

  test('a second device still asks for its own permission once the account chose', () => {
    expect(planSetup(state({ verification: 'unverified', permissionAskable: true }), true)).toEqual(
      ['device', 'notifications']
    );
  });

  test('is skipped once the account chose and this device has nothing left to ask', () => {
    expect(planSetup(state({ verification: 'unverified' }), true)).toEqual(['device']);
  });
});

describe('the sync step', () => {
  test('is offered on every device that has not turned sync on', () => {
    expect(planSetup(state({ verification: 'unverified', syncEnabled: false }), true)).toEqual([
      'device',
      'sync',
    ]);
  });

  test('is not planned for a login that needed no setup', () => {
    expect(planSetup(state({ syncEnabled: false }), false)).toEqual([]);
  });
});

describe('replan', () => {
  test('keeps what is finished in place and drops a step the state no longer needs', () => {
    const next = replan(['device'], state({ verification: 'verified', recovery: 'enabled' }), true);
    expect(next).toEqual(['device']);
  });

  test('appends a step the state now needs after the finished ones', () => {
    const next = replan(['device'], state({ newRecoveryKey: true }), true);
    expect(next).toEqual(['device', 'recovery']);
  });
});
