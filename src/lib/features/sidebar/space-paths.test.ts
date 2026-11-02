import { expect, test } from 'vitest';

import { isJoinedRoomPath, spaceIndexRedirect, spaceNavigationHref } from './space-paths.js';

const root = '/space/!space%3Aexample.org';
const lobby = `${root}/lobby`;
const joined = (pathId: string) => pathId === '!room:example.org';

test('sends a space index to the room last visited in it', () => {
  expect(spaceIndexRedirect(root, `${root}/!room%3Aexample.org`, lobby, joined)).toBe(
    `${root}/!room%3Aexample.org`
  );
  expect(spaceIndexRedirect(root, `${root}/!room%3Aexample.org?thread=%24t`, lobby, joined)).toBe(
    `${root}/!room%3Aexample.org?thread=%24t`
  );
});

test('falls back to the lobby when there is no room to return to', () => {
  expect(spaceIndexRedirect(root, undefined, lobby, joined)).toBe(lobby);
  expect(spaceIndexRedirect(root, root, lobby, joined)).toBe(lobby);
  expect(
    spaceIndexRedirect(root, '/space/!other%3Aexample.org/!room%3Aexample.org', lobby, joined)
  ).toBe(lobby);
  expect(spaceIndexRedirect(root, `${root}/create-room`, lobby, joined)).toBe(lobby);
  expect(spaceIndexRedirect(root, `${root}/!left%3Aexample.org`, lobby, joined)).toBe(lobby);
  expect(spaceIndexRedirect(root, `${root}/%E0%A4%A`, lobby, joined)).toBe(lobby);
});

test('keeps a remembered lobby visit', () => {
  expect(spaceIndexRedirect(root, lobby, lobby, joined)).toBe(lobby);
});

test.each(['/search', '/search?q=hello&space=!space%3Aexample.org'])(
  'falls back to the lobby for an old saved search route: %s',
  (savedPath) => {
    expect(spaceIndexRedirect(root, savedPath, lobby, joined)).toBe(lobby);
    expect(spaceNavigationHref(root, savedPath, lobby)).toBe(lobby);
  }
);

test.each([
  [`${root}/!room%3Aexample.org`, true],
  [`${root}/!room%3Aexample.org?thread=%24t`, true],
  [`${root}/!left%3Aexample.org`, false],
  [lobby, false],
  [`${root}/create-space`, false],
  [root, false],
  ['/rooms/!room%3Aexample.org', false],
  [`${root}/%E0%A4%A`, false],
])('treats %s as a joined room path: %s', (path, expected) => {
  expect(isJoinedRoomPath(root, path, joined)).toBe(expected);
});
