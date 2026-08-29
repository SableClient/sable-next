import { expect, test } from './fixtures/test';

const GENERAL_ROOM_ID = '!room:example.test';
const RANDOM_ROOM_ID = '!second:example.test';

test('a widget renders in a sandboxed iframe with the room and user substituted', async ({
  page,
  app,
  installRoomCore,
}) => {
  await installRoomCore('ready');
  await app.openRoom(GENERAL_ROOM_ID);

  const toggle = page.getByRole('button', { name: 'Widgets' });
  await expect(toggle).toBeVisible();
  await toggle.click();

  await expect(page.getByRole('tab', { name: 'Dashboard' })).toBeVisible();

  const frame = page.locator('.widgets-frame');
  await expect(frame).toBeVisible();
  await expect(frame).toHaveAttribute('sandbox', 'allow-scripts allow-forms allow-popups');

  const src = await frame.getAttribute('src');
  const url = new URL(src ?? '');
  expect(url.searchParams.get('user')).toBe('@e2e:example.test');
  expect(url.searchParams.get('room')).toBe(GENERAL_ROOM_ID);
  expect(url.searchParams.get('widgetId')).toBe('dashboard');

  await expect(page.getByRole('button', { name: 'Remove Dashboard' })).toBeVisible();
});

test('widget removal is hidden without permission to change room settings', async ({
  page,
  app,
  installRoomCore,
}) => {
  await installRoomCore('ready');
  await app.openRoom(RANDOM_ROOM_ID);

  await page.getByRole('button', { name: 'Widgets' }).click();
  await expect(page.locator('.widgets-frame')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Remove Dashboard' })).toHaveCount(0);
});

test('removing a widget with permission takes it out of the panel', async ({
  page,
  app,
  core,
  installRoomCore,
}) => {
  await installRoomCore('ready');
  await app.openRoom(GENERAL_ROOM_ID);

  await page.getByRole('button', { name: 'Widgets' }).click();
  await page.getByRole('button', { name: 'Remove Dashboard' }).click();

  await expect(page.getByText('This room has no widgets.')).toBeVisible();
  await expect.poll(() => core.commands()).toContain('send_state_event');
});
