export function createMediaQuery(
  query: string,
  initialMatches = typeof window !== 'undefined' && window.matchMedia(query).matches
) {
  let matches = $state(initialMatches);

  $effect(() => {
    if (typeof window === 'undefined') return;

    const mediaQuery = window.matchMedia(query);
    const update = () => {
      matches = mediaQuery.matches;
    };

    update();
    mediaQuery.addEventListener('change', update);
    return () => {
      mediaQuery.removeEventListener('change', update);
    };
  });

  return {
    get matches() {
      return matches;
    },
  };
}
