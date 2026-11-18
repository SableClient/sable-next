import '@testing-library/jest-dom/vitest';
import '@testing-library/svelte/vitest';
import type { Window as HappyDOMWindow } from 'happy-dom';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tick } from 'svelte';
import { afterAll, afterEach } from 'vitest';

import { initSync } from '#src/generated/wasm/sable_model.js';

import { resetNavigation } from '#lib/test-support/app-navigation.js';
import { resetPage } from '#lib/test-support/app-state.js';

initSync({ module: readFileSync(join(process.cwd(), 'src/generated/wasm/sable_model_bg.wasm')) });

if (typeof Animation !== 'undefined') {
  // Browsers mark a cancelled animation's finished promise as handled; happy-dom does not.
  const cancel = Reflect.get(Animation.prototype, 'cancel');
  Animation.prototype.cancel = function (this: Animation) {
    this.finished.catch(() => {});
    cancel.call(this);
  };
}

if (typeof window !== 'undefined' && 'happyDOM' in window) {
  // Nothing serves happy-dom's origin, so fetching config.json would dump ECONNREFUSED.
  const { origin } = window.location;
  (window as unknown as HappyDOMWindow).happyDOM.settings.fetch.interceptor = {
    beforeAsyncRequest: ({ request, window: happyWindow }) =>
      Promise.resolve(
        new URL(request.url).origin === origin
          ? new happyWindow.Response(null, { status: 404 })
          : undefined
      ),
  };
}

afterEach(async () => {
  if (typeof document !== 'undefined') {
    // Overlay libraries style the body after a tick, which async mode defers to the next frame.
    await tick();
    document.body.removeAttribute('style');
  }
  resetPage();
  resetNavigation();
});

afterAll(async () => {
  await new Promise((resolve) => setTimeout(resolve, 32));
});
