import type { CommandErr } from '#src/generated/CommandErr';

export function commandErrorCode(cause: unknown): CommandErr['code'] | null {
  if (!(cause instanceof Error) || !('detail' in cause)) return null;
  const detail = (cause as { detail: unknown }).detail;
  if (typeof detail !== 'object' || detail === null || !('code' in detail)) return null;
  return (detail as CommandErr).code;
}
