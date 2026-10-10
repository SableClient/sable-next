import { afterEach, expect, test, vi } from 'vitest';

import { instrumentSelfWrites, sampleGesture } from './timeline-probe';

const PROBE_HTML =
  '<div id="probe" style="height:300px;overflow:auto;position:relative"><div style="height:2000px"><div class="item" data-event-id="probe" style="position:absolute;top:600px">Reader</div></div></div>';

afterEach(() => {
  document.body.replaceChildren();
});

function mountProbe(html: string): HTMLElement {
  document.body.innerHTML = html;
  const viewport = document.querySelector<HTMLElement>('#probe');
  if (!viewport) throw new Error('the probe is not rendered');
  return viewport;
}

async function startSampling(viewport: HTMLElement, frames: number, quietFrames: number) {
  window.__e2eGestureReady = false;
  window.__e2eGestureActive = true;
  const result = sampleGesture(viewport, { frames, quietFrames });
  await vi.waitFor(() => {
    expect(window.__e2eGestureReady).toBe(true);
  });
  return {
    finish() {
      window.__e2eGestureActive = false;
      return result;
    },
  };
}

const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));

test('the gesture sampler catches a scrollTo jump and return', async () => {
  const viewport = mountProbe(PROBE_HTML);
  viewport.scrollTop = 400;
  instrumentSelfWrites(viewport);
  const sampling = await startSampling(viewport, 20, 6);

  viewport.scrollTo(0, 500);
  await frame();
  await frame();
  viewport.scrollTo({ top: 400 });
  const result = await sampling.finish();

  expect(result.readerMovement).toBeCloseTo(0, 3);
  expect(result.frameError).toBeCloseTo(100, 3);
});

test('the gesture sampler flags smooth programmatic scrolling', async () => {
  const viewport = mountProbe(PROBE_HTML);
  viewport.scrollTop = 400;
  instrumentSelfWrites(viewport);
  const sampling = await startSampling(viewport, 20, 6);

  viewport.scrollTo({ top: 500, behavior: 'smooth' });

  expect((await sampling.finish()).unexpectedScrolls).toEqual(['scrollTo']);
});

test('the gesture sampler distinguishes a canvas resize clamp from reader movement', async () => {
  const viewport = mountProbe(
    '<div id="probe" style="height:200px;overflow:auto"><div class="items" style="height:800px;position:relative"><div class="item" data-event-id="reader" style="position:absolute;top:600px;height:40px">Reader</div></div></div>'
  );
  viewport.scrollTop = 600;
  instrumentSelfWrites(viewport);
  const sampling = await startSampling(viewport, 20, 6);

  const canvas = viewport.querySelector<HTMLElement>('.items');
  const row = viewport.querySelector<HTMLElement>('.item');
  if (!canvas || !row) throw new Error('missing probe content');
  canvas.style.height = '700px';
  row.style.top = '500px';
  const result = await sampling.finish();

  expect(result.readerMovement).toBe(0);
  expect(result.frameError).toBe(0);
});

test('the gesture sampler keeps sampling between input events', async () => {
  const viewport = mountProbe(PROBE_HTML);
  viewport.scrollTop = 400;
  instrumentSelfWrites(viewport);
  const sampling = await startSampling(viewport, 60, 2);

  const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop');
  if (!descriptor?.set) throw new Error('missing native scrollTop setter');
  descriptor.set.call(viewport, 500);
  for (let index = 0; index < 6; index += 1) await frame();
  descriptor.set.call(viewport, 600);
  const result = await sampling.finish();

  expect(result.readerMovement).toBeCloseTo(200, 3);
  expect(result.frameError).toBeCloseTo(0, 3);
});
