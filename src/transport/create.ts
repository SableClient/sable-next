import { isTauri } from '@tauri-apps/api/core';

import type { Transport } from './index';
import { createTauriTransport } from './tauri';
import { createWebTransport } from './web';

export function createTransport(): Transport {
  return isTauri() ? createTauriTransport() : createWebTransport();
}
