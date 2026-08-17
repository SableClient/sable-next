import { describe, expect, test } from 'vitest';

import { TimelineAnchor, type AnchorViewport } from './timeline-anchor';

/**
 * A scroll container with known row heights. Clamping matters: the browser
 * refuses to scroll past the top, and a restore that needed more room than
 * exists has to report that rather than claim success.
 */
class FakeViewport implements AnchorViewport {
  scrollTop = 0;

  constructor(
    private rows: { key: string; height: number }[],
    readonly height: number
  ) {}

  private offsetOf(key: string): number | null {
    let offset = 0;
    for (const row of this.rows) {
      if (row.key === key) return offset;
      offset += row.height;
    }
    return null;
  }

  private get contentHeight(): number {
    return this.rows.reduce((total, row) => total + row.height, 0);
  }

  topOf(key: string): number | null {
    const offset = this.offsetOf(key);
    return offset === null ? null : offset - this.scrollTop;
  }

  visibleRows(): readonly { key: string; top: number }[] {
    return this.rows
      .map((row) => ({
        key: row.key,
        top: this.topOf(row.key) ?? Number.POSITIVE_INFINITY,
        height: row.height,
      }))
      .filter((row) => row.top < this.height && row.top + row.height > 0)
      .map((row) => ({ key: row.key, top: row.top }));
  }

  scrollBy(delta: number): void {
    const max = Math.max(0, this.contentHeight - this.height);
    this.scrollTop = Math.min(max, Math.max(0, this.scrollTop + delta));
  }

  offset(): number {
    return this.scrollTop;
  }

  prepend(rows: { key: string; height: number }[]): void {
    this.rows = [...rows, ...this.rows];
  }

  replace(key: string, rows: { key: string; height: number }[]): void {
    this.rows = this.rows.flatMap((row) => (row.key === key ? rows : [row]));
  }

  resize(key: string, height: number): void {
    this.rows = this.rows.map((row) => (row.key === key ? { ...row, height } : row));
  }

  remove(key: string): void {
    this.rows = this.rows.filter((row) => row.key !== key);
  }
}

function rows(count: number, height: number, prefix = 'row'): { key: string; height: number }[] {
  return Array.from({ length: count }, (_, index) => ({
    key: `${prefix}-${String(index)}`,
    height,
  }));
}

describe('TimelineAnchor', () => {
  test('holds a visible row across a prepend of any height', () => {
    const viewport = new FakeViewport(rows(20, 50), 400);
    viewport.scrollTop = 300;
    const anchor = new TimelineAnchor(() => viewport);
    const before = viewport.topOf('row-8');

    anchor.capture();
    viewport.prepend(rows(25, 137, 'history'));

    expect(anchor.restore()).toBe(0);
    expect(viewport.topOf('row-8')).toBe(before);
  });

  test('a stationary correction puts back content that moved under the reader', () => {
    const viewport = new FakeViewport(rows(20, 50), 400);
    viewport.scrollTop = 300;
    const anchor = new TimelineAnchor(() => viewport);
    const before = viewport.topOf('row-8');

    anchor.capture();
    viewport.resize('row-1', 130);

    expect(anchor.restoreStationary()).toBe(0);
    expect(viewport.topOf('row-8')).toBe(before);
  });

  test('a stationary correction does not undo a scroll the reader made', () => {
    const viewport = new FakeViewport(rows(20, 50), 400);
    viewport.scrollTop = 300;
    const anchor = new TimelineAnchor(() => viewport);

    anchor.capture();
    viewport.scrollBy(-120);
    viewport.resize('row-1', 130);

    expect(anchor.restoreStationary()).toBeNull();
    expect(viewport.scrollTop).toBe(180);
  });

  test('a stationary correction re-captures, so the next change corrects again', () => {
    const viewport = new FakeViewport(rows(20, 50), 400);
    viewport.scrollTop = 300;
    const anchor = new TimelineAnchor(() => viewport);

    anchor.capture();
    viewport.scrollBy(-120);
    anchor.restoreStationary();
    const before = viewport.topOf('row-4');
    viewport.resize('row-0', 130);

    expect(anchor.restoreStationary()).toBe(0);
    expect(viewport.topOf('row-4')).toBe(before);
  });

  test('holds when the anchored rows turn out taller than estimated', () => {
    const viewport = new FakeViewport(rows(20, 50), 400);
    viewport.scrollTop = 300;
    const anchor = new TimelineAnchor(() => viewport);
    const before = viewport.topOf('row-8');

    anchor.capture();
    viewport.prepend(rows(10, 40, 'history'));
    anchor.restore();
    // Late measurement: the prepended rows were half their real height.
    for (const row of rows(10, 40, 'history')) viewport.resize(row.key, 90);

    expect(anchor.restore()).toBe(0);
    expect(viewport.topOf('row-8')).toBe(before);
  });

  test('falls back to the next candidate when the first row is replaced', () => {
    const viewport = new FakeViewport(rows(20, 50), 400);
    viewport.scrollTop = 300;
    const anchor = new TimelineAnchor(() => viewport);
    const before = viewport.topOf('row-7');

    anchor.capture();
    viewport.replace('row-6', [{ key: 'replacement', height: 50 }]);
    viewport.prepend(rows(5, 200, 'history'));

    expect(anchor.restore()).toBe(0);
    expect(viewport.topOf('row-7')).toBe(before);
    expect(anchor.held?.key).toBe('row-7');
  });

  test('reports a residual when the restore is clamped at the top', () => {
    const viewport = new FakeViewport(rows(20, 50), 400);
    viewport.prepend([{ key: 'header', height: 50 }]);
    const anchor = new TimelineAnchor(() => viewport);
    expect(viewport.topOf('row-0')).toBe(50);

    anchor.capture();
    // Holding row-0 at 50px now needs a negative scroll, which cannot happen.
    viewport.remove('header');

    expect(anchor.restore()).toBe(-50);
    expect(viewport.scrollTop).toBe(0);
  });

  test('does not write for sub-pixel drift', () => {
    const viewport = new FakeViewport(rows(20, 50), 400);
    viewport.scrollTop = 300;
    const anchor = new TimelineAnchor(() => viewport);

    anchor.capture();
    viewport.resize('row-0', 50.2);

    expect(anchor.restore()).toBeCloseTo(0.2, 5);
    expect(viewport.scrollTop).toBe(300);
  });

  test('is a no-op with nothing captured', () => {
    const viewport = new FakeViewport(rows(20, 50), 400);
    const anchor = new TimelineAnchor(() => viewport);

    expect(anchor.restore()).toBeNull();
    expect(anchor.held).toBeNull();
  });

  test('release drops the candidates', () => {
    const viewport = new FakeViewport(rows(20, 50), 400);
    viewport.scrollTop = 300;
    const anchor = new TimelineAnchor(() => viewport);

    anchor.capture();
    anchor.release();
    viewport.prepend(rows(5, 200, 'history'));

    expect(anchor.restore()).toBeNull();
    expect(viewport.scrollTop).toBe(300);
  });
});
