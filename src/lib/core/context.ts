import { getContext, setContext } from 'svelte';

import type { CoreClient } from './client.svelte';

const CORE_CLIENT = Symbol('core-client');

export function provideCoreClient(client: CoreClient): void {
	setContext(CORE_CLIENT, client);
}

export function useCoreClient(): CoreClient {
	const client = getContext<CoreClient>(CORE_CLIENT);
	if (!client) throw new Error('Sable core has not been provided');
	return client;
}
