import type { OfferRule } from './offers';

export const MSC_LINK: OfferRule = {
  id: 'msc-link',
  pattern: /(?<![\p{L}\p{N}_])MSC(\d{1,5})(?![\p{L}\p{N}_])/giu,
  always: 'linkMscReferences',
  strings: {
    heading: 'composer.offerMscLink',
    once: 'composer.offerOnce',
    always: 'composer.offerAlways',
    alwaysHint: 'composer.offerAlwaysHint',
    enabled: 'composer.offerAlwaysEnabled',
  },
  apply: (match) => {
    const href = `https://msc.sable.moe/${match[1]}`;
    return { href, markdown: `[${match[0]}](${href})` };
  },
};

export const OFFER_RULES: readonly OfferRule[] = [MSC_LINK];

/** A link an offer made, which the plain body keeps as the typed text. */
export function isOfferLink(text: string, href: string): boolean {
  return OFFER_RULES.some((rule) =>
    [...text.matchAll(rule.pattern)].some(
      (match) => match[0] === text && rule.apply(match).href === href
    )
  );
}
