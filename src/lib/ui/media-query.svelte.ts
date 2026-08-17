import { MediaQuery } from 'svelte/reactivity';

export function createMediaQuery(query: string, initialMatches?: boolean) {
  const mediaQuery = new MediaQuery(query, initialMatches);

  return {
    get matches() {
      return mediaQuery.current;
    },
  };
}
