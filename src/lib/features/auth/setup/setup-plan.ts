import type { RecoveryStateView, VerificationStateView } from '#src/generated/protocol';

export type SetupStep =
  | 'device'
  | 'recovery'
  | 'profile'
  | 'notifications'
  | 'sync'
  | 'consent'
  | 'done';
export type AccountStep = Extract<SetupStep, 'recovery' | 'profile' | 'notifications'>;

export const ACCOUNT_STEPS: readonly AccountStep[] = ['recovery', 'profile', 'notifications'];

export interface SetupState {
  registering: boolean;
  verification: VerificationStateView;
  recovery: RecoveryStateView;
  newRecoveryKey: boolean;
  accountFinished: readonly AccountStep[];
  permissionAskable: boolean;
  syncEnabled: boolean;
  consentPending: boolean;
}

export function isAccountStep(step: SetupStep): step is AccountStep {
  return (ACCOUNT_STEPS as readonly SetupStep[]).includes(step);
}

export function encryptionKnown(state: Pick<SetupState, 'verification' | 'recovery'>): boolean {
  return state.verification !== 'unknown' && state.recovery !== 'unknown';
}

export function setupNeeded(state: SetupState): boolean {
  return state.registering || state.verification === 'unverified' || state.recovery === 'disabled';
}

function recoveryWanted(state: SetupState): boolean {
  if (state.newRecoveryKey) return true;
  return state.recovery === 'disabled' && !state.accountFinished.includes('recovery');
}

export function planSetup(state: SetupState, full: boolean): SetupStep[] {
  const steps: SetupStep[] = [];
  if (full) {
    if (state.verification === 'unverified') steps.push('device');
    if (recoveryWanted(state)) steps.push('recovery');
    if (state.registering && !state.accountFinished.includes('profile')) steps.push('profile');
    if (!state.accountFinished.includes('notifications') || state.permissionAskable) {
      steps.push('notifications');
    }
    if (!state.syncEnabled) steps.push('sync');
  }
  if (state.consentPending) steps.push('consent');
  if (full) steps.push('done');
  return steps;
}

export function replan(
  finished: readonly SetupStep[],
  state: SetupState,
  full: boolean
): SetupStep[] {
  return [...finished, ...planSetup(state, full).filter((step) => !finished.includes(step))];
}
