import type { Locator, Page } from '@playwright/test';

import en from '../../src/locales/en.json' with { type: 'json' };
import { expect, test as base } from './fixtures/test';
import { COLD_BOOT_TIMEOUT } from './pages/AppShell';

const test = base.extend({
  storageState: ({ workerSearchCorpus }, use) => use(workerSearchCorpus.statePath),
});

const SEARCH_FIELD = en.common.searchMessages;
const INDEXED = { timeout: COLD_BOOT_TIMEOUT };

function group(page: Page, name: string) {
  return page.getByRole('main').getByRole('heading', { name, level: 2 });
}

function anyGroup(page: Page, name: string) {
  return group(page, name).first();
}

function hit(page: Page, text: RegExp) {
  return page.locator('.hit').filter({ has: page.locator('.hit-message', { hasText: text }) });
}

function marked(page: Page): Promise<string[]> {
  return page.evaluate(() => [...(CSS.highlights.get('search-match') ?? [])].map(String));
}

function chips(scope: Page | Locator) {
  return scope.getByRole('list', { name: en.search.activeFilters }).getByRole('listitem');
}

function searchField(page: Page) {
  return page.getByRole('combobox', { name: SEARCH_FIELD });
}

function orderControl(page: Page) {
  return page.getByRole('button', { name: en.search.order });
}

async function chooseOrder(page: Page, label: string): Promise<void> {
  await orderControl(page).click();
  await page.getByRole('option', { name: label }).click();
}

async function awaitIndexed(page: Page): Promise<void> {
  await searchField(page).fill('welcome');
  await expect(hit(page, /Welcome to/).first()).toBeVisible({
    timeout: 60_000,
  });
}

test('the room header search button opens a search panel scoped to that room', async ({
  page,
  app,
}) => {
  await app.openRooms();
  await app.openRoomFromList('General');
  await page.waitForURL(/\/rooms\/.+/);
  const roomUrl = page.url();

  await page.getByRole('button', { name: en.common.searchMessages }).click();

  const panel = page.getByRole('complementary', { name: en.common.searchMessages });
  await expect(chips(panel)).toHaveText(/in:\s*General/);
  await expect(searchField(page)).toBeFocused();
  await expect(searchField(page)).toHaveValue('');
  await searchField(page).fill('message');
  await expect(panel.locator('.hit-row').first()).toBeVisible(INDEXED);
  expect(page.url()).toBe(roomUrl);
  await page.screenshot({ path: '/tmp/room-search-panel.png' });

  await panel.getByRole('button', { name: en.search.close }).click();
  await expect(panel).toHaveCount(0);
});

test('message search from a space sidebar starts scoped to that space', async ({
  page,
  searchCorpus,
}) => {
  await page.goto(`/space/${encodeURIComponent(searchCorpus.clubId)}`);

  await page.getByRole('link', { name: en.nav.messageSearch }).click();

  await expect(page).toHaveURL(/\/search\?q=/);
  await expect(chips(page)).toHaveText(/space:\s*Club/);
});

test('a query returns hits grouped by room and opens the message it lands on', async ({ page }) => {
  await page.goto('/search');

  const field = searchField(page);
  await field.fill('welcome');

  const results = hit(page, /Welcome to/);
  await expect(results.first()).toBeVisible(INDEXED);
  await expect(anyGroup(page, 'General')).toBeVisible(INDEXED);
  await expect(anyGroup(page, 'Random')).toBeVisible(INDEXED);

  await results.first().locator('.hit-message').click();
  await expect.poll(() => new URL(page.url()).searchParams.get('event')).toMatch(/^\$/);
});

test('in: narrows the results to one room', async ({ page, searchCorpus }) => {
  await page.goto('/search');

  await searchField(page).fill('welcome');
  await expect(anyGroup(page, 'Random')).toBeVisible({ timeout: 20_000 });

  await searchField(page).fill(`welcome in:${searchCorpus.randomId}`);

  await expect(anyGroup(page, 'Random')).toBeVisible(INDEXED);
  await expect(group(page, 'General')).toHaveCount(0);
});

test('a quoted phrase and an exclusion change the result set', async ({ page }) => {
  await page.goto('/search');
  const field = searchField(page);

  await field.fill('"General message 1"');
  await expect(hit(page, /General message 1(?!\d)/)).toBeVisible(INDEXED);

  await field.fill('message -Random');
  await expect(group(page, 'Random')).toHaveCount(0);
});

test('the query survives a reload through the url', async ({ page }) => {
  await page.goto('/search');
  await searchField(page).fill('welcome');
  await expect(page).toHaveURL(/q=welcome/);

  await page.reload();

  await expect(searchField(page)).toHaveValue('welcome');
  await expect(hit(page, /Welcome to/).first()).toBeVisible(INDEXED);
});

test('pinned:true keeps only the pinned message', async ({ page }) => {
  await page.goto('/search');

  await searchField(page).fill('Clubhouse pinned:true ');

  await expect(chips(page)).toHaveText(/pinned:\s*true/);
  await expect(hit(page, /Clubhouse notice board/)).toBeVisible(INDEXED);
  await expect(hit(page, /Clubhouse thread reply/)).toHaveCount(0);
});

test('is:thread keeps only thread replies', async ({ page }) => {
  await page.goto('/search');

  await searchField(page).fill('Clubhouse is:thread ');

  await expect(hit(page, /Clubhouse thread reply/)).toBeVisible(INDEXED);
  await expect(hit(page, /Clubhouse notice board/)).toHaveCount(0);
});

test('sorting by oldest puts the first message first', async ({ page }) => {
  await page.goto('/search');
  await searchField(page).fill('message in:General ');
  await expect(page.locator('.hit-row').first()).toBeVisible(INDEXED);

  await chooseOrder(page, en.search.orderOldest);

  await expect(page).toHaveURL(/order=oldest/);
  await expect(page.locator('.hit-row').first()).toContainText('General message 1', INDEXED);
});

test('the search shortcut in a room scopes the search to it', async ({
  page,
  app,
  searchCorpus,
}) => {
  await app.openRoom(searchCorpus.generalId);

  await page.keyboard.press('ControlOrMeta+f');

  await expect(page).toHaveURL(/\/search\?q=/);
  await expect(chips(page)).toHaveText(/in:\s*General/);
  await expect(searchField(page)).toBeFocused();
});

test('a submitted search is offered again from an empty field', async ({ page }) => {
  await page.goto('/search');
  const field = searchField(page);
  await field.fill('rollback plan');
  await field.press('Enter');

  await page.goto('/search');
  await field.click();

  const recent = page.getByRole('option', { name: 'rollback plan' });
  await expect(page.getByRole('listbox', { name: en.search.recentSearches })).toBeVisible();
  await recent.click();
  await expect(field).toHaveValue(/^rollback plan\s*$/);

  await field.fill('');
  await field.focus();
  await page.getByRole('option', { name: en.search.clearRecent }).click();
  await field.blur();
  await field.focus();
  await expect(page.getByRole('option', { name: 'rollback plan' })).toHaveCount(0);
});

test('a query with no matches says so instead of staying blank', async ({ page }) => {
  await page.goto('/search');

  await searchField(page).fill('zzzznothingmatches');

  await expect(page.locator('.announcement')).toHaveText(
    /^(No messages matched|Nothing found yet)\./
  );
  await expect(page.locator('.empty')).toBeVisible();
});

test('sorting by newest reorders the results', async ({ page }) => {
  await page.goto('/search');
  await searchField(page).fill('message');

  await expect(page.locator('.hit-row').first()).toBeVisible(INDEXED);
  const firstBefore = await page.locator('.hit-row').first().innerText();

  await chooseOrder(page, en.search.orderRecent);
  await expect(orderControl(page)).toHaveText(en.search.orderRecent);

  await expect.poll(async () => page.locator('.hit-row').first().innerText()).not.toBe(firstBefore);
});

test('in: accepts a room name with spaces when quoted', async ({ page }) => {
  await page.goto('/search');

  await searchField(page).fill('message');
  await expect(anyGroup(page, 'Random')).toBeVisible({ timeout: 20_000 });

  await searchField(page).fill('message in:"Random"');

  await expect(anyGroup(page, 'Random')).toBeVisible(INDEXED);
  await expect(group(page, 'General')).toHaveCount(0);
});

test('from: accepts a sender localpart rather than a full id', async ({
  page,
  app,
  searchCorpus,
}) => {
  await app.openRoom(searchCorpus.generalId);
  await page.goto('/search');

  await searchField(page).fill('message');
  await expect(page.locator('.hit-row').first()).toBeVisible({ timeout: 20_000 });

  const localpart = searchCorpus.sender.userId.replace(/^@/, '').split(':')[0];
  await searchField(page).fill(`message from:${localpart}`);

  await expect(page.locator('.hit-row').first()).toBeVisible(INDEXED);
  await expect(page.getByText(/No messages matched|Nothing found yet/)).toHaveCount(0);
});

test('an unknown from: yields nothing rather than every message', async ({ page }) => {
  await page.goto('/search');

  await searchField(page).fill('message from:nobody');

  await expect(page.locator('.announcement')).toHaveText(
    /^(No messages matched|Nothing found yet)\./
  );
  await expect(page.getByText(/No match for from:nobody/)).toBeVisible();
});

test('in: offers rooms and accepting one inserts its alias', async ({ page }) => {
  await page.goto('/search');
  const field = searchField(page);

  await field.fill('message in:Ran');
  await page
    .getByRole('option', { name: /Random/ })
    .first()
    .click();

  await expect(chips(page)).toHaveText(/in:\s*Random/);
  await expect(field).toHaveValue('message ');
  await expect(anyGroup(page, 'Random')).toBeVisible(INDEXED);
});

test('matched terms are marked in the result body', async ({ page }) => {
  await page.goto('/search');

  await awaitIndexed(page);

  await searchField(page).fill('welcome');

  await expect.poll(() => marked(page), INDEXED).toContainEqual(expect.stringMatching(/Welcome/i));
});

test('the result count is announced', async ({ page }) => {
  await page.goto('/search');

  await searchField(page).fill('welcome');

  await expect(page.locator('.count')).toHaveText(/\d+ results?/, INDEXED);
});

test('the sort order rides in the url and survives a reload', async ({ page }) => {
  await page.goto('/search');
  await searchField(page).fill('message');

  await chooseOrder(page, en.search.orderRecent);
  await expect(page).toHaveURL(/order=recent/);

  await page.reload();

  await expect(orderControl(page)).toHaveText(en.search.orderRecent);
});

test('zero results are announced and offer a way out', async ({ page, searchCorpus }) => {
  await page.goto('/search');

  await searchField(page).fill(`zzznothing in:${searchCorpus.generalId}`);

  await expect(page.locator('.announcement')).toHaveText(
    /^(No messages matched|Nothing found yet)\./
  );
  await expect(page.getByText(/Remove a filter/)).toBeVisible();
});

test('a stemmed match is still marked in the body', async ({ page }) => {
  await page.goto('/search');

  await searchField(page).fill('messag');

  await expect.poll(() => marked(page), INDEXED).toContainEqual(expect.stringMatching(/message/i));
});

test('a result row names the sender and shows their avatar initials', async ({ page }) => {
  await page.goto('/search');

  await searchField(page).fill('welcome');

  await expect(page.locator('.hit .sender').first()).toHaveText('Alice', INDEXED);
  await expect(page.locator('.hit-row').first().locator('.avatar-root')).toBeVisible();
});

test('the remove button drops the chip and rebroadens the results', async ({ page }) => {
  await page.goto('/search');

  await searchField(page).fill('message in:Random ');
  await expect(anyGroup(page, 'Random')).toBeVisible(INDEXED);
  await expect(group(page, 'General')).toHaveCount(0);

  await page.getByRole('button', { name: 'Remove in:Random' }).click();

  await expect(chips(page)).toHaveCount(0);
  await expect(anyGroup(page, 'General')).toBeVisible(INDEXED);
});

test('from: suggestions show display names', async ({ page, app, searchCorpus }) => {
  await app.openRoom(searchCorpus.generalId);
  await page.goto('/search');

  await searchField(page).fill('welcome');
  await expect(page.locator('.hit .sender').first()).toHaveText('Alice', INDEXED);

  await searchField(page).fill('welcome from:Ali');

  await expect(page.getByRole('option', { name: 'Alice' })).toBeVisible();
});

test('the sort controls are not covered by the suggestions', async ({ page }) => {
  await page.goto('/search');
  await searchField(page).fill('has:');
  await expect(page.getByRole('listbox')).toBeVisible();

  await chooseOrder(page, en.search.orderRecent);

  await expect(orderControl(page)).toHaveText(en.search.orderRecent);
});

test('a negated room filter drops that room instead of matching its text', async ({ page }) => {
  await page.goto('/search');

  await awaitIndexed(page);

  await searchField(page).fill('message -in:Random ');

  await expect(anyGroup(page, 'General')).toBeVisible(INDEXED);
  await expect(group(page, 'Random')).toHaveCount(0);
});

test('a quoted phrase is marked whole in the result body', async ({ page }) => {
  await page.goto('/search');

  await awaitIndexed(page);

  await searchField(page).fill('"General message 1"');

  await expect.poll(() => marked(page), INDEXED).toContain('General message 1');
});

test('arrow down from the field reaches the results and enter opens one', async ({ page }) => {
  await page.goto('/search');
  await awaitIndexed(page);

  await searchField(page).press('ArrowDown');
  await expect(page.locator('.hit-row').first()).toBeFocused();

  await page.keyboard.press('Enter');
  await expect.poll(() => new URL(page.url()).searchParams.get('event')).toMatch(/^\$/);
});

test('an unresolved room offers the nearest match', async ({ page }) => {
  await page.goto('/search');

  await searchField(page).fill('welcome in:gener ');

  await page.getByRole('button', { name: /^Use General/ }).click();

  await expect(chips(page)).toContainText(['General']);
  await expect(hit(page, /Welcome to General/)).toBeVisible(INDEXED);
});
