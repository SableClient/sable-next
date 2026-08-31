import { expect, test } from './fixtures/test';

const WIDGET_URL =
  'https://widgets.example.test/dashboard?user=$matrix_user_id&room=$matrix_room_id&name=$matrix_display_name';

function widget(): Record<string, unknown> {
  return { type: 'grafana', url: WIDGET_URL, name: 'Dashboard', data: {} };
}

test.beforeEach(() => {
  test.setTimeout(60_000);
});

test('a widget renders in a sandboxed iframe with the room and user substituted', async ({
  page,
  app,
  admin,
}) => {
  const roomId = await admin.createRoom({ name: `Widgets ${String(Date.now())}` });
  await admin.sendMessage(roomId, 'Dashboard lives here.');
  await admin.setWidget(roomId, 'dashboard', widget());

  const toggle = page.getByRole('button', { name: 'Widgets' });
  await app.openRoomShowing(roomId, toggle);
  await toggle.click();

  await expect(page.getByRole('tab', { name: 'Dashboard' })).toBeVisible();

  const frame = page.locator('iframe.widget-frame');
  await expect(frame).toBeVisible();
  await expect(frame).toHaveAttribute(
    'sandbox',
    'allow-forms allow-popups allow-popups-to-escape-sandbox allow-same-origin allow-scripts allow-downloads'
  );

  const url = new URL((await frame.getAttribute('src')) ?? '');
  expect(url.searchParams.get('user')).toBe(admin.userId);
  expect(url.searchParams.get('room')).toBe(roomId);
  expect(url.searchParams.get('widgetId')).toBe('dashboard');

  await expect(page.getByRole('button', { name: 'Remove Dashboard' })).toBeVisible();
});

test('widget removal is hidden without permission to change room settings', async ({
  page,
  app,
  admin,
  guest,
}) => {
  const roomId = await guest.createRoom({
    name: `Guest widgets ${String(Date.now())}`,
    invite: [admin.userId],
  });
  await admin.join(roomId);
  await guest.sendMessage(roomId, 'Dashboard lives here too.');
  await guest.setWidget(roomId, 'dashboard', widget());

  await app.openRoomShowing(roomId, page.getByRole('button', { name: 'Widgets' }));

  await page.getByRole('button', { name: 'Widgets' }).click();
  await expect(page.locator('iframe.widget-frame')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Remove Dashboard' })).toHaveCount(0);
});

test('removing a widget with permission takes it out of the room state', async ({
  page,
  app,
  admin,
}) => {
  const roomId = await admin.createRoom({ name: `Remove widget ${String(Date.now())}` });
  await admin.sendMessage(roomId, 'Dashboard lives here.');
  await admin.setWidget(roomId, 'dashboard', widget());

  await app.openRoomShowing(roomId, page.getByRole('button', { name: 'Widgets' }));

  await page.getByRole('button', { name: 'Widgets' }).click();
  await page.getByRole('button', { name: 'Remove Dashboard' }).click();

  await expect(page.getByText('This room has no widgets.')).toBeVisible();

  await expect
    .poll(() =>
      admin.request<Record<string, unknown>>(
        'GET',
        `client/v3/rooms/${encodeURIComponent(roomId)}/state/im.vector.modular.widgets/dashboard`
      )
    )
    .toEqual({});
});
