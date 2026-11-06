import type { Browser, CDPSession } from '@playwright/test';

import type { PerfSnapshot } from '../../../src/worker/perf-stats';

export async function readCorePerf(browser: Browser): Promise<PerfSnapshot> {
  const cdp = await browser.newBrowserCDPSession();
  try {
    const { targetInfos } = await cdp.send('Target.getTargets');
    const worker = targetInfos.find(
      (target) => target.type === 'shared_worker' && target.url.includes('core.worker')
    );
    if (!worker) throw new Error('the core shared worker is not running');
    const { sessionId } = await cdp.send('Target.attachToTarget', {
      targetId: worker.targetId,
      flatten: false,
    });
    const reply = await evaluate(cdp, sessionId, 'JSON.stringify(self.__sablePerf())');
    return JSON.parse(reply) as PerfSnapshot;
  } finally {
    await cdp.detach();
  }
}

function evaluate(cdp: CDPSession, sessionId: string, expression: string): Promise<string> {
  const id = 1;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('the core worker did not answer'));
    }, 10_000);
    cdp.on('Target.receivedMessageFromTarget', ({ message }) => {
      const reply = JSON.parse(message) as {
        id?: number;
        result?: { result: { value: string } };
        error?: { message: string };
      };
      if (reply.id !== id) return;
      clearTimeout(timer);
      if (reply.result) resolve(reply.result.result.value);
      else reject(new Error(reply.error?.message ?? 'evaluate failed'));
    });
    void cdp
      .send('Target.sendMessageToTarget', {
        sessionId,
        message: JSON.stringify({
          id,
          method: 'Runtime.evaluate',
          params: { expression, returnByValue: true },
        }),
      })
      .catch(reject);
  });
}
