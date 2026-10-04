import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('#lib/supporter/config.js', () => ({
  supporterConfig: () =>
    Promise.resolve({
      serviceUrl: 'https://awards.test',
      keys: { '1': '6kpsY+KcUgq+9VB7Ey7F+ZVHdq6+vnuSQh7qaRRG0iw' },
    }),
}));
vi.mock('#lib/platform/external-auth.js', () => ({
  openExternalAuthUrl: vi.fn(() => Promise.resolve()),
}));
vi.mock('./service.js', () => ({
  startVerification: vi.fn(),
  fetchAwards: vi.fn(),
  refreshAwards: vi.fn(),
}));

import { createCoreStub } from '#lib/core/__mocks__/context.js';
import type { CoreClient } from '#lib/core/client.svelte.js';
import { openExternalAuthUrl } from '#lib/platform/external-auth.js';
import { SUPPORTER_FIELD } from '#lib/profile/fields.js';

import { EXPIRED, FIXTURE_USER, VALID } from './fixtures.js';
import { fetchAwards, refreshAwards, startVerification } from './service.js';
import { supporter } from './supporter.svelte.js';

const openId = { access_token: 'tok', matrix_server_name: 'example.org' };

function makeCore(awards: unknown[] | null) {
  const stub = createCoreStub({
    session: { user_id: FIXTURE_USER },
    userProfile: vi.fn(() =>
      Promise.resolve({ supporter_awards: awards && JSON.stringify(awards) })
    ),
    requestOpenIdToken: vi.fn(() => Promise.resolve(openId)),
    setProfileField: vi.fn(() => Promise.resolve()),
  });
  return { stub, core: stub as unknown as CoreClient };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(startVerification).mockResolvedValue(
    'https://opencollective.com/oauth/authorize?state=s'
  );
  vi.mocked(fetchAwards).mockResolvedValue([]);
});

afterEach(() => {
  supporter.stop();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('start', () => {
  test('shows the badge held in the profile field', async () => {
    const { core } = makeCore([VALID]);
    supporter.start(core);
    await vi.waitFor(() => {
      expect(supporter.badge?.label).toBe('Donor');
    });
    expect(refreshAwards).not.toHaveBeenCalled();
  });

  test('has no badge for a profile without awards', async () => {
    const { stub, core } = makeCore(null);
    supporter.start(core);
    await vi.waitFor(() => {
      expect(stub.userProfile).toHaveBeenCalled();
    });
    expect(supporter.badge).toBeNull();
    expect(refreshAwards).not.toHaveBeenCalled();
  });

  test('refreshes an award that has expired', async () => {
    vi.mocked(refreshAwards).mockResolvedValue([VALID]);
    const { stub, core } = makeCore([EXPIRED]);
    supporter.start(core);

    await vi.waitFor(() => {
      expect(supporter.badge?.label).toBe('Donor');
    });
    expect(stub.requestOpenIdToken).toHaveBeenCalledOnce();
    expect(stub.setProfileField).toHaveBeenCalledWith(SUPPORTER_FIELD, [VALID]);
    expect(supporter.status).toBe('idle');
  });

  test('keeps working when the service is unreachable', async () => {
    vi.mocked(refreshAwards).mockRejectedValue(new Error('offline'));
    const { stub, core } = makeCore([EXPIRED]);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    supporter.start(core);

    await vi.waitFor(() => {
      expect(supporter.status).toBe('failed');
    });
    expect(stub.setProfileField).not.toHaveBeenCalled();
  });
});

describe('verify', () => {
  test('opens Open Collective, polls, and stores the award once it appears', async () => {
    vi.mocked(fetchAwards).mockResolvedValueOnce([]).mockResolvedValue([VALID]);
    const { stub, core } = makeCore(null);
    supporter.start(core);
    await vi.waitFor(() => {
      expect(stub.userProfile).toHaveBeenCalled();
    });

    const done = supporter.verify();
    await vi.advanceTimersByTimeAsync(0);
    expect(supporter.status).toBe('waiting');
    expect(openExternalAuthUrl).toHaveBeenCalledWith(
      'https://opencollective.com/oauth/authorize?state=s'
    );
    expect(startVerification).toHaveBeenCalledWith('https://awards.test', openId);

    await vi.advanceTimersByTimeAsync(2000);
    expect(stub.setProfileField).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2000);
    await done;

    expect(stub.setProfileField).toHaveBeenCalledWith(SUPPORTER_FIELD, [VALID]);
    expect(supporter.badge?.label).toBe('Donor');
    expect(supporter.status).toBe('idle');
  });

  test('stops polling when cancelled', async () => {
    const { stub, core } = makeCore(null);
    supporter.start(core);
    await vi.waitFor(() => {
      expect(stub.userProfile).toHaveBeenCalled();
    });

    const done = supporter.verify();
    await vi.advanceTimersByTimeAsync(2000);
    supporter.cancel();
    await done;
    await vi.advanceTimersByTimeAsync(10_000);

    expect(supporter.status).toBe('idle');
    expect(vi.mocked(fetchAwards).mock.calls.length).toBeLessThanOrEqual(1);
    expect(stub.setProfileField).not.toHaveBeenCalled();
  });

  test('gives up after ten minutes', async () => {
    const { stub, core } = makeCore(null);
    supporter.start(core);
    await vi.waitFor(() => {
      expect(stub.userProfile).toHaveBeenCalled();
    });

    const done = supporter.verify();
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000 + 4000);
    await done;

    expect(supporter.status).toBe('failed');
    expect(stub.setProfileField).not.toHaveBeenCalled();
  });

  test('fails when the service refuses to start', async () => {
    vi.mocked(startVerification).mockRejectedValue(new Error('401'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { stub, core } = makeCore(null);
    supporter.start(core);
    await vi.waitFor(() => {
      expect(stub.userProfile).toHaveBeenCalled();
    });

    await supporter.verify();

    expect(supporter.status).toBe('failed');
    expect(openExternalAuthUrl).not.toHaveBeenCalled();
  });

  test('ignores an award it already holds', async () => {
    vi.mocked(fetchAwards).mockResolvedValue([VALID]);
    const { stub, core } = makeCore([VALID]);
    supporter.start(core);
    await vi.waitFor(() => {
      expect(supporter.badge).not.toBeNull();
    });

    const done = supporter.verify();
    await vi.advanceTimersByTimeAsync(2000);
    supporter.cancel();
    await done;

    expect(stub.setProfileField).not.toHaveBeenCalled();
  });
});

describe('claim', () => {
  test('stores an award that was issued by hand', async () => {
    vi.mocked(fetchAwards).mockResolvedValue([VALID]);
    const { stub, core } = makeCore(null);
    supporter.start(core);
    await vi.waitFor(() => {
      expect(stub.userProfile).toHaveBeenCalled();
    });

    await supporter.claim();

    expect(fetchAwards).toHaveBeenCalledWith('https://awards.test', FIXTURE_USER);
    expect(stub.setProfileField).toHaveBeenCalledWith(SUPPORTER_FIELD, [VALID]);
    expect(supporter.badge?.label).toBe('Donor');
    expect(supporter.status).toBe('idle');
  });

  test('says so when nothing was issued', async () => {
    const { stub, core } = makeCore(null);
    supporter.start(core);
    await vi.waitFor(() => {
      expect(stub.userProfile).toHaveBeenCalled();
    });

    await supporter.claim();

    expect(supporter.status).toBe('none');
    expect(stub.setProfileField).not.toHaveBeenCalled();
  });

  test('never contacts the service on its own', async () => {
    const { stub, core } = makeCore(null);
    supporter.start(core);
    await vi.waitFor(() => {
      expect(stub.userProfile).toHaveBeenCalled();
    });

    expect(fetchAwards).not.toHaveBeenCalled();
    expect(startVerification).not.toHaveBeenCalled();
  });

  test('fails when the lookup errors', async () => {
    vi.mocked(fetchAwards).mockRejectedValue(new Error('offline'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { stub, core } = makeCore(null);
    supporter.start(core);
    await vi.waitFor(() => {
      expect(stub.userProfile).toHaveBeenCalled();
    });

    await supporter.claim();

    expect(supporter.status).toBe('failed');
  });
});

describe('remove', () => {
  test('clears the profile field and the badge', async () => {
    const { stub, core } = makeCore([VALID]);
    supporter.start(core);
    await vi.waitFor(() => {
      expect(supporter.badge).not.toBeNull();
    });

    await supporter.remove();

    expect(stub.setProfileField).toHaveBeenCalledWith(SUPPORTER_FIELD, null);
    expect(supporter.badge).toBeNull();
  });
});
