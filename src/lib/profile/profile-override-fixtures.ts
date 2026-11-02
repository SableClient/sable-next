import { onTestFinished, vi } from 'vitest';

import type { CoreClient } from '#lib/core/client.svelte.js';

import { profileOverrides } from './profile-overrides.svelte';

export async function giveNickname(userId: string, name: string): Promise<void> {
  profileOverrides.start({
    subscribeEvents: () => () => {},
    rpc: {
      account: {
        profileOverrides: () =>
          Promise.resolve({
            protection: 'sealed',
            can_seal: false,
            overrides: [
              {
                user_id: userId,
                display_name: { kind: 'set', value: name },
                avatar: { kind: 'unset' },
                color: { kind: 'unset' },
              },
            ],
          }),
      },
    },
  } as unknown as CoreClient);
  onTestFinished(() => {
    profileOverrides.stop();
  });
  await vi.waitFor(() => {
    if (!profileOverrides.of(userId)) throw new Error('override not loaded');
  });
}
