import { expect, test } from 'vitest';

import { spaceIndexRedirect, spaceNavigationHref } from './space-paths.js';

const root = '/space/!space%3Aexample.org';
const lobby = `${root}/lobby`;
const joined = (pathId: string) => pathId === '!room:example.org';

test('sends a space index to the room last visited in it', () => {
  expect(spaceIndexRedirect(root, `${root}/!room%3Aexample.org`, lobby, '/search', joined)).toBe(
    `${root}/!room%3Aexample.org`
  );
  expect(
    spaceIndexRedirect(root, `${root}/!room%3Aexample.org?thread=%24t`, lobby, '/search', joined)
  ).toBe(`${root}/!room%3Aexample.org?thread=%24t`);
});

test('falls back to the lobby when there is no room to return to', () => {
  expect(spaceIndexRedirect(root, undefined, lobby, '/search', joined)).toBe(lobby);
  expect(spaceIndexRedirect(root, root, lobby, '/search', joined)).toBe(lobby);
  expect(
    spaceIndexRedirect(
      root,
      '/space/!other%3Aexample.org/!room%3Aexample.org',
      lobby,
      '/search',
      joined
    )
  ).toBe(lobby);
  expect(spaceIndexRedirect(root, `${root}/create-room`, lobby, '/search', joined)).toBe(lobby);
  expect(spaceIndexRedirect(root, `${root}/!left%3Aexample.org`, lobby, '/search', joined)).toBe(
    lobby
  );
  expect(spaceIndexRedirect(root, `${root}/%E0%A4%A`, lobby, '/search', joined)).toBe(lobby);
});

test('keeps a remembered lobby visit', () => {
  expect(spaceIndexRedirect(root, lobby, lobby, '/search', joined)).toBe(lobby);
});

test('returns to a remembered space search', () => {
  expect(spaceIndexRedirect(root, '/search?q=hello', lobby, '/search', joined)).toBe(
    '/search?q=hello'
  );
  expect(spaceNavigationHref(root, '/search?q=hello', false, lobby, '/search')).toBe(
    '/search?q=hello'
  );
});
