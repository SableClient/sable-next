import { preferences } from '#lib/settings/preferences.svelte.js';

export function followMicrophoneVolume(apply: (volume: number) => void): () => void {
  apply(preferences.microphoneVolume);
  return $effect.root(() => {
    $effect(() => {
      apply(preferences.microphoneVolume);
    });
  });
}
