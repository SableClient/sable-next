import { untrack } from 'svelte';

export const bannerSuppression = $state({ count: 0 });

export function suppressBanners(): () => void {
  untrack(() => {
    bannerSuppression.count += 1;
  });
  return () => {
    untrack(() => {
      bannerSuppression.count -= 1;
    });
  };
}
