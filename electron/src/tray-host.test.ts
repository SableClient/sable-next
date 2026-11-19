import { expect, test, vi } from 'vitest';

import { waitForTrayHost } from './tray-host';

test('waits until the desktop has a tray', async () => {
  const check = vi
    .fn<() => Promise<boolean | null>>()
    .mockResolvedValueOnce(false)
    .mockResolvedValueOnce(false)
    .mockResolvedValue(true);
  await waitForTrayHost('linux', check, 30, 0);
  expect(check).toHaveBeenCalledTimes(3);
});

test('does not wait when it cannot ask, or anywhere but Linux', async () => {
  const unknown = vi.fn<() => Promise<boolean | null>>().mockResolvedValue(null);
  await waitForTrayHost('linux', unknown, 30, 0);
  expect(unknown).toHaveBeenCalledOnce();

  const never = vi.fn<() => Promise<boolean | null>>().mockResolvedValue(false);
  await waitForTrayHost('win32', never, 30, 0);
  expect(never).not.toHaveBeenCalled();
});

test('gives up after its attempts so the tray is still tried', async () => {
  const check = vi.fn<() => Promise<boolean | null>>().mockResolvedValue(false);
  await waitForTrayHost('linux', check, 3, 0);
  expect(check).toHaveBeenCalledTimes(3);
});
