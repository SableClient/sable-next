// @vitest-environment happy-dom

import { render, screen } from '@testing-library/svelte';
import { expect, test, vi } from 'vitest';

vi.mock('#lib/core/context.js');
vi.mock('$app/navigation', () => import('#lib/test-support/app-navigation.js'));
vi.mock('$app/state', async () => {
  const { SvelteURL } = await import('svelte/reactivity');
  return {
    page: {
      url: new SvelteURL('http://localhost/reset-password?server=a.example'),
      route: { id: '/(auth)/reset-password' },
    },
  };
});

import { page } from '$app/state';
import { core } from '#lib/core/__mocks__/context.js';
import Page from './+page.svelte';

test('follows a homeserver change in the URL', async () => {
  const loginFlows = vi.fn(() =>
    Promise.resolve({ password: true, oidc: false, sso: false, sso_identity_providers: [] })
  );
  Object.assign(core, { status: 'ready', loginFlows });
  render(Page);

  expect(await screen.findByText(/a\.example/)).toBeInTheDocument();
  const form = document.querySelector('main');

  (page.url as { search: string }).search = '?server=b.example';

  expect(await screen.findByText(/b\.example/)).toBeInTheDocument();
  expect(loginFlows).toHaveBeenLastCalledWith('b.example');
  expect(document.querySelector('main')).toBe(form);
});
