// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
declare global {
  namespace App {
    // interface Error {}
    // interface Locals {}
    // interface PageData {}
    interface PageState {
      /** Settings opened as a shallow route over the page it was opened from. */
      settings?: { section: string };
    }
    // interface Platform {}
  }

  interface ImportMetaEnv {
    /** Absent in self-hosted builds, which disables Sentry entirely. */
    readonly VITE_SENTRY_DSN?: string;
    readonly VITE_SENTRY_ENVIRONMENT?: string;
    readonly VITE_APP_VERSION?: string;
    /** All three absent leaves web push unregistered. */
    readonly VITE_PUSH_GATEWAY_URL?: string;
    readonly VITE_PUSH_WEB_APP_ID?: string;
    readonly VITE_PUSH_VAPID_KEY?: string;
  }
}

export {};
