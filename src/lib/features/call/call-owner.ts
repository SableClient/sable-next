export type CallOwnerKind = 'livekit-js' | 'livekit-native';

export type CallOwnerLease = {
  kind: CallOwnerKind;
  roomId: string;
  release: () => void;
};

let active: CallOwnerLease | undefined;

export function acquireCallOwner(kind: CallOwnerKind, roomId: string): CallOwnerLease | undefined {
  if (active) return undefined;

  let released = false;
  const lease: CallOwnerLease = {
    kind,
    roomId,
    release: () => {
      if (released || active !== lease) return;
      released = true;
      active = undefined;
    },
  };
  active = lease;
  return lease;
}

export const activeCallOwner = (): Pick<CallOwnerLease, 'kind' | 'roomId'> | undefined => active;

export function resetCallOwner(): void {
  active = undefined;
}
