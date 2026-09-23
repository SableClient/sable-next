export function readJson<T>(key: string, parse: (value: unknown) => T, fallback: T): T {
  if (typeof localStorage === 'undefined') return fallback;

  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : parse(JSON.parse(raw));
  } catch {
    return fallback;
  }
}

export function writeJson(key: string, value: unknown, failure?: string): void {
  if (typeof localStorage === 'undefined') return;

  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (error) {
    if (failure !== undefined) console.debug(failure, error);
  }
}
