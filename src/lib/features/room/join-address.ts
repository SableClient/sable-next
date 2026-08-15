import { parseMatrixLink } from './matrix-link';

export type JoinAddress = { address: string; via: string[] };

const idOrAlias = /^[!#][^:\s?]+:[^\s?]+$/;

/**
 * matrix.to carries `?via=` inside the fragment, where neither `URL.searchParams`
 * nor `parseMatrixLink` will look at it. Splitting it off first also keeps the
 * query out of the room id the parser would otherwise return.
 */
function splitVia(href: string): { href: string; via: string[] } {
  const hash = href.indexOf('#');
  const query = href.indexOf('?', hash === -1 ? 0 : hash);
  if (query === -1) return { href, via: [] };

  const via = new URLSearchParams(href.slice(query + 1))
    .getAll('via')
    .filter((server) => server !== '');
  return { href: href.slice(0, query), via: [...new Set(via)] };
}

/** `null` when the input is neither a room address nor a link naming one. */
export function parseJoinAddress(input: string): JoinAddress | null {
  const trimmed = input.trim();
  if (trimmed === '') return null;
  if (idOrAlias.test(trimmed)) return { address: trimmed, via: [] };

  const { href, via } = splitVia(trimmed);
  const link = parseMatrixLink(href);
  if (link === null || link.kind === 'user') return null;
  return { address: link.roomId, via };
}
