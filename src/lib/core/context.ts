import { createContext } from 'svelte';

import type { CoreClient } from './client.svelte';

export const [useCoreClient, provideCoreClient] = createContext<CoreClient>();
