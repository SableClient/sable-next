interface EventPluginInternals {
  unregisterListener: (event: string, eventId: number) => void;
}

export function tolerateUnknownListeners(): void {
  const internals = (window as { __TAURI_EVENT_PLUGIN_INTERNALS__?: EventPluginInternals })
    .__TAURI_EVENT_PLUGIN_INTERNALS__;
  if (!internals) return;

  const unregister = internals.unregisterListener;
  internals.unregisterListener = (event, eventId) => {
    try {
      unregister(event, eventId);
    } catch (error) {
      console.debug('[sable platform] listener already gone', event, eventId, error);
    }
  };
}
