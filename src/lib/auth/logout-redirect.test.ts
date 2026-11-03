import { afterEach, expect, test, vi } from 'vitest';

import { redirectAfterLogout } from './logout-redirect.js';

const policy = vi.hoisted(() => ({ url: null as string | null }));
vi.mock('#lib/deployment/policy.js', () => ({ logoutRedirectUrl: () => policy.url }));

const assign = vi.fn();
vi.stubGlobal('window', { location: { assign } });

afterEach(() => {
  assign.mockReset();
  policy.url = null;
});

test('the deployment page replaces the post-logout route once no account remains', () => {
  policy.url = 'https://sso.acme.example/bye';
  redirectAfterLogout({ accounts: [] });
  expect(assign).toHaveBeenCalledWith('https://sso.acme.example/bye');
});

test('another signed-in account or no configured page keeps the normal behaviour', () => {
  policy.url = 'https://sso.acme.example/bye';
  redirectAfterLogout({ accounts: [{}] as never });
  policy.url = null;
  redirectAfterLogout({ accounts: [] });
  expect(assign).not.toHaveBeenCalled();
});
