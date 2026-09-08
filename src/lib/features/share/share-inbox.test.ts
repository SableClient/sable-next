import { afterEach, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  drainSharedContent: vi.fn(() => Promise.resolve([])),
  receivesSharedContent: vi.fn(() => true),
  subscribeDeepLinks: vi.fn(),
  subscribeSharedContent: vi.fn(),
}));

vi.mock('#lib/platform/share-target.js', () => mocks);
vi.mock('#lib/platform/deep-links.js', () => ({
  subscribeDeepLinks: mocks.subscribeDeepLinks,
}));

import { ShareInbox, watchSharedContent } from './share-inbox.svelte';

type Stop = () => void | Promise<void>;

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

test.each([
  { name: 'settled listeners', late: false, rejects: false },
  { name: 'settled listeners with rejected cleanup', late: false, rejects: true },
  { name: 'listeners resolved after disposal with rejected cleanup', late: true, rejects: true },
])('disposes $name once', async ({ late, rejects }) => {
  const cleanupError = new TypeError("Cannot read properties of undefined (reading 'handlerId')");
  const stopShared = rejects ? vi.fn(() => Promise.reject(cleanupError)) : vi.fn();
  const stopDeep = vi.fn();
  vi.stubGlobal('document', {
    visibilityState: 'hidden',
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });

  let resolveShared!: (stop: Stop) => void;
  let resolveDeep!: (stop: Stop) => void;
  const shared = late
    ? new Promise<Stop>((resolve) => {
        resolveShared = resolve;
      })
    : Promise.resolve(stopShared);
  const deep = late
    ? new Promise<Stop>((resolve) => {
        resolveDeep = resolve;
      })
    : Promise.resolve(stopDeep);
  mocks.subscribeSharedContent.mockReturnValue(shared);
  mocks.subscribeDeepLinks.mockReturnValue(deep);
  if (rejects) vi.spyOn(console, 'debug').mockImplementation(() => {});

  const stop = watchSharedContent(new ShareInbox());
  if (late) {
    stop();
    resolveShared(stopShared);
    resolveDeep(stopDeep);
  } else {
    await vi.waitFor(() => {
      expect(mocks.subscribeSharedContent).toHaveBeenCalledOnce();
      expect(mocks.subscribeDeepLinks).toHaveBeenCalledOnce();
    });
    stop();
    await vi.waitFor(() => {
      expect(stopShared).toHaveBeenCalledOnce();
      expect(stopDeep).toHaveBeenCalledOnce();
    });
    stop();
  }

  await vi.waitFor(() => {
    expect(stopShared).toHaveBeenCalledOnce();
    expect(stopDeep).toHaveBeenCalledOnce();
  });
  if (rejects) {
    expect(console.debug).toHaveBeenCalledWith(
      '[sable share-target] listener cleanup failed',
      cleanupError
    );
  }
});
