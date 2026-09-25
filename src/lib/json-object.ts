export function parseJsonObject(text: string): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    console.log(text);
    parsed = JSON.parse(text);
  } catch {
    console.log('faile');
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  return parsed as Record<string, unknown>;
}
