import { Fragment, Slice } from 'prosemirror-model';
import { expect, onTestFinished, test } from 'vitest';

import { preferences } from '#lib/settings/preferences.svelte.js';

import { withPastedMentions } from './pasted-mentions';
import { composerSchema } from './schema';

function pasted(text: string): Slice {
  const paragraph = composerSchema.node('paragraph', null, [composerSchema.text(text)]);
  return new Slice(Fragment.from(paragraph), 0, 0);
}

test('a pasted link on the custom link host becomes a mention', () => {
  preferences.matrixLinkSelector = 'custom';
  preferences.matrixLinkCustom = 'links.example.org';
  onTestFinished(() => {
    preferences.matrixLinkSelector = 'sable';
    preferences.matrixLinkCustom = '';
  });

  const slice = withPastedMentions(
    pasted('ping https://links.example.org/#/@alice:example.org'),
    () => null
  );

  const mention = slice.content.firstChild?.lastChild;
  expect(mention?.type).toBe(composerSchema.nodes.mention);
  expect(mention?.attrs.userId).toBe('@alice:example.org');
});
