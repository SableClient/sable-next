import { describe, expect, it } from 'vitest';

import {
  preferredPronouns,
  pronounPillLimit,
  splitDisplayNamePronouns,
  visiblePronouns,
  withDisplayNamePronouns,
} from './pronouns';

const set = (summary: string, language: string | null) => ({ summary, language });

describe('splitDisplayNamePronouns', () => {
  it('splits a parenthesised pronoun set out of the name', () => {
    expect(splitDisplayNamePronouns('sugary (she/it)')).toEqual({
      name: 'sugary',
      pronouns: [set('she/it', null)],
    });
  });

  it('detects a bracketed set anywhere in the name', () => {
    expect(splitDisplayNamePronouns('[they/them/theirs] sugary ✨')).toEqual({
      name: 'sugary ✨',
      pronouns: [set('they/them/theirs', null)],
    });
    expect(splitDisplayNamePronouns('sugary (she/it) ✨')).toEqual({
      name: 'sugary ✨',
      pronouns: [set('she/it', null)],
    });
  });

  it('keeps a name that is only a pronoun set', () => {
    expect(splitDisplayNamePronouns('(she/it)')).toEqual({ name: '(she/it)', pronouns: [] });
  });

  it('ignores parentheticals that are not pronoun sets', () => {
    for (const name of ['sugary ()', 'sugary (2019)', 'sugary (away)', 'sugary (a/b/c/d)']) {
      expect(splitDisplayNamePronouns(name)).toEqual({ name, pronouns: [] });
    }
  });
});

describe('withDisplayNamePronouns', () => {
  it('appends a set from the name that the profile lacks', () => {
    expect(withDisplayNamePronouns([set('she/her', 'en')], [set('they/them', null)])).toEqual([
      set('she/her', 'en'),
      set('they/them', null),
    ]);
  });

  it('skips a set the profile already has, ignoring case', () => {
    expect(withDisplayNamePronouns([set('She/Her', 'en')], [set('she/her', null)])).toEqual([
      set('She/Her', 'en'),
    ]);
  });
});

describe('preferredPronouns', () => {
  it('keeps only the sets tagged with the reader language', () => {
    const pronouns = [set('they/them', 'en'), set('iel', 'fr'), set('sie', 'de')];
    expect(preferredPronouns(pronouns, 'fr-FR')).toEqual([set('iel', 'fr')]);
  });

  it('treats an untagged set as English', () => {
    expect(preferredPronouns([set('they/them', null), set('iel', 'fr')], 'en')).toEqual([
      set('they/them', null),
    ]);
  });

  it('falls back to every set when the language matches nothing', () => {
    const pronouns = [set('iel', 'fr'), set('sie', 'de')];
    expect(preferredPronouns(pronouns, 'ja')).toEqual(pronouns);
  });
});

describe('visiblePronouns', () => {
  it('caps the pills at three and reports the rest as overflow', () => {
    const pronouns = [
      set('they/them', 'en'),
      set('she/her', 'en'),
      set('he/him', 'en'),
      set('it/its', 'en'),
    ];
    expect(visiblePronouns(pronouns, { language: 'en' })).toEqual({
      visible: pronouns.slice(0, 3),
      overflow: [set('it/its', 'en')],
    });
  });

  it('caps after the language preference, not before it', () => {
    const pronouns = [
      set('sie', 'de'),
      set('elle', 'fr'),
      set('iel', 'fr'),
      set('they/them', 'en'),
    ];
    expect(visiblePronouns(pronouns, { language: 'fr', limit: 1 })).toEqual({
      visible: [set('elle', 'fr')],
      overflow: [set('iel', 'fr')],
    });
  });

  it('keeps every set when the language filter is off', () => {
    const pronouns = [set('iel', 'fr'), set('they/them', 'en')];
    expect(visiblePronouns(pronouns, { language: 'en', filterByLanguage: false })).toEqual({
      visible: pronouns,
      overflow: [],
    });
  });

  it('reads an unlimited pill count off the preference', () => {
    const pronouns = [
      set('she/her', 'en'),
      set('they/them', 'en'),
      set('he/him', 'en'),
      set('it/its', 'en'),
    ];
    expect(visiblePronouns(pronouns, { language: 'en', limit: pronounPillLimit('all') })).toEqual({
      visible: pronouns,
      overflow: [],
    });
  });
});
