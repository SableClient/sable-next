import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const platformOptions = new Map([
  ['Web', ['web']],
  ['Desktop', ['windows', 'macos', 'linux']],
  ['Windows', ['windows']],
  ['macOS', ['macos']],
  ['Linux', ['linux']],
  ['Mobile', ['ios', 'android']],
  ['iOS', ['ios']],
  ['Android', ['android']],
  ['All', ['web', 'windows', 'macos', 'linux', 'ios', 'android']],
]);
const desktopLabels = ['windows', 'macos', 'linux'];
const mobileLabels = ['ios', 'android'];
const scopeLabels = new Map([
  ['web', 'platform/web'],
  ['desktop', 'platform/desktop'],
  ['mobile', 'platform/mobile'],
  ['web+desktop', 'platform/web-desktop'],
  ['web+mobile', 'platform/web-mobile'],
  ['desktop+mobile', 'platform/native'],
  ['web+desktop+mobile', 'platform/all'],
]);

export function selectedPlatformLabels(body) {
  const heading = /^(?:Platforms|What platforms have you experienced this issue on\?)\r?\n/;
  const section = body.split(/^### /m).find((part) => heading.test(part));
  if (!section) return [];

  const choices = section.replace(heading, '')
    .split(/[,\r\n]/)
    .map((choice) => choice.trim().replace(/^[-*]\s*/, ''));
  const selected = new Set(choices.flatMap((choice) => platformOptions.get(choice) ?? []));
  if (selected.size === 0) return [];

  const categories = [
    selected.has('web') && 'web',
    desktopLabels.some((label) => selected.has(label)) && 'desktop',
    mobileLabels.some((label) => selected.has(label)) && 'mobile',
  ].filter(Boolean);
  const scope = scopeLabels.get(categories.join('+'));
  return scope ? [scope] : [];
}

export async function main() {
  const { FORGEJO_EVENT_PATH: eventPath, FORGEJO_API_URL: apiUrl,
    FORGEJO_REPOSITORY: repository, FORGEJO_TOKEN: token } = process.env;
  if (!eventPath || !apiUrl || !repository || !token) {
    throw new Error('Missing Forgejo issue event or API environment');
  }

  const event = JSON.parse(await readFile(eventPath, 'utf8'));
  const issueNumber = event.issue?.number ?? event.number;
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
    throw new Error('Issue event does not contain an issue number');
  }

  const wanted = selectedPlatformLabels(event.issue?.body ?? '');
  if (wanted.length === 0) {
    console.log('No platform selected');
    return;
  }

  const [owner, repo] = repository.split('/');
  if (!owner || !repo) throw new Error('Invalid Forgejo repository');
  const repoPath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const baseApiUrl = apiUrl.replace(/\/$/, '');

  async function api(method, path, body) {
    const response = await fetch(`${baseApiUrl}${path}`, {
      method,
      headers: {
        Authorization: `token ${token}`,
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) throw new Error(`Forgejo API ${method} ${path}: HTTP ${response.status}`);
    return response.status === 204 ? null : response.json();
  }

  const existing = new Map();
  for (let page = 1; ; page += 1) {
    const labels = await api('GET', `${repoPath}/labels?limit=100&page=${page}`);
    for (const label of labels) existing.set(label.name, label);
    if (labels.length < 100) break;
  }

  const missing = wanted.filter((label) => !existing.has(label));
  if (missing.length > 0) {
    throw new Error(`Create these Forgejo labels before using the platform picker: ${missing.join(', ')}`);
  }

  const scope = wanted.find((label) => label.startsWith('platform/'));
  if (scope && existing.get(scope).exclusive !== true) {
    throw new Error(`Configure Forgejo label ${scope} as exclusive`);
  }

  const ids = wanted.map((label) => existing.get(label).id);
  await api('POST', `${repoPath}/issues/${issueNumber}/labels`, { labels: ids });
  console.log(`Applied ${wanted.join(', ')} to issue #${issueNumber}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
