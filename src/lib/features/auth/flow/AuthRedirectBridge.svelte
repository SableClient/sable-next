<script lang="ts">
  import { onMount } from 'svelte';
  import { on } from 'svelte/events';

  import {
    callbackChannelName,
    redirectLoginType,
    scrubbedCallbackPath,
  } from '#lib/auth/redirect.js';
  import {
    currentDeepLinks,
    deliversDeepLinks,
    subscribeDeepLinks,
  } from '#lib/platform/deep-links.js';

  interface Props {
    onCallback: (url: string) => void;
    onRegistrationComplete: () => void;
    onCallbackWindow: () => void;
  }

  let { onCallback, onRegistrationComplete, onCallbackWindow }: Props = $props();
  let removeDeepLinkListener: (() => void) | undefined;
  let disposed = false;

  function handOffCallbackWindow(callbackUrl: string): void {
    onCallbackWindow();
    const callbackChannel = new BroadcastChannel(callbackChannelName(callbackUrl, window.name));
    callbackChannel.postMessage(callbackUrl);
    callbackChannel.close();
    history.replaceState(history.state, '', scrubbedCallbackPath(callbackUrl));
    window.setTimeout(() => {
      window.close();
    }, 0);
  }

  async function watchDeepLinks(): Promise<void> {
    const unlisten = await subscribeDeepLinks((urls) => {
      const url = urls.find((candidate) => redirectLoginType(candidate));
      if (url) onCallback(url);
    });

    if (disposed) {
      unlisten();
      return;
    }
    removeDeepLinkListener = unlisten;

    const url = (await currentDeepLinks()).find((candidate) => redirectLoginType(candidate));
    if (url) onCallback(url);
  }

  onMount(() => {
    const offStorage = on(window, 'storage', (event: StorageEvent) => {
      if (event.key !== 'sable-registration-complete' || !event.newValue) return;
      localStorage.removeItem(event.key);
      onRegistrationComplete();
    });

    const callbackUrl = window.location.href;
    if (deliversDeepLinks()) void watchDeepLinks();
    else if (redirectLoginType(callbackUrl)) handOffCallbackWindow(callbackUrl);

    return () => {
      disposed = true;
      removeDeepLinkListener?.();
      offStorage();
    };
  });
</script>
