import { afterEach, expect, test, vi } from 'vitest';

const toasts = vi.hoisted(() => ({ info: vi.fn(), error: vi.fn() }));
vi.mock('#lib/ui/toasts.svelte.js', () => ({ toasts }));

import { CoreError } from '#src/transport';

import { sendReport } from './report';

afterEach(() => {
  vi.clearAllMocks();
});

test('confirms a report the homeserver took', async () => {
  await sendReport(() => Promise.resolve());

  expect(toasts.info).toHaveBeenCalledWith('Report sent');
  expect(toasts.error).not.toHaveBeenCalled();
});

test('says so when the homeserver does not take this kind of report', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  await sendReport(() => Promise.reject(new CoreError({ code: 'unsupported' })));

  expect(toasts.error).toHaveBeenCalledWith("Your homeserver can't take this kind of report.");
});
