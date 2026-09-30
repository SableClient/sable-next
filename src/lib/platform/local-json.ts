function optionalStorage(): Storage | null {
  return typeof localStorage === 'undefined' ? null : localStorage;
}

export function readJson<T>(key: string, parse: (value: unknown) => T, fallback: T): T {
  try {
    const raw = readText(key);
    return raw === null ? fallback : parse(JSON.parse(raw));
  } catch {
    return fallback;
  }
}

export function readText(key: string): string | null {
  try {
    return optionalStorage()?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

export function writeText(key: string, value: string): void {
  try {
    optionalStorage()?.setItem(key, value);
  } catch {
    // Preferences are optional; session credentials use the core store.
  }
}

export function removeLocalValue(key: string): void {
  try {
    optionalStorage()?.removeItem(key);
  } catch {
    // Ignore unavailable preference storage.
  }
}

export function writeJson(key: string, value: unknown, failure?: string): void {
  try {
    optionalStorage()?.setItem(key, JSON.stringify(value));
  } catch (error) {
    if (failure !== undefined) console.debug(failure, error);
  }
}
