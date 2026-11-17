// Usage: github-dispatch.mjs <workflow-file> [input=value ...]

import { setTimeout as sleep } from 'node:timers/promises';

const REPOSITORY = 'SableClient/sable-next';
const ATTEMPTS = 5;

const [workflow, ...pairs] = process.argv.slice(2);
const token = process.env.GH_TOKEN;
if (!workflow) throw new Error('Usage: github-dispatch.mjs <workflow-file> [input=value ...]');
if (!token) throw new Error('GH_TOKEN is not set');

const inputs = Object.fromEntries(
  pairs.map((pair) => {
    const at = pair.indexOf('=');
    if (at <= 0) throw new Error(`Expected input=value, got: ${pair}`);
    return [pair.slice(0, at), pair.slice(at + 1)];
  })
);

const url = `https://api.github.com/repos/${REPOSITORY}/actions/workflows/${workflow}/dispatches`;
for (let attempt = 1; ; attempt++) {
  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: JSON.stringify({ ref: 'main', inputs }),
    });
  } catch (error) {
    if (attempt >= ATTEMPTS) throw error;
    console.warn(`Dispatch attempt ${attempt} failed: ${error.message}`);
    await sleep(attempt * 10_000);
    continue;
  }
  if (response.ok) break;
  const body = await response.text();
  if (response.status < 500 || attempt >= ATTEMPTS) {
    throw new Error(`Dispatching ${workflow} failed with HTTP ${response.status}: ${body}`);
  }
  console.warn(`Dispatch attempt ${attempt} got HTTP ${response.status}; retrying`);
  await sleep(attempt * 10_000);
}

console.log(`Dispatched ${workflow} on ${REPOSITORY} with ${JSON.stringify(inputs)}`);
