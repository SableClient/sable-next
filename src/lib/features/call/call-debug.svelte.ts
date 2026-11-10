import type { CallMode, CallModeReason } from '#src/generated/protocol';
import type { CallModePreference } from '#lib/settings/definitions.js';

export type CallDebug = {
  requested: CallModePreference;
  nativeForced: boolean;
  mode: CallMode;
  reason: CallModeReason | undefined;
  stickyAvailable: boolean | undefined;
  peerModes: CallMode[];
  transport: 'livekit-web' | 'livekit-multi' | 'native';
  backendCount: number;
  encrypted: boolean;
};

let current = $state.raw<CallDebug | null>(null);

export const callDebug = {
  get current() {
    return current;
  },
};

export function recordCallDebug(next: CallDebug | null): void {
  current = next;
}
