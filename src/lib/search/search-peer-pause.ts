import type { SearchPeerPause } from '#src/generated/protocol';
import { isNativeMobile } from '#lib/platform/os.js';

/** Why sharing waits; only mobile apps have the setting that lifts a metered pause. */
export function searchPeerPauseKey(pause: SearchPeerPause): string {
  switch (pause) {
    case 'offline':
      return 'settings.searchPeerPausedOffline';
    case 'metered':
      return isNativeMobile()
        ? 'settings.searchPeerPausedMetered'
        : 'settings.searchPeerPausedMeteredNetwork';
    case 'background':
      return 'settings.searchPeerPausedBackground';
  }
}
