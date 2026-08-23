import { expect, test } from './fixtures/test';

const LOBBY = '/space/!alpha%3Aexample.test/lobby';

test('the lobby pages the hierarchy through to the end without a click', async ({
  page,
  installRoomCore,
}) => {
  await installRoomCore('spaces');
  await page.goto(LOBBY);

  await expect(page.locator('.room-name', { hasText: 'Late Arrival' })).toBeVisible();
  await expect(page.locator('.room-name', { hasText: 'Deep Room' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Load more' })).toHaveCount(0);
});

test('a first page with nothing renderable is not reported as an empty space', async ({
  page,
  installRoomCore,
}) => {
  await installRoomCore('spaces');
  await page.goto(LOBBY);

  await expect(page.getByText('This space has no rooms yet.')).toHaveCount(0);
  await expect(page.locator('.room-name', { hasText: 'Late Arrival' })).toBeVisible();
});

test('a room from a later page lands under its own subspace heading', async ({
  page,
  installRoomCore,
}) => {
  await installRoomCore('spaces');
  await page.goto(LOBBY);

  await expect(page.locator('.room-name', { hasText: 'Deep Room' })).toBeVisible();
  await expect(page.locator('.section-name', { hasText: 'Nested' })).toBeVisible();
});

test('the lobby names the space it is showing', async ({ page, installRoomCore }) => {
  await installRoomCore('spaces');
  await page.goto(LOBBY);

  await expect(page.getByRole('heading', { level: 1, name: 'Alpha' })).toBeVisible();
});

test('switching spaces does not leave the previous space rooms on screen', async ({
  page,
  installRoomCore,
}) => {
  await installRoomCore('spaces');
  await page.goto(LOBBY);
  await expect(page.locator('.room-name', { hasText: 'Late Arrival' })).toBeVisible();

  await page.goto('/space/!beta%3Aexample.test/lobby');

  await expect(page.locator('.room-name', { hasText: 'Late Arrival' })).toHaveCount(0);
  await expect(page.getByRole('heading', { level: 1, name: 'Beta' })).toBeVisible();
});
