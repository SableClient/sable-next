// @vitest-environment happy-dom

import { render, screen } from '@testing-library/svelte';
import { afterEach, expect, test } from 'vitest';

import { externalLinkRequest } from '#lib/platform/external-link-request.svelte.js';
import { followExternalLink } from '#lib/platform/external-links.js';

import TimelineLocation from './TimelineLocation.svelte';

afterEach(() => {
  externalLinkRequest.current = null;
});

test('location coordinates ask to open a map app without navigating the webview', () => {
  render(TimelineLocation, { body: 'Here', latitude: 48.8, longitude: 2.3 });
  const link = screen.getByRole<HTMLAnchorElement>('link', { name: /Here/ });
  const click = new MouseEvent('click', { bubbles: true, cancelable: true });

  followExternalLink(click, link);

  expect(click.defaultPrevented).toBe(true);
  expect(externalLinkRequest.current).toBe('geo:48.8,2.3');
});
