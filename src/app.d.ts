declare global {
  namespace App {
    interface PageState {
      /** Settings opened as a shallow route over the page it was opened from. */
      settings?: { section: string; focus?: string };
      /** Inbox opened as a shallow route over the page it was opened from. */
      inbox?: true;
      /** Phone room-list drawer state, kept in history for native back gestures. */
      mobileDrawer?: 'open' | 'closed';
    }
  }

  interface ImportMetaEnv {
    /** Absent in self-hosted builds, which disables Sentry entirely. */
    readonly VITE_SENTRY_DSN?: string;
    readonly VITE_SENTRY_ENVIRONMENT?: string;
    readonly VITE_APP_VERSION?: string;
  }
}

export {};
