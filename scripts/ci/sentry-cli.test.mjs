import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runSentryCli } from './sentry-cli.mjs';

function failing(times) {
  let calls = 0;
  const run = () => {
    calls += 1;
    if (calls <= times) throw new Error('SSL connect error');
  };
  return { run, calls: () => calls };
}

test('runs an upload again after it fails', async () => {
  const flaky = failing(2);
  await runSentryCli(['sourcemaps', 'upload'], { waitMs: 0, run: flaky.run });
  assert.equal(flaky.calls(), 3);
});

test('gives up once the attempts are spent', async () => {
  const down = failing(Infinity);
  await assert.rejects(
    runSentryCli(['debug-files', 'upload'], { attempts: 3, waitMs: 0, run: down.run }),
    /SSL connect error/
  );
  assert.equal(down.calls(), 3);
});
