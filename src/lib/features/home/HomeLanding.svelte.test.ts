// @vitest-environment happy-dom

import { render, screen } from '@testing-library/svelte';
import { expect, test } from 'vitest';

import HomeLanding from './HomeLanding.svelte';

test('links Get support to the Sable general room', () => {
  render(HomeLanding, { titleKey: 'nav.unspaced' });

  expect(screen.getByRole('link', { name: 'Get support' })).toHaveAttribute(
    'href',
    'https://matrix.to/#/%23general%3Asable.moe'
  );
});
