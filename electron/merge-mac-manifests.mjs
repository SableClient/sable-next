import { readFileSync, writeFileSync } from 'node:fs';
import { dump, load } from './yaml.mjs';

const [target, ...others] = process.argv.slice(2);
if (!target || others.length === 0) {
  throw new Error('Usage: merge-mac-manifests.mjs <target.yml> <other.yml>...');
}
const manifest = load(readFileSync(target, 'utf8'));
for (const path of others) {
  const other = load(readFileSync(path, 'utf8'));
  if (other.version !== manifest.version) {
    throw new Error(`${path} is for ${other.version}, not ${manifest.version}`);
  }
  const urls = new Set(manifest.files.map((file) => file.url));
  manifest.files.push(...other.files.filter((file) => !urls.has(file.url)));
}
writeFileSync(target, dump(manifest, { lineWidth: -1, noRefs: true }));
