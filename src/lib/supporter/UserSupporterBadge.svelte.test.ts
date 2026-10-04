// @vitest-environment happy-dom

import { render, screen } from '@testing-library/svelte';
import { expect, test, vi } from 'vitest';

vi.mock('#lib/supporter/config.js', () => ({
  supporterConfig: () =>
    Promise.resolve({
      serviceUrl: 'https://awards.test',
      keys: { '1': '6kpsY+KcUgq+9VB7Ey7F+ZVHdq6+vnuSQh7qaRRG0iw' },
    }),
}));

import { FIXTURE_USER, VALID } from './fixtures.js';
import UserSupporterBadge from './UserSupporterBadge.svelte';

test('shows the label of a verified award', async () => {
  render(UserSupporterBadge, { userId: FIXTURE_USER, awards: JSON.stringify([VALID]) });

  expect(await screen.findByText('Donor')).toBeInTheDocument();
  expect(screen.getByTitle('Backs Sable on Open Collective')).toBeInTheDocument();
});

test('shows nothing when the award belongs to another account', async () => {
  render(UserSupporterBadge, { userId: '@mallory:example.org', awards: JSON.stringify([VALID]) });

  await vi.waitFor(() => {
    expect(screen.queryByText('Donor')).not.toBeInTheDocument();
  });
});

test('shows nothing for a forged label', async () => {
  const forged = structuredClone(VALID);
  forged.signed.content.body = 'Founder';
  render(UserSupporterBadge, { userId: FIXTURE_USER, awards: JSON.stringify([forged]) });

  await vi.waitFor(() => {
    expect(screen.queryByText('Founder')).not.toBeInTheDocument();
  });
});
