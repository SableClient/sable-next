import type { JoinAddress } from '#src/generated/protocol';

import { parseJoinAddress as parseAddress } from '#lib/model/model.js';

import { matrixLinkHost } from './matrix-link.js';

export type { JoinAddress };
export { splitVia } from '#lib/model/model.js';

export function parseJoinAddress(input: string): JoinAddress | null {
  return parseAddress(input, matrixLinkHost());
}
