import type { Page } from '@playwright/test';

import { expect, test } from './fixtures/test';

const SEARCH_FIELD = 'Search messages — try from:ada in:#general has:image';

function searchField(page: Page) {
  return page.getByRole('combobox', { name: SEARCH_FIELD });
}

test('the room header search button opens the search page scoped to that room', async ({
  page,
  app,
  installRoomCore,
}) => {
  await installRoomCore('ready');
  await app.openHome();
  await app.openRoomFromList('General');

  await page.getByRole('button', { name: 'Search messages' }).click();

  await expect(page).toHaveURL(/\/search\?q=/);
  await expect(page.locator('.chip')).toHaveText(/in:\s*General/);
  await expect(searchField(page)).toHaveValue('');
});

test('a query returns hits grouped by room and opens the message it lands on', async ({
  page,
  installRoomCore,
}) => {
  await installRoomCore('ready');
  await page.goto('/search');

  const field = searchField(page);
  await field.fill('welcome');

  const results = page.getByRole('button', { name: /Welcome to/ });
  await expect(results.first()).toBeVisible();
  await expect(page.getByRole('heading', { name: 'General', level: 2 })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Random', level: 2 })).toBeVisible();

  await results.first().click();
  await expect(page).toHaveURL(/event=%24general-0%3Aexample\.test/);
});

test('in: narrows the results to one room', async ({ page, installRoomCore }) => {
  await installRoomCore('ready');
  await page.goto('/search');

  await searchField(page).fill('welcome in:!second:example.test');

  await expect(page.getByRole('heading', { name: 'Random', level: 2 })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'General', level: 2 })).toHaveCount(0);
});

test('a quoted phrase and an exclusion change the result set', async ({
  page,
  installRoomCore,
}) => {
  await installRoomCore('ready');
  await page.goto('/search');
  const field = searchField(page);

  await field.fill('"General message 1"');
  await expect(page.getByRole('button', { name: /General message 1$/ })).toBeVisible();

  await field.fill('message -Random');
  await expect(page.getByRole('heading', { name: 'Random', level: 2 })).toHaveCount(0);
});

test('the query survives a reload through the url', async ({ page, installRoomCore }) => {
  await installRoomCore('ready');
  await page.goto('/search');
  await searchField(page).fill('welcome');
  await expect(page).toHaveURL(/q=welcome/);

  await page.reload();

  await expect(searchField(page)).toHaveValue('welcome');
  await expect(page.getByRole('button', { name: /Welcome to/ }).first()).toBeVisible();
});

test('an unsupported operator is reported rather than silently dropped', async ({
  page,
  installRoomCore,
}) => {
  await installRoomCore('ready');
  await page.goto('/search');

  await searchField(page).fill('welcome pinned:true');

  await expect(page.getByText('Not supported yet: pinned')).toBeVisible();
});

test('a query with no matches says so instead of staying blank', async ({
  page,
  installRoomCore,
}) => {
  await installRoomCore('ready');
  await page.goto('/search');

  await searchField(page).fill('zzzznothingmatches');

  await expect(page.locator('.announcement')).toHaveText('No messages matched.');
  await expect(page.locator('.empty')).toBeVisible();
});

test('sorting by newest reorders the results', async ({ page, installRoomCore }) => {
  await installRoomCore('ready');
  await page.goto('/search');
  await searchField(page).fill('message');

  const firstBefore = await page.locator('.hit-row').first().innerText();

  await page.getByRole('button', { name: 'Newest' }).click();
  await expect(page.getByRole('button', { name: 'Newest' })).toHaveAttribute(
    'aria-pressed',
    'true'
  );

  await expect.poll(async () => page.locator('.hit-row').first().innerText()).not.toBe(firstBefore);
});

test('in: accepts a room name with spaces when quoted', async ({ page, installRoomCore }) => {
  await installRoomCore('ready');
  await page.goto('/search');

  await searchField(page).fill('message in:"Random"');

  await expect(page.getByRole('heading', { name: 'Random', level: 2 })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'General', level: 2 })).toHaveCount(0);
});

test('from: accepts a sender localpart rather than a full id', async ({
  page,
  installRoomCore,
}) => {
  await installRoomCore('ready');
  await page.goto('/search');

  await searchField(page).fill('message from:alice');

  await expect(page.locator('.hit-row').first()).toBeVisible();
  await expect(page.getByText('No messages matched.')).toHaveCount(0);
});

test('an unknown from: yields nothing rather than every message', async ({
  page,
  installRoomCore,
}) => {
  await installRoomCore('ready');
  await page.goto('/search');

  await searchField(page).fill('message from:nobody');

  await expect(page.locator('.announcement')).toHaveText('No messages matched.');
  await expect(page.getByText(/No match for from:nobody/)).toBeVisible();
});

test('typing an operator prefix offers completions and Enter accepts one', async ({
  page,
  installRoomCore,
}) => {
  await installRoomCore('ready');
  await page.goto('/search');
  const field = searchField(page);

  await field.fill('fr');
  const listbox = page.getByRole('listbox', { name: 'Search suggestions' });
  await expect(listbox.getByRole('option', { name: 'from:' })).toBeVisible();

  await field.press('Enter');
  await expect(field).toHaveValue('from:');
});

test('in: offers rooms and accepting one inserts its alias', async ({ page, installRoomCore }) => {
  await installRoomCore('ready');
  await page.goto('/search');
  const field = searchField(page);

  await field.fill('message in:Ran');
  await page
    .getByRole('option', { name: /Random/ })
    .first()
    .click();

  await expect(page.locator('.chip')).toHaveText(/in:\s*Random/);
  await expect(field).toHaveValue('message ');
  await expect(page.getByRole('heading', { name: 'Random', level: 2 })).toBeVisible();
});

test('escape dismisses the suggestions without clearing the query', async ({
  page,
  installRoomCore,
}) => {
  await installRoomCore('ready');
  await page.goto('/search');
  const field = searchField(page);

  await field.fill('has:');
  await expect(page.getByRole('option', { name: 'image' })).toBeVisible();

  await field.press('Escape');

  await expect(page.getByRole('listbox')).toHaveCount(0);
  await expect(field).toHaveValue('has:');
});

test('matched terms are marked in the result body', async ({ page, installRoomCore }) => {
  await installRoomCore('ready');
  await page.goto('/search');

  await searchField(page).fill('welcome');

  await expect(page.locator('.hit-body mark').first()).toHaveText(/Welcome/i);
});

test('the result count is announced', async ({ page, installRoomCore }) => {
  await installRoomCore('ready');
  await page.goto('/search');

  await searchField(page).fill('welcome');

  await expect(page.locator('.count')).toHaveText(/\d+ results?/);
});

test('the sort order rides in the url and survives a reload', async ({ page, installRoomCore }) => {
  await installRoomCore('ready');
  await page.goto('/search');
  await searchField(page).fill('message');

  await page.getByRole('button', { name: 'Newest' }).click();
  await expect(page).toHaveURL(/order=recent/);

  await page.reload();

  await expect(page.getByRole('button', { name: 'Newest' })).toHaveAttribute(
    'aria-pressed',
    'true'
  );
});

test('zero results are announced and offer a way out', async ({ page, installRoomCore }) => {
  await installRoomCore('ready');
  await page.goto('/search');

  await searchField(page).fill('zzznothing in:!room:example.test');

  await expect(page.locator('.announcement')).toHaveText('No messages matched.');
  await expect(page.getByText(/Remove a filter/)).toBeVisible();
});

test('a completed filter does not keep the suggestions open', async ({ page, installRoomCore }) => {
  await installRoomCore('ready');
  await page.goto('/search');

  await searchField(page).fill('message in:Random ');

  await expect(page.getByRole('listbox')).toHaveCount(0);
});

test('alt+arrowdown offers the operator cheat-sheet on demand', async ({
  page,
  installRoomCore,
}) => {
  await installRoomCore('ready');
  await page.goto('/search');

  await searchField(page).fill('message ');
  await expect(page.getByRole('listbox')).toHaveCount(0);

  await searchField(page).press('Alt+ArrowDown');

  await expect(page.getByRole('option', { name: /^in:/ })).toBeVisible();
  await expect(page.getByRole('option', { name: /^during:/ })).toBeVisible();
});

test('alt+arrowdown opens the suggestions without moving focus', async ({
  page,
  installRoomCore,
}) => {
  await installRoomCore('ready');
  await page.goto('/search');
  const field = searchField(page);

  await field.fill('has:image');
  await field.press('Escape');
  await expect(page.getByRole('listbox')).toHaveCount(0);

  await field.press('Alt+ArrowDown');

  await expect(page.getByRole('listbox')).toBeVisible();
  await expect(field).toBeFocused();
});

test('escape clears the field only once the suggestions are closed', async ({
  page,
  installRoomCore,
}) => {
  await installRoomCore('ready');
  await page.goto('/search');
  const field = searchField(page);

  await field.fill('has:im');
  await expect(page.getByRole('listbox')).toBeVisible();

  await field.press('Escape');
  await expect(page.getByRole('listbox')).toHaveCount(0);
  await expect(field).toHaveValue('has:im');

  await field.press('Escape');
  await expect(field).toHaveValue('');
});

test('a stemmed match is still marked in the body', async ({ page, installRoomCore }) => {
  await installRoomCore('ready');
  await page.goto('/search');

  await searchField(page).fill('messag');

  await expect(page.locator('.hit-body mark').first()).toHaveText(/message/i);
});

test('a result row names the sender and shows their avatar initials', async ({
  page,
  installRoomCore,
}) => {
  await installRoomCore('ready');
  await page.goto('/search');

  await searchField(page).fill('welcome');

  await expect(page.locator('.hit-sender').first()).toHaveText('Alice');
  await expect(page.locator('.hit-row').first().locator('.sable-avatar')).toBeVisible();
});

test('an operator under the caret stays as text until it is committed', async ({
  page,
  installRoomCore,
}) => {
  await installRoomCore('ready');
  await page.goto('/search');
  const field = searchField(page);

  await field.fill('message in:Random');
  await expect(page.locator('.chip')).toHaveCount(0);
  await expect(field).toHaveValue('message in:Random');

  await field.press('End');
  await field.pressSequentially(' ');

  await expect(page.locator('.chip')).toHaveText(/in:\s*Random/);
  await expect(field).toHaveValue('message ');
});

test('the remove button drops the chip and rebroadens the results', async ({
  page,
  installRoomCore,
}) => {
  await installRoomCore('ready');
  await page.goto('/search');

  await searchField(page).fill('message in:Random ');
  await expect(page.getByRole('heading', { name: 'General', level: 2 })).toHaveCount(0);

  await page.getByRole('button', { name: 'Remove in:Random' }).click();

  await expect(page.locator('.chip')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'General', level: 2 })).toBeVisible();
});

test('backspace on an empty draft removes the last chip', async ({ page, installRoomCore }) => {
  await installRoomCore('ready');
  await page.goto('/search');
  const field = searchField(page);

  await field.fill('in:Random from:alice ');
  await expect(page.locator('.chip')).toHaveCount(2);

  await field.press('Backspace');

  await expect(page.locator('.chip')).toHaveCount(1);
  await expect(page.locator('.chip')).toHaveText(/in:\s*Random/);
});

test('a chip names the room rather than its id', async ({ page, installRoomCore }) => {
  await installRoomCore('ready');
  await page.goto('/search');

  await searchField(page).fill('message in:!second:example.test ');

  await expect(page.locator('.chip')).toHaveText(/in:\s*Random/);
});

test('from: suggestions show display names', async ({ page, installRoomCore }) => {
  await installRoomCore('ready');
  await page.goto('/search');

  await searchField(page).fill('welcome');
  await expect(page.locator('.hit-sender').first()).toHaveText('Alice');

  await searchField(page).fill('welcome from:ali');

  await expect(page.getByRole('option', { name: 'Alice' })).toBeVisible();
});

test('accepting a suggestion closes the list instead of reopening it', async ({
  page,
  installRoomCore,
}) => {
  await installRoomCore('ready');
  await page.goto('/search');
  const field = searchField(page);
  const listbox = page.getByRole('listbox');

  await field.fill('has:im');
  await expect(listbox).toBeVisible();

  await field.press('Enter');

  await expect(page.locator('.chip')).toHaveText(/has:\s*image/);
  await expect(field).toHaveValue('');
  await expect(listbox).toHaveCount(0);
});

test('clicking a suggestion closes the list', async ({ page, installRoomCore }) => {
  await installRoomCore('ready');
  await page.goto('/search');
  await searchField(page).fill('in:Ran');

  await page
    .getByRole('option', { name: /Random/ })
    .first()
    .click();

  await expect(page.getByRole('listbox')).toHaveCount(0);
});

test('leaving the field closes the list', async ({ page, installRoomCore }) => {
  await installRoomCore('ready');
  await page.goto('/search');
  await searchField(page).fill('has:');
  await expect(page.getByRole('listbox')).toBeVisible();

  await searchField(page).blur();

  await expect(page.getByRole('listbox')).toHaveCount(0);
});

test('the sort controls are not covered by the suggestions', async ({ page, installRoomCore }) => {
  await installRoomCore('ready');
  await page.goto('/search');
  await searchField(page).fill('has:');
  await expect(page.getByRole('listbox')).toBeVisible();

  await page.getByRole('button', { name: 'Newest' }).click();

  await expect(page.getByRole('button', { name: 'Newest' })).toHaveAttribute(
    'aria-pressed',
    'true'
  );
});

test('a pasted filter commits to a chip without stranding text in the input', async ({
  page,
  installRoomCore,
}) => {
  await installRoomCore('ready');
  await page.goto('/search');
  const field = searchField(page);

  await field.fill('in:Random ');

  await expect(page.locator('.chip')).toHaveCount(1);
  await expect(field).toHaveValue('');

  await field.pressSequentially('message');

  await expect(page.locator('.chip')).toHaveCount(1);
  await expect(field).toHaveValue('message');
  await expect(page).toHaveURL(/q=in%3ARandom%20message/);
});

test('a space typed after a committed chip is not swallowed', async ({ page, installRoomCore }) => {
  await installRoomCore('ready');
  await page.goto('/search');
  const field = searchField(page);

  await field.fill('in:Random ');
  await field.pressSequentially(' ');

  await expect(field).toHaveValue(' ');
  await expect(page.locator('.chip')).toHaveCount(1);
});

test('backspace after that space deletes the space, not the chip', async ({
  page,
  installRoomCore,
}) => {
  await installRoomCore('ready');
  await page.goto('/search');
  const field = searchField(page);

  await field.fill('in:Random ');
  await field.pressSequentially(' ');
  await field.press('Backspace');

  await expect(page.locator('.chip')).toHaveCount(1);
  await expect(field).toHaveValue('');
});

test('typing in the middle of the draft keeps the space and the caret', async ({
  page,
  installRoomCore,
}) => {
  await installRoomCore('ready');
  await page.goto('/search');
  const field = searchField(page);

  await field.fill('in:Random ');
  await field.pressSequentially('deploy');
  await field.press('Home');
  await field.pressSequentially(' X');

  await expect(field).toHaveValue(' Xdeploy');
  await expect(page.locator('.chip')).toHaveCount(1);
});

test('a chip is built character by character in front of existing text', async ({
  page,
  installRoomCore,
}) => {
  await installRoomCore('ready');
  await page.goto('/search');
  const field = searchField(page);

  await field.pressSequentially('message in:Random');
  await expect(page.locator('.chip')).toHaveCount(0);

  await field.pressSequentially(' ');

  await expect(page.locator('.chip')).toHaveText(/in:\s*Random/);
  await expect(field).toHaveValue('message ');
});

test('a negated room filter drops that room instead of matching its text', async ({
  page,
  installRoomCore,
}) => {
  await installRoomCore('ready');
  await page.goto('/search');

  await searchField(page).fill('message -in:Random ');

  await expect(page.getByRole('heading', { name: 'General', level: 2 })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Random', level: 2 })).toHaveCount(0);
});

test('a negated date bound is reported as unsupported', async ({ page, installRoomCore }) => {
  await installRoomCore('ready');
  await page.goto('/search');

  await searchField(page).fill('message -before:2024-01-01');

  await expect(page.getByText('Not supported yet: -before')).toBeVisible();
});

test('a negated chip names the negation in its remove button', async ({
  page,
  installRoomCore,
}) => {
  await installRoomCore('ready');
  await page.goto('/search');

  await searchField(page).fill('message -in:Random ');

  await expect(page.getByRole('button', { name: 'Remove -in:Random' })).toBeVisible();
});

test('clicking the field padding focuses the input', async ({ page, installRoomCore }) => {
  await installRoomCore('ready');
  await page.goto('/search');
  const field = searchField(page);

  await field.fill('in:Random ');
  await page.locator('.token-field').click({ position: { x: 2, y: 2 } });

  await expect(field).toBeFocused();
});

test('the operator cheat-sheet does not reopen on refocus', async ({ page, installRoomCore }) => {
  await installRoomCore('ready');
  await page.goto('/search');
  const field = searchField(page);

  await field.press('Alt+ArrowDown');
  await expect(page.getByRole('listbox')).toBeVisible();

  await field.blur();
  await expect(page.getByRole('listbox')).toHaveCount(0);

  await field.focus();

  await expect(page.getByRole('listbox')).toHaveCount(0);
});

test('a quoted phrase is marked whole in the result body', async ({ page, installRoomCore }) => {
  await installRoomCore('ready');
  await page.goto('/search');

  await searchField(page).fill('"General message 1"');

  await expect(page.locator('.hit-body mark').first()).toHaveText('General message 1');
});
