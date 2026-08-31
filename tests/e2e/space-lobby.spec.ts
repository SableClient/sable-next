import { expect, test, SIGNED_OUT } from './fixtures/test';

test.use({ storageState: SIGNED_OUT });

function lobby(spaceId: string): string {
  return `/space/${encodeURIComponent(spaceId)}/lobby`;
}

function region(page: import('@playwright/test').Page) {
  return page.getByRole('region', { name: 'Lobby' });
}

test.beforeEach(async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1280, height: 900 });
});

function sectionWith(page: import('@playwright/test').Page, room: string) {
  return region(page).locator('.section', {
    has: page.locator('.room-name', { hasText: room }),
  });
}

test('the lobby pages the hierarchy through to the end without a click', async ({
  page,
  spaceTree,
}) => {
  await page.goto(lobby(spaceTree.alphaId));

  await expect(region(page).locator('.room-name', { hasText: 'Late Arrival' })).toBeVisible({
    timeout: 30_000,
  });
  await expect(region(page).locator('.room-name', { hasText: 'Deep Room' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Load more' })).toHaveCount(0);
});

test('a first page with nothing renderable is not reported as an empty space', async ({
  page,
  spaceTree,
}) => {
  await page.goto(lobby(spaceTree.alphaId));

  await expect(region(page).locator('.room-name', { hasText: 'Late Arrival' })).toBeVisible({
    timeout: 30_000,
  });
  await expect(region(page).getByText('This space has no rooms yet.')).toHaveCount(0);
});

test('a room from a later page lands under its own subspace heading', async ({
  page,
  spaceTree,
}) => {
  await page.goto(lobby(spaceTree.alphaId));

  await expect(region(page).locator('.room-name', { hasText: 'Deep Room' })).toBeVisible({
    timeout: 30_000,
  });
  await expect(region(page).locator('.section-name', { hasText: 'Nested' })).toBeVisible();
});

test('the lobby names the space it is showing', async ({ page, spaceTree }) => {
  await page.goto(lobby(spaceTree.alphaId));

  await expect(region(page).getByRole('heading', { level: 1, name: 'Alpha' })).toBeVisible({
    timeout: 30_000,
  });
});

test('switching spaces does not leave the previous space rooms on screen', async ({
  page,
  spaceTree,
}) => {
  await page.goto(lobby(spaceTree.alphaId));
  await expect(region(page).locator('.room-name', { hasText: 'Late Arrival' })).toBeVisible({
    timeout: 30_000,
  });

  await page.goto(lobby(spaceTree.betaId));

  await expect(region(page).getByRole('heading', { level: 1, name: 'Beta' })).toBeVisible({
    timeout: 60_000,
  });
  await expect(region(page).locator('.room-name', { hasText: 'Late Arrival' })).toHaveCount(0);
});

test('the keyboard move sends one order for the room that moved', async ({ page, spaceTree }) => {
  await page.goto(lobby(spaceTree.alphaId));

  const rooms = sectionWith(page, 'Late Arrival').locator('.room-name');
  await expect(rooms).toHaveText([/Late Arrival/, /Middle Room/, /Tail Room/], {
    timeout: 30_000,
  });

  const tail = spaceTree.children.find((child) => child.name === 'Tail Room');
  const middle = spaceTree.children.find((child) => child.name === 'Middle Room');
  if (!tail || !middle) throw new Error('missing seeded children');
  const before = await spaceTree.account.spaceChild(spaceTree.alphaId, middle.roomId);

  await page
    .locator('.room', { has: page.locator('.room-name', { hasText: 'Tail Room' }) })
    .getByRole('button', { name: 'Room options' })
    .click();
  await page.getByRole('menuitem', { name: 'Move up' }).click();

  await expect(rooms).toHaveText([/Late Arrival/, /Tail Room/, /Middle Room/]);

  await expect
    .poll(() =>
      spaceTree.account.spaceChild(spaceTree.alphaId, tail.roomId).then((edge) => edge.order)
    )
    .toEqual(expect.any(String));
  const after = await spaceTree.account.spaceChild(spaceTree.alphaId, middle.roomId);
  expect(after.order).toBe(before.order);
});

test('moving the first room up does nothing', async ({ page, spaceTree }) => {
  await page.goto(lobby(spaceTree.alphaId));

  const rooms = sectionWith(page, 'Late Arrival').locator('.room-name');
  await expect(rooms).toHaveText([/Late Arrival/, /Middle Room/, /Tail Room/], {
    timeout: 30_000,
  });

  const late = spaceTree.children.find((child) => child.name === 'Late Arrival');
  if (!late) throw new Error('missing seeded child');
  const before = await spaceTree.account.spaceChild(spaceTree.alphaId, late.roomId);

  await page
    .locator('.room', { has: page.locator('.room-name', { hasText: 'Late Arrival' }) })
    .getByRole('button', { name: 'Room options' })
    .click();
  await page.getByRole('menuitem', { name: 'Move up' }).click();

  await expect(rooms).toHaveText([/Late Arrival/, /Middle Room/, /Tail Room/]);
  const after = await spaceTree.account.spaceChild(spaceTree.alphaId, late.roomId);
  expect(after.order).toBe(before.order);
});

test('a dragged room is dropped where the indicator showed', async ({ page, spaceTree }) => {
  await page.goto(lobby(spaceTree.alphaId));

  const rooms = sectionWith(page, 'Late Arrival').locator('.room-name');
  await expect(rooms).toHaveText([/Late Arrival/, /Middle Room/, /Tail Room/], {
    timeout: 30_000,
  });

  const source = region(page).locator('.room', {
    has: page.locator('.room-name', { hasText: 'Tail Room' }),
  });
  const target = region(page).locator('.room', {
    has: page.locator('.room-name', { hasText: 'Late Arrival' }),
  });

  await source.dragTo(target, { targetPosition: { x: 20, y: 2 } });

  await expect(rooms).toHaveText([/Tail Room/, /Late Arrival/, /Middle Room/]);
});

test('a room shows a drag handle when the account can manage the space', async ({
  page,
  spaceTree,
}) => {
  await page.goto(lobby(spaceTree.alphaId));

  await expect(region(page).locator('.room-name', { hasText: 'Late Arrival' })).toBeVisible({
    timeout: 30_000,
  });
  await expect(region(page).locator('.drag-handle').first()).toBeVisible();
});

test('a subspace the server refuses is not reported as a broken lobby', async ({
  page,
  spaceTree,
}) => {
  await page.goto(lobby(spaceTree.alphaId));

  await expect(region(page).locator('.room-name', { hasText: 'Late Arrival' })).toBeVisible({
    timeout: 30_000,
  });
  await expect(region(page).locator('.room-name', { hasText: 'Deep Room' })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(region(page).getByText('This space has no rooms yet.')).toHaveCount(0);
});

test('a long topic is clamped in the hero and opens in full', async ({ page, spaceTree }) => {
  await page.goto(lobby(spaceTree.alphaId));

  const topic = region(page).locator('.topic');
  await expect(topic).toBeVisible({ timeout: 30_000 });

  const clamped = await page
    .locator('.topic-text')
    .evaluate((element) => element.scrollHeight > element.clientHeight + 1);
  expect(clamped).toBe(true);

  await topic.click();
  await expect(page.getByRole('dialog', { name: 'Topic' })).toBeVisible();
  await expect(page.locator('.topic-full')).toContainText('past the three lines');
});

test('the whole lobby scrolls, hero included', async ({ page, spaceTree }) => {
  await page.setViewportSize({ width: 900, height: 400 });
  await page.goto(lobby(spaceTree.alphaId));
  await expect(region(page).locator('.room-name', { hasText: 'Late Arrival' })).toBeVisible({
    timeout: 30_000,
  });

  const scrolled = await page.locator('.lobby-page').evaluate((element) => {
    element.scrollTop = element.scrollHeight;
    return element.scrollTop;
  });
  expect(scrolled).toBeGreaterThan(0);
  await expect(region(page).getByRole('heading', { level: 1, name: 'Alpha' })).not.toBeInViewport();
});
