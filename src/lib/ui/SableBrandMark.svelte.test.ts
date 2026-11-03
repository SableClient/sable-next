// @vitest-environment happy-dom

import { render } from '@testing-library/svelte';
import { afterEach, expect, test, vi } from 'vitest';

const logoUrl = vi.hoisted(() => vi.fn<() => string | null>());
vi.mock('#lib/deployment/brand.js', () => ({ logoUrl }));

import SableBrandMark from './SableBrandMark.svelte';

afterEach(() => logoUrl.mockReset());

test('renders the configured logo as a decorative image with the caller class', () => {
  logoUrl.mockReturnValue('https://cdn.example/logo.png');
  const { container } = render(SableBrandMark, { class: 'big' });
  const img = container.querySelector('img');
  expect(img).toHaveAttribute('src', 'https://cdn.example/logo.png');
  expect(img).toHaveAttribute('alt', '');
  expect(img).toHaveClass('brand-mark', 'big');
});

test('falls back to the bundled logo', () => {
  logoUrl.mockReturnValue(null);
  const { container } = render(SableBrandMark);
  expect(container.querySelector('img')?.getAttribute('src')).toBeTruthy();
});
