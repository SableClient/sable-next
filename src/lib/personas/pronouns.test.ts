import { describe, expect, it } from 'vitest';

import { preferredPronouns, pronounPillLimit, visiblePronouns } from './pronouns';

const set = (summary: string, language: string | null) => ({ summary, language });

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
