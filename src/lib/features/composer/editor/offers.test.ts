// @vitest-environment happy-dom

import type { Mark } from 'prosemirror-model';
import { EditorState, TextSelection } from 'prosemirror-state';
import { expect, test } from 'vitest';

import { MSC_LINK } from './offer-rules';
import { applyOffers, offerKey, offersPlugin, standingOffers } from './offers';
import { composerSchema } from './schema';
import { serializeComposer } from './serialize';

const { doc, paragraph } = composerSchema.nodes;
const { code } = composerSchema.marks;

function stateOf(text: string, caret = text.length, marks: readonly Mark[] = []) {
  const state = EditorState.create({
    doc: doc.create(null, paragraph.create(null, composerSchema.text(text, marks))),
    plugins: [offersPlugin({ rules: [MSC_LINK], enabled: () => false, markdown: () => false })],
  });
  return state.apply(state.tr.setSelection(TextSelection.create(state.doc, caret + 1)));
}

test('an MSC reference is offered only once a boundary is typed after it', () => {
  expect(offerKey.getState(stateOf('see MSC4444'))).toBeNull();
  expect(offerKey.getState(stateOf('see MSC4'))).toBeNull();
  expect(offerKey.getState(stateOf('see msc4444 '))?.text).toBe('msc4444');
  expect(offerKey.getState(stateOf('see MSC4444,'))?.text).toBe('MSC4444');
  expect(offerKey.getState(stateOf('see MSC4444, and'))).toBeNull();
  expect(offerKey.getState(stateOf('see xMSC4444'))).toBeNull();
  expect(offerKey.getState(stateOf('see MSC444444'))).toBeNull();
  expect(offerKey.getState(stateOf('MSC4444 ', 8, [code.create()]))).toBeNull();
});

test('an accepted offer links in rich text and writes markdown in plain mode', () => {
  const state = stateOf('see MSC4444 ');
  const offer = offerKey.getState(state);
  if (!offer) throw new Error('no offer');

  const rich = state.apply(applyOffers(state, [offer], false));
  expect(serializeComposer(rich.doc)).toMatchObject({
    body: 'see MSC4444',
    formatted: 'see <a href="https://msc.sable.moe/4444">MSC4444</a>',
  });

  const plain = state.apply(applyOffers(state, [offer], true));
  expect(plain.doc.textContent).toBe('see [MSC4444](https://msc.sable.moe/4444) ');
});

test('always-on offers link references the caret never left, once each', () => {
  const state = stateOf('see MSC1 and MSC4444');
  const offers = standingOffers(state, [MSC_LINK], () => true);
  expect(offers.map((offer) => offer.text)).toEqual(['MSC1', 'MSC4444']);
  expect(standingOffers(state, [MSC_LINK], () => false)).toEqual([]);

  const plain = state.apply(applyOffers(state, offers, true));
  expect(plain.doc.textContent).toBe(
    'see [MSC1](https://msc.sable.moe/1) and [MSC4444](https://msc.sable.moe/4444)'
  );
  expect(standingOffers(plain, [MSC_LINK], () => true)).toEqual([]);
});
