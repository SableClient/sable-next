import { expect, test } from './fixtures/test';
import { timelineItem } from './fixtures/timeline-items';

test('tapping a vote count opens who voted', async ({
  page,
  app,
  timeline,
  core,
  installRoomCore,
}) => {
  await installRoomCore('ready');
  await app.openHome();
  await app.openRoomFromList('General');
  await timeline.expectRevealed();

  const subscription = await core.subscription();
  await core.emitTimelineDiff(subscription, [
    {
      op: 'push_back',
      value: {
        ...timelineItem('poll-disclosed', 'Best pet?'),
        content: {
          kind: 'poll',
          poll: {
            question: 'Best pet?',
            answers: [
              {
                id: 'a1',
                text: 'Cats',
                votes: 2,
                voters: ['@alice:example.test', '@carol:example.test'],
                selected: false,
              },
              { id: 'a2', text: 'Dogs', votes: 0, voters: [], selected: false },
            ],
            max_selections: 1,
            undisclosed: false,
            ended_at: null,
            edited: false,
          },
        },
      },
    },
  ]);

  const votesButton = page.getByRole('button', { name: 'See who voted for "Cats"' });
  await expect(votesButton).toBeVisible();
  await votesButton.click();

  const dialog = page.getByRole('dialog', { name: 'Voters' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('Alice')).toBeVisible();
  await expect(dialog.getByText('@carol:example.test')).toBeVisible();
});

test('an undisclosed open poll offers no way to see who voted', async ({
  page,
  app,
  timeline,
  core,
  installRoomCore,
}) => {
  await installRoomCore('ready');
  await app.openHome();
  await app.openRoomFromList('General');
  await timeline.expectRevealed();

  const subscription = await core.subscription();
  await core.emitTimelineDiff(subscription, [
    {
      op: 'push_back',
      value: {
        ...timelineItem('poll-undisclosed', 'Secret ballot?'),
        content: {
          kind: 'poll',
          poll: {
            question: 'Secret ballot?',
            answers: [
              { id: 'b1', text: 'Yes', votes: null, voters: null, selected: false },
              { id: 'b2', text: 'No', votes: null, voters: null, selected: false },
            ],
            max_selections: 1,
            undisclosed: true,
            ended_at: null,
            edited: false,
          },
        },
      },
    },
  ]);

  const poll = timeline.itemById('poll-undisclosed');
  await expect(poll.getByText('Results are hidden until the poll closes')).toBeVisible();
  await expect(poll.locator('.count')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /See who voted/ })).toHaveCount(0);
});
