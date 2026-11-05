import type { CallSupportView } from '#src/generated/protocol';
import type { CoreClient } from '#lib/core/client.svelte.js';
import { runtimeConfig } from '#lib/config/runtime-config.js';
import { preferences } from '#lib/settings/preferences.svelte.js';
import { callServiceUrl } from '#lib/features/call/call-service-url.js';

/** No member count yet means unknown, so a large room never flashes the button while loading. */
export function offersCall(room: {
  direct: boolean;
  participants: number;
  members: number;
  alwaysShow: boolean;
}): boolean {
  return (
    room.direct ||
    room.participants > 0 ||
    room.alwaysShow ||
    (room.members > 0 && room.members <= 10)
  );
}

export class RoomCallSupport {
  current = $state<CallSupportView | null>(null);
  #deploymentFallback = $state<string | null>(null);
  fallbackUrl = $derived(callServiceUrl(preferences.callServiceUrl) ?? this.#deploymentFallback);

  constructor(core: Pick<CoreClient, 'rpc'>, roomId: () => string) {
    $effect(() => {
      void runtimeConfig().then((config) => {
        this.#deploymentFallback = config.calls.livekitServiceUrl;
      });
    });

    $effect(() => {
      const target = roomId();
      const fallback = this.fallbackUrl;
      if (!target) return;

      let current = true;
      this.current = null;
      if (typeof RTCPeerConnection === 'undefined') return;

      void core.rpc.calls
        .support({ room_id: target, livekit_service_url: fallback })
        .then((next) => {
          if (current) this.current = next;
        })
        .catch((error: unknown) => {
          console.debug('[sable room] call support unavailable', error);
        });
      return () => {
        current = false;
      };
    });
  }
}
