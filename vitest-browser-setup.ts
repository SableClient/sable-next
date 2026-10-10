import { afterEach } from 'vitest';

import { resetNavigation } from '#lib/test-support/app-navigation.js';
import { resetPage } from '#lib/test-support/app-state.js';

afterEach(() => {
  resetPage();
  resetNavigation();
});
