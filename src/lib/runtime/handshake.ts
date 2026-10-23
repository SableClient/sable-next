import { WIRE_SCHEMA, type Handshake } from '#src/generated/protocol';

/** Why a UI and the runtime it reached cannot talk. The shell reloads the page or restarts its worker. */
export type WireMismatch =
  | { kind: 'schema'; expected: string; actual: string }
  | { kind: 'missing_slices'; missing: string[] };

/**
 * Checks the runtime's handshake against the types this UI was built with and
 * the slices it needs. The versions are locked: a schema that differs is never
 * worked around.
 */
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
