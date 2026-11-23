import { expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';

import { expectScrollsInsideFrame } from '#lib/test-support/dialog-scroll.js';

const apps = Array.from({ length: 30 }, (_, index) => `App ${String(index)}`);

vi.mock('#lib/platform/overlay-back.svelte.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('#lib/platform/overlay-back.svelte.js')>()),
  holdOverlayBack: () => {},
}));
vi.mock('#lib/platform/screen-audio.js', () => ({
  listScreenAudioApps: () =>
    Promise.resolve({ status: 'available', apps: apps.map((id) => ({ id, label: id })) }),
  lastScreenAudioChoice: () => ({ kind: 'apps', include: [] }),
  screenAudioPicksMany: () => true,
  screenAudioSystemSupported: () => true,
  screenAudioCanExclude: () => true,
  screenAudioAppLabel: (id: string) => id,
}));

import ScreenShareAudioDialog from './ScreenShareAudioDialog.svelte';

test('many apps on a short window scroll inside the dialog, not the dialog itself', async () => {
  await page.viewport(1000, 500);
  await render(ScreenShareAudioDialog, { onShare: vi.fn(), onCancel: vi.fn() });
  await expect.element(page.getByRole('checkbox', { name: 'App 29' })).toBeInTheDocument();

  expectScrollsInsideFrame(page.getByRole('dialog').getByRole('list').element() as HTMLElement);
});
