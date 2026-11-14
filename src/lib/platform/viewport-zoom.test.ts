// @vitest-environment happy-dom

import { afterEach, expect, test, vi } from 'vitest';
import { isNativeMobile } from './os';
import { lockNativeZoom } from './viewport-zoom';

vi.mock('./os', () => ({ isNativeMobile: vi.fn() }));

const CONTENT = 'width=device-width, initial-scale=1, viewport-fit=cover';

function viewport(): HTMLMetaElement {
  const meta = document.createElement('meta');
  meta.name = 'viewport';
  meta.content = CONTENT;
  document.head.append(meta);
  return meta;
}

afterEach(() => {
  document.head.replaceChildren();
});

test('the native mobile apps cannot be pinch zoomed', () => {
  vi.mocked(isNativeMobile).mockReturnValue(true);
  const meta = viewport();

  lockNativeZoom();

  expect(meta.content).toBe(`${CONTENT}, maximum-scale=1, user-scalable=no`);
});

test('a browser keeps pinch zoom', () => {
  vi.mocked(isNativeMobile).mockReturnValue(false);
  const meta = viewport();

  lockNativeZoom();

  expect(meta.content).toBe(CONTENT);
});
