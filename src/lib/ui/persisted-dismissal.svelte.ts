function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function persistedDismissal(key: string) {
  let dismissedFor = $state(read(key));

  return {
    get dismissedFor() {
      return dismissedFor;
    },
    dismiss(id: string | null): void {
      dismissedFor = id;
      try {
        if (id !== null) localStorage.setItem(key, id);
      } catch (error) {
        console.debug('[sable settings] dismissal not persisted', error);
      }
    },
  };
}
