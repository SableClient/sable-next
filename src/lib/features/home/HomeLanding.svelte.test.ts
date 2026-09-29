// @vitest-environment happy-dom

import { render, screen } from '@testing-library/svelte';
import { expect, test } from 'vitest';

import HomeLanding from './HomeLanding.svelte';

test('opens Get support in the Sable general room', () => {
  render(HomeLanding, { titleKey: 'nav.unspaced' });

  expect(screen.getByRole('link', { name: 'Get support' })).toHaveAttribute(
    'href',
    '/to/%23general%3Asable.moe'
  );
  expect(screen.getByRole('link', { name: 'Get support' })).not.toHaveAttribute('target');
});
