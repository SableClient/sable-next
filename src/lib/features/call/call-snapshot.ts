import { callDebug } from './call-debug.svelte.js';
import type { CallSession } from './call-session.svelte.js';
import { averageBitrate, readVideoStats } from './call-stats';
import { safeCallCode } from './call-telemetry';
import { listCallDevices, supportsDeviceSelection } from './devices';

const BITRATE_SAMPLE_MS = 500;

async function videoStats(rooms: CallSession['rooms']) {
  const tracks = rooms.flatMap(({ room }) =>
    [room.localParticipant, ...room.remoteParticipants.values()].flatMap((participant) =>
      [...participant.trackPublications.values()].flatMap((publication) =>
        publication.videoTrack
          ? [
              {
                track: publication.videoTrack,
                source: publication.source,
                local: participant === room.localParticipant,
              },
            ]
          : []
      )
    )
  );
  if (tracks.length === 0) return [];

  const read = () =>
    Promise.all(
      tracks.map(({ track }) =>
        track
          .getRTCStatsReport()
          .then((report) => report && readVideoStats(report))
          .catch(() => undefined)
      )
    );
  const first = await read();
  await new Promise((resolve) => setTimeout(resolve, BITRATE_SAMPLE_MS));
  const second = await read();

  return tracks.flatMap(({ source, local }, index) => {
    const before = first[index];
    const after = second[index];
    if (!after) return [];
    return [
      {
        source,
        local,
        ...after.stats,
        bitrate: before ? averageBitrate([before.sample, after.sample]) : undefined,
      },
    ];
  });
}

async function deviceSummary(lastError: string | null) {
  if (!supportsDeviceSelection()) return undefined;
  const { devices, denied } = await listCallDevices();
  const count = (kind: MediaDeviceKind) => devices.filter((device) => device.kind === kind).length;
  let microphonePermission: PermissionState | 'unknown';
  try {
    microphonePermission = (await navigator.permissions.query({ name: 'microphone' })).state;
  } catch {
    microphonePermission = 'unknown';
  }
  return {
    audioinput: count('audioinput'),
    audiooutput: count('audiooutput'),
    videoinput: count('videoinput'),
    labelled: !denied,
    microphonePermission,
    lastError,
  };
}

// Counts and enums only. Identities, user ids, backend ids and raw error text stay out,
// since the snapshot leaves the device with a bug report.
export async function collectCallSnapshot(session: CallSession) {
  const { transport } = session;
  const quality: Record<string, number> = {};
  for (const participant of [
    ...(transport.self ? [transport.self] : []),
    ...transport.participants,
  ]) {
    const level = participant.connectionQuality ?? 'unknown';
    quality[level] = (quality[level] ?? 0) + 1;
  }

  return {
    capturedAt: new Date().toISOString(),
    attemptId: session.telemetry?.attemptId,
    lifecycle: session.lifecycle,
    failure: session.failure,
    connection: transport.connection,
    disconnectReason: transport.disconnectReason,
    errorCode: transport.errorCode === undefined ? undefined : safeCallCode(transport.errorCode),
    mediaReady: session.mediaReady,
    encrypted: session.encryptsMedia,
    listenOnly: session.listenOnly,
    deviceError: session.deviceError,
    inputMode: session.inputMode,
    microphone: session.microphoneEnabled,
    camera: transport.cameraEnabled,
    screenShare: transport.screenShareEnabled,
    deafened: session.deafened,
    connectedSeconds:
      session.connectedAt === null
        ? undefined
        : Math.round((Date.now() - session.connectedAt) / 1000),
    members: session.members.length,
    participants: transport.participants.length,
    unreachableBackends: transport.unreachableBackends?.length ?? 0,
    quality,
    mode: callDebug.current,
    devices: await deviceSummary(session.deviceErrorName),
    video: await videoStats(session.rooms),
  };
}

export type CallSnapshot = Awaited<ReturnType<typeof collectCallSnapshot>>;

let held: CallSnapshot | undefined;

export function holdCallSnapshot(snapshot: CallSnapshot): void {
  held = snapshot;
}

export function takeCallSnapshot(): CallSnapshot | undefined {
  const snapshot = held;
  held = undefined;
  return snapshot;
}
