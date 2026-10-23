import { describe, expect, it } from 'vitest';

import { WIRE_SCHEMA } from '#src/generated/protocol';
import type { AppEvent, Batch, Handshake, Subscribed } from '#src/generated/protocol';
import forms from '../../../tests/fixtures/wire/forms.json';
import { checkHandshake } from './handshake';

describe('checkHandshake', () => {
  const handshake: Handshake = { schema: WIRE_SCHEMA, slices: ['bookmarks', 'timeline'] };

  it('accepts a runtime built from the same source', () => {
    expect(checkHandshake(handshake, ['timeline'])).toBeNull();
  });

  it('names a schema that differs', () => {
    expect(checkHandshake({ ...handshake, schema: 'ffffffffffffffff' })).toEqual({
      kind: 'schema',
      expected: WIRE_SCHEMA,
      actual: 'ffffffffffffffff',
    });
  });

  it('lists the slices the runtime lacks', () => {
    expect(checkHandshake(handshake, ['timeline', 'calls', 'polls'])).toEqual({
      kind: 'missing_slices',
      missing: ['calls', 'polls'],
    });
  });

  it('reports the schema before the slices', () => {
    expect(checkHandshake(handshake, ['calls'], '0000000000000000')?.kind).toBe('schema');
  });
});

describe('the wire fixture', () => {
  it('holds the forms the generated types describe', () => {
    const subscribed: Subscribed = forms.subscribed;
    const handshake: Handshake = forms.handshake;
    const batches: Batch[] = [
      forms.patch as Batch,
      forms.document_patch as Batch,
      forms.reply_ok as Batch,
      forms.reply_rpc_error as Batch,
      forms.reply_lost as Batch,
      forms.notice as Batch,
      forms.resync as Batch,
    ];
    const types = batches.flatMap((batch) => batch.events.map((event: AppEvent) => event.type));

    expect(subscribed.snapshot.epoch).toBe(0);
    expect(handshake.slices).toEqual(['bookmarks', 'timeline']);
    expect(types).toEqual(['patch', 'patch', 'reply', 'reply', 'reply', 'notice', 'resync']);
    expect(batches.map((batch) => batch.tick)).toEqual([4, 5, 6, 7, 8, 9, 10]);
  });
});
