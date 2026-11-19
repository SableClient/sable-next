// @vitest-environment happy-dom

import { beforeEach, expect, test, vi } from 'vitest';

const app = vi.hoisted(() => ({
  goto: vi.fn<(url: string, options: object) => Promise<void>>(() => Promise.resolve()),
  page: { state: {} } as { state: App.PageState },
}));
vi.mock('$app/navigation', () => ({ goto: app.goto }));
vi.mock('$app/paths', () => ({ resolve: (path: string) => `/${path}` }));
vi.mock('$app/state', () => ({ page: app.page }));

import {
  followSettingsLink,
  selectSettingsSection,
  settingsState,
  showSettingsOver,
} from './settings-navigation';

const click = () => new MouseEvent('click', { button: 0, cancelable: true });

beforeEach(() => {
  app.goto.mockClear();
  app.page.state = {};
});

test('settings opened over a page keep the overlay depth of that page', () => {
  app.page.state = { overlay: 1, mobileDrawer: 'open' };

  expect(settingsState('account')).toEqual({ overlay: 1, settings: { section: 'account' } });
});

test('every way into shallow settings carries the overlay depth', () => {
  app.page.state = { overlay: 2 };

  showSettingsOver('account');
  selectSettingsSection(click(), 'appearance');
  followSettingsLink(click(), 'calls', 'call-input-mode', true);

  expect(app.goto.mock.calls.map(([, options]) => options)).toEqual([
    { shallow: true, state: { overlay: 2, settings: { section: 'account' } } },
    { shallow: true, replace: true, state: { overlay: 2, settings: { section: 'appearance' } } },
    {
      shallow: true,
      state: { overlay: 2, settings: { section: 'calls', focus: 'call-input-mode' } },
    },
  ]);
});
