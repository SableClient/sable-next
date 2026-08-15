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
}

export {};
