export type Fix = { latitude: number; longitude: number };

export type FixResult =
  | { kind: 'fix'; fix: Fix }
  | { kind: 'denied' }
  | { kind: 'unavailable' }
  | { kind: 'unsupported' };

export function locates(): boolean {
  return typeof navigator !== 'undefined' && 'geolocation' in navigator;
}

export function currentFix(timeoutMs = 10_000): Promise<FixResult> {
  if (!locates()) return Promise.resolve({ kind: 'unsupported' });

  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => {
        resolve({ kind: 'fix', fix: { latitude: coords.latitude, longitude: coords.longitude } });
      },
      (error) => {
        resolve({ kind: error.code === error.PERMISSION_DENIED ? 'denied' : 'unavailable' });
      },
      { timeout: timeoutMs, enableHighAccuracy: false }
    );
  });
}
