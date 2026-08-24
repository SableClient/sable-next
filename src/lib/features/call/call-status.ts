import type { CallFailure, CallLifecycle } from './call-session.svelte.js';
import type { CallTransportConnection } from './call-transport';

const lifecycleKeys: Record<CallLifecycle, string> = {
  idle: 'call.title',
  joining: 'call.joining',
  connecting: 'call.connecting',
  active: 'call.active',
  leaving: 'call.leaving',
  failed: 'call.title',
};

const failureKeys: Record<CallFailure, string> = {
  busy: 'call.errorBusy',
  'no-focus': 'call.errorNoFocus',
  'e2ee-unsupported': 'call.errorE2eeUnsupported',
  'e2ee-failed': 'call.errorE2eeFailed',
  'setup-failed': 'call.errorSetupFailed',
};

export function callStatusKey(status: {
  lifecycle: CallLifecycle;
  connection: CallTransportConnection;
  mediaReady: boolean;
}): string {
  if (status.lifecycle === 'active' && status.connection === 'reconnecting') {
    return 'call.reconnecting';
  }
  if (status.lifecycle === 'connecting' && !status.mediaReady) return 'call.securing';
  return lifecycleKeys[status.lifecycle];
}

export const callFailureKey = (failure: CallFailure): string => failureKeys[failure];
