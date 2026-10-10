import { afterEach, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';

import type { ProfileView } from '#src/generated/protocol';

vi.mock('#lib/core/context.js', async () => {
  const mock = await import('#lib/core/__mocks__/context.js');
  return { useCoreClient: () => mock.core, provideCoreClient: vi.fn() };
});

import { core } from '#lib/core/__mocks__/context.js';

import ExtendedProfileSettings from './ExtendedProfileSettings.svelte';

afterEach(async () => {
  await page.viewport(414, 800);
});

const profile: ProfileView = {
  user_id: '@me:example.org',
  display_name: 'Me',
  avatar_url: null,
  bio: null,
  hero_color: null,
  hero_brightness: null,
  banner_url: null,
  status: null,
  pronouns: [],
  timezone: null,
  name_color_light: null,
  name_color_dark: null,
  animal: null,
  extra: [],
  supporter_awards: null,
  legacy_fields: [],
};

test('a long blocked user ID stays inside its settings section', async () => {
  await page.viewport(412, 915);
  Object.assign(core, {
    session: { user_id: '@me:example.org' },
    accountContacts: vi.fn().mockResolvedValue([]),
    ignoredUsers: vi.fn().mockResolvedValue([]),
    setUserIgnored: vi.fn().mockResolvedValue(undefined),
  });
  core.commands = core;
  const screen = await render(ExtendedProfileSettings, { profile });

  await userEvent.fill(
    screen.getByPlaceholder('@user:example.org').element(),
    `@${'a'.repeat(160)}:example.org`
  );
  await userEvent.click(screen.getByRole('button', { name: 'Block', exact: true }));

  await expect.poll(() => document.querySelector('.ignored-users')).not.toBeNull();
  const section = document.querySelector('.ignored-users')?.closest('section');
  if (!section) throw new Error('the blocked list has no section');
  expect(section.scrollWidth).toBeLessThanOrEqual(section.clientWidth);
});
