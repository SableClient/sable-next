// @vitest-environment happy-dom

import { expect, test } from 'vitest';

import { overlayLayer } from './overlay-layer.js';

type Attach = (node: Element) => () => void;

function attachment(): Attach {
  const props = overlayLayer();
  return props[Object.getOwnPropertySymbols(props)[0]];
}

function attach(): { node: HTMLElement; detach: () => void } {
  const node = document.createElement('div');
  return { node, detach: attachment()(node) };
}

const depth = (node: Element): number => Number(node.getAttribute('data-overlay-depth'));
const rules = (): number =>
  [...document.head.querySelectorAll('style')].reduce(
    (sum, style) => sum + (style.textContent.match(/z-index/g)?.length ?? 0),
    0
  );

test('the newest surface is above every open one however they interleave', async () => {
  const stale = attach();
  for (let round = 0; round < 50; round += 1) {
    const a = attach();
    const b = attach();
    a.detach();
    const c = attach();
    await Promise.resolve();
    expect(depth(c.node)).toBeGreaterThan(depth(b.node));
    expect(depth(c.node)).toBeGreaterThan(depth(stale.node));
    b.detach();
    c.detach();
    await Promise.resolve();
  }
  expect(rules()).toBeLessThanOrEqual(4);
});

test('a surface that is never unmounted does not push later ones up forever', async () => {
  const stale = attach();
  for (let round = 0; round < 100; round += 1) {
    attach().detach();
    await Promise.resolve();
  }
  const newest = attach();
  expect(depth(newest.node)).toBe(depth(stale.node) + 1);
});

test('re-evaluating an attachment keeps the surface below one opened after it', async () => {
  const first = attach();
  const second = attach();
  const fn = attachment();
  const release = fn(first.node);
  release();
  fn(first.node);
  await Promise.resolve();
  expect(depth(second.node)).toBeGreaterThan(depth(first.node));
});
