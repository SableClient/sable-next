import { WIRE_SCHEMA, type Handshake } from '#src/generated/protocol';

export type WireMismatch =
  | { kind: 'schema'; expected: string; actual: string }
  | { kind: 'missing_slices'; missing: string[] };

export class WireMismatchError extends Error {
  constructor(readonly mismatch: WireMismatch) {
    super(`The runtime does not match this UI: ${mismatch.kind}`);
    this.name = 'WireMismatchError';
  }
}

export function checkHandshake(
  handshake: Handshake,
  needed: readonly string[] = [],
  expected: string = WIRE_SCHEMA
): WireMismatch | null {
  if (handshake.schema !== expected) {
    return { kind: 'schema', expected, actual: handshake.schema };
  }
  const missing = needed.filter((slice) => !handshake.slices.includes(slice));
  return missing.length > 0 ? { kind: 'missing_slices', missing } : null;
}
