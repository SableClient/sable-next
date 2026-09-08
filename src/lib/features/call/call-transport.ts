export type CallEncryptionKey = {
  backendId?: string;
  identity: string;
  keyIndex: number;
  key: Uint8Array<ArrayBuffer>;
};

export type CallTrack = {
  id: string;
  muted: boolean;
  subscribed: boolean;
};

export type CallConnectionQuality = 'lost' | 'poor' | 'good' | 'excellent' | 'unknown';

export type CallParticipant = {
  backendId?: string;
  identity: string;
  camera?: CallTrack;
  screenShare?: CallTrack;
  microphone?: CallTrack;
  connectionQuality?: CallConnectionQuality;
};

export type CallTransportConnection = 'connecting' | 'connected' | 'reconnecting' | 'disconnected';

export type CallTransportState = {
  connection: CallTransportConnection;
  participants: CallParticipant[];
  microphoneEnabled: boolean;
  cameraEnabled: boolean;
  screenShareEnabled: boolean;
  error?: string;
};

export type CallTransportConnectOptions = {
  url: string;
  token: string;
  microphoneEnabled: boolean;
  cameraEnabled: boolean;
  encryptionKeys: CallEncryptionKey[];
  publisherId?: string;
  backends?: CallBackendGrant[];
};

export type CallBackendGrant = { id: string; url: string; jwt: string; identity: string };
export type CallTransportRoom = { backendId: string; room: import('livekit-client').Room };

export type CallAudioRoute = {
  id: string;
  name: string;
  type: string;
  current: boolean;
};

export type CallTransportCapabilities = {
  camera?: { switch: () => Promise<void> };
  audioRoutes?: {
    list: () => Promise<CallAudioRoute[]>;
    select: (routeId: string) => Promise<void>;
  };
  screenShare?: { setEnabled: (enabled: boolean) => Promise<void> };
};

export type CallTransport = {
  connect: (options: CallTransportConnectOptions) => Promise<void>;
  disconnect: () => Promise<void>;
  setMicrophoneEnabled: (enabled: boolean) => Promise<void>;
  setCameraEnabled: (enabled: boolean) => Promise<void>;
  setEncryptionKey: (key: CallEncryptionKey, backendId?: string) => Promise<void>;
  subscribe: (listener: (state: CallTransportState) => void) => () => void;
  getState: () => CallTransportState;
  capabilities: CallTransportCapabilities;
  reconcileBackends?: (backends: CallBackendGrant[]) => Promise<void>;
  rooms?: () => readonly CallTransportRoom[];
  roomFor?: (backendId: string | undefined) => import('livekit-client').Room | undefined;
};

export const ignoreError = (): void => undefined;

export const idleTransportState = (): CallTransportState => ({
  connection: 'disconnected',
  participants: [],
  microphoneEnabled: false,
  cameraEnabled: false,
  screenShareEnabled: false,
});

export function decodeCallKey(encoded: string): Uint8Array<ArrayBuffer> | null {
  try {
    const binary = atob(encoded);
    const key = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) key[index] = binary.charCodeAt(index);
    return key.length > 0 ? key : null;
  } catch {
    return null;
  }
}
