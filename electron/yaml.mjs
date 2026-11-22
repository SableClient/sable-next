import { createRequire } from 'node:module';

// Use electron-builder's YAML parser.
const require = createRequire(import.meta.url);
const builderRequire = createRequire(require.resolve('electron-builder/package.json'));
export const { load, dump } = createRequire(builderRequire.resolve('app-builder-lib/package.json'))(
  'js-yaml'
);
