import { execFileSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { SentryCli } from '@sentry/cli';

function exec(args) {
  execFileSync(SentryCli.getPath(), args, { stdio: 'inherit' });
}

// A runner loses its connection to sentry.io now and then, for longer than
// the CLI's own retries last, and that must not cost a finished build.
export async function runSentryCli(args, { attempts = 4, waitMs = 15_000, run = exec } = {}) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      run(args);
      return;
    } catch (error) {
      if (attempt === attempts) throw error;
      console.warn(`sentry-cli ${args.slice(0, 2).join(' ')} failed, trying again`);
      await sleep(waitMs);
    }
  }
}
