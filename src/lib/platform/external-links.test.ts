// @vitest-environment happy-dom

import { afterEach, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ invoke: vi.fn().mockResolvedValue(undefined) }));

vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => true, invoke: mocks.invoke }));

import { externalLinkRequest } from './external-link-request.svelte';
import { followExternalLink } from './external-links';

afterEach(() => {
  externalLinkRequest.current = null;
  mocks.invoke.mockClear();
});

function click(href: string, target = '_blank'): MouseEvent {
  const anchor = document.createElement('a');
  anchor.href = href;
  anchor.target = target;
  const event = new MouseEvent('click', { button: 0, cancelable: true });
  followExternalLink(event, anchor);
  return event;
}

test.each(['https://example.org/', 'mailto:alice@example.org', 'tel:+15550100'])(
  'opens %s through the native opener',
  (href) => {
    const event = click(href);

    expect(event.defaultPrevented).toBe(true);
    expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith('open_external_url', { url: href });
  }
);

test('leaves an in-app link to the webview', () => {
  const event = click('https://example.org/', '');

  expect(event.defaultPrevented).toBe(false);
  expect(mocks.invoke).not.toHaveBeenCalled();
});

test('asks before handing an app link to the OS', () => {
  const event = click('discord://-/channels/1/2');

  expect(event.defaultPrevented).toBe(true);
  expect(mocks.invoke).not.toHaveBeenCalled();
  expect(externalLinkRequest.current).toBe('discord://-/channels/1/2');
});

test.each(['file:///etc/passwd', 'javascript:alert(1)', 'ms-msdt:/id'])(
  'swallows a click on %s',
  (href) => {
    const event = click(href);

    expect(event.defaultPrevented).toBe(true);
    expect(externalLinkRequest.current).toBeNull();
  }
);
