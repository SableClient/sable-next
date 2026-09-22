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
    const devices = (await navigator.mediaDevices.enumerateDevices())
      .filter((device) => device.deviceId !== '')
      .map((device) => ({
        deviceId: device.deviceId,
        kind: device.kind,
        label: device.label,
      }));
    return { devices, denied: devices.length > 0 && devices.every((d) => d.label === '') };
  } catch {
    return { devices: [], denied: true };
  }
}
