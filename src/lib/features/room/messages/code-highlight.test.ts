import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';

import { getConfig, pluginVersion } from '@arborium/arborium';

test('desktop CSP permits the highlighter host and grammar modules', () => {
  const config = JSON.parse(
    readFileSync(new URL('../../../../../src-tauri/tauri.conf.json', import.meta.url), 'utf8')
  ) as { app: { security: { csp: { 'script-src': string } } } };
  const sources: string[] = config.app.security.csp['script-src'].split(/\s+/);
  const cdn = getConfig().cdn;
  expect(cdn).toBe('jsdelivr');
  for (const module of [
    `arborium@${pluginVersion}/dist/arborium_host.js`,
    `rust@${pluginVersion}/grammar.js`,
  ]) {
    const url = new URL(`https://cdn.jsdelivr.net/npm/@arborium/${module}`);
    expect(
      sources.some((source) => {
        if (!source.startsWith('https://')) return false;
        const allowed = new URL(source);
        return allowed.origin === url.origin && url.pathname.startsWith(allowed.pathname);
      }),
      `CSP blocks ${url}`
    ).toBe(true);
  }
  expect(sources).not.toContain('https:');
  expect(sources).not.toContain('https://cdn.jsdelivr.net');
});
