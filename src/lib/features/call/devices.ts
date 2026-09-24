export type CallDevice = {
  deviceId: string;
  kind: MediaDeviceKind;
  label: string;
};

export function supportsDeviceSelection(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    typeof (navigator.mediaDevices as MediaDevices | undefined)?.enumerateDevices === 'function'
  );
}

export async function listCallDevices(): Promise<{ devices: CallDevice[]; denied: boolean }> {
  if (!supportsDeviceSelection()) return { devices: [], denied: false };
  try {
    const all = await navigator.mediaDevices.enumerateDevices();
    const devices = all
      .filter((device) => device.deviceId !== '')
      .map((device) => ({
        deviceId: device.deviceId,
        kind: device.kind,
        label: device.label,
      }));
    return { devices, denied: all.some((device) => device.label === '') };
  } catch {
    return { devices: [], denied: true };
  }
}

export async function unlockCallDevices(): Promise<void> {
  const stream = await navigator.mediaDevices
    .getUserMedia({ audio: true, video: true })
    .catch(() => navigator.mediaDevices.getUserMedia({ audio: true }))
    .catch(() => null);
  for (const track of stream?.getTracks() ?? []) track.stop();
}
