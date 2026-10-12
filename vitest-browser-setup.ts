import './src/styles.css';
import { afterEach } from 'vitest';

import { loadModel } from '#lib/model/model.js';
import { resetNavigation } from '#lib/test-support/app-navigation.js';
import { resetPage } from '#lib/test-support/app-state.js';

await loadModel();

afterEach(() => {
  resetPage();
  resetNavigation();
});
