import { Plugin, PluginKey, type EditorState, type Transaction } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';

import type { BooleanPreference } from '#lib/settings/registry.js';
import { composerSchema } from './schema';

/** A rewrite the composer offers for text the caret has just finished typing. */
export interface OfferRule {
  id: string;
  /** Must be global and anchored to its own word boundaries. */
  pattern: RegExp;
  always: BooleanPreference;
  /** i18n keys: the heading takes `{{text}}`, the match. */
  strings: { heading: string; once: string; always: string; alwaysHint: string; enabled: string };
  apply: (match: RegExpExecArray) => { href: string; markdown: string };
}

export interface ComposerOffer {
  rule: OfferRule;
  text: string;
  from: number;
  to: number;
  match: RegExpExecArray;
}

export const offerKey = new PluginKey<ComposerOffer | null>('composer-offer');

const { link, code } = composerSchema.marks;

function matches(state: EditorState, rule: OfferRule, from: number, to: number) {
  const found: ComposerOffer[] = [];
  state.doc.nodesBetween(from, to, (node, position) => {
    if (!node.isTextblock) return true;
    if (node.type.spec.code) return false;
    const start = position + 1;
    const text = node.textBetween(0, node.content.size, '\n', '￼');
    for (const match of text.matchAll(rule.pattern)) {
      const at = start + match.index;
      const end = at + match[0].length;
      const marks = state.doc.resolve(at + 1).marks();
      if (link.isInSet(marks) || code.isInSet(marks)) continue;
      found.push({ rule, text: match[0], from: at, to: end, match });
    }
    return false;
  });
  return found;
}

/** The match the caret has just left by typing a boundary, so Enter still sends. */
function offerAt(state: EditorState, rules: readonly OfferRule[]): ComposerOffer | null {
  const { $from, empty } = state.selection;
  if (!empty || !$from.parent.isTextblock || $from.parent.type.spec.code) return null;
  const caret = $from.pos;
  const block = $from.start();
  for (const rule of rules) {
    const hit = matches(state, rule, block, caret).find((offer) => offer.to === caret - 1);
    if (hit && /^[\s.,;:!?)]$/u.test(state.doc.textBetween(hit.to, caret))) return hit;
  }
  return null;
}

export function applyOffers(
  state: EditorState,
  offers: readonly ComposerOffer[],
  markdown: boolean
): Transaction {
  const tr = state.tr;
  for (const offer of [...offers].sort((left, right) => right.from - left.from)) {
    const { href, markdown: source } = offer.rule.apply(offer.match);
    if (markdown) tr.insertText(source, offer.from, offer.to);
    else tr.addMark(offer.from, offer.to, link.create({ href }));
  }
  return tr;
}

interface OfferOptions {
  rules: readonly OfferRule[];
  enabled: (rule: OfferRule) => boolean;
  markdown: () => boolean;
}

export function offersPlugin({ rules, enabled, markdown }: OfferOptions): Plugin {
  const applyAlways = (view: EditorView) => {
    if (view.composing) return;
    const offer = offerKey.getState(view.state);
    if (!offer || !enabled(offer.rule)) return;
    view.dispatch(applyOffers(view.state, [offer], markdown()));
  };

  return new Plugin<ComposerOffer | null>({
    key: offerKey,
    state: {
      init: (_config, state) => offerAt(state, rules),
      apply: (tr, value, _old, state) =>
        tr.docChanged || tr.selectionSet ? offerAt(state, rules) : value,
    },
    view: () => ({ update: applyAlways }),
  });
}
