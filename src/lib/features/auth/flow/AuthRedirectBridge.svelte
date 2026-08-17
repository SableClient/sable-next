<script lang="ts">
  import { onMount } from 'svelte';
  import { on } from 'svelte/events';
  import { invoke, isTauri } from '@tauri-apps/api/core';
  import { listen } from '@tauri-apps/api/event';
  import { callbackChannelName, redirectLoginType, scrubbedCallbackPath } from '$lib/auth/redirect';

  interface Props {
    onCallback: (url: string) => void;
    onRegistrationComplete: () => void;
    onCallbackWindow: () => void;
  }

  let { onCallback, onRegistrationComplete, onCallbackWindow }: Props = $props();
  let removeDeepLinkListener: (() => void) | undefined;
  let disposed = false;

  onMount(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key !== 'sable-registration-complete' || !event.newValue) return;
      localStorage.removeItem(event.key);
      onRegistrationComplete();
    };
    const offStorage = on(window, 'storage', onStorage);

    const callbackUrl = window.location.href;
    if (!isTauri() && redirectLoginType(callbackUrl)) {
      onCallbackWindow();
      const callbackChannel = new BroadcastChannel(callbackChannelName(callbackUrl, window.name));
      callbackChannel.postMessage(callbackUrl);
      callbackChannel.close();
      history.replaceState(history.state, '', scrubbedCallbackPath(callbackUrl));
      window.setTimeout(() => {
        window.close();
      }, 0);
    } else if (isTauri()) {
      void (async () => {
        try {
          const unlisten = await listen<string[]>('deep-link://new-url', (event) => {
            const url = event.payload.find((candidate) => redirectLoginType(candidate));
            if (url) onCallback(url);
          });
          if (disposed) {
            unlisten();
            return;
          }
          removeDeepLinkListener = unlisten;
          const urls = await invoke<string[] | null>('plugin:deep-link|get_current');
          const url = urls?.find((candidate) => redirectLoginType(candidate));
          if (url) onCallback(url);
        } catch {
          return;
        }
      })();
    }

    return () => {
      disposed = true;
      removeDeepLinkListener?.();
      offStorage();
    };
  });
</script>
