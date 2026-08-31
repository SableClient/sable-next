import { expect, test, GUEST_DISPLAY_NAME } from './fixtures/test';

test.beforeEach(async ({ page }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1280, height: 900 });
});

test('tapping a vote count opens who voted', async ({ page, app, admin, guest }) => {
  const roomId = await admin.createRoom({
    name: `Disclosed poll ${String(Date.now())}`,
    invite: [guest.userId],
  });
  await guest.join(roomId);

  const pollId = await admin.createPoll(roomId, 'Best pet?', ['Cats', 'Dogs']);
  await admin.votePoll(roomId, pollId, ['answer-0']);
  await guest.votePoll(roomId, pollId, ['answer-0']);

  await app.openRoom(roomId);

  const votesButton = page.getByRole('button', { name: 'See who voted for "Cats"' });
  await expect(votesButton).toBeVisible({ timeout: 15_000 });
  await votesButton.click();

  const dialog = page.getByRole('dialog', { name: 'Voters' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(GUEST_DISPLAY_NAME)).toBeVisible();
  await expect(dialog.getByRole('listitem')).toHaveCount(2);
});

test('an undisclosed open poll offers no way to see who voted', async ({ page, app, admin }) => {
  const roomId = await admin.createRoom({ name: `Undisclosed poll ${String(Date.now())}` });

  const pollId = await admin.createPoll(roomId, 'Secret ballot?', ['Yes', 'No'], {
    undisclosed: true,
  });
  await admin.votePoll(roomId, pollId, ['answer-0']);

  await app.openRoom(roomId);

  const poll = page.locator('.timeline-viewport').filter({ hasText: 'Secret ballot?' });
  await expect(poll.getByText('Results are hidden until the poll closes')).toBeVisible({
    timeout: 15_000,
  });
  await expect(poll.locator('.count')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /See who voted/ })).toHaveCount(0);
});
