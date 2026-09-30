(() => {
  if (window.top !== window) return;
  const invoke = window.__TAURI_INTERNALS__?.invoke;
  if (!invoke) return;

  function format(value) {
    try {
      if (value instanceof Error) return value.stack || value.toString();
      if (typeof value === 'string') return value;
      return (
        JSON.stringify(value, (_key, entry) =>
          typeof entry === 'bigint' ? String(entry) : entry
        ) ?? String(value)
      );
    } catch {
      try {
        return String(value);
      } catch {
        return '[unprintable]';
      }
    }
  }

  for (const level of ['log', 'info', 'warn', 'error', 'debug', 'trace']) {
    const original = console[level];
    console[level] = function (...args) {
      original.apply(console, args);
      try {
        void invoke('log_console', { level, message: args.map(format).join(' ') }).catch(() => {});
      } catch {
        // IPC may be closed.
      }
    };
  }
})();
