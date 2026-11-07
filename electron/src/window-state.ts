import { mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Rectangle } from 'electron';
import * as v from 'valibot';
import { sync as writeFileAtomicSync } from 'write-file-atomic';

export interface WindowState extends Rectangle {
  maximized: boolean;
  fullscreen: boolean;
}

export const MIN_WIDTH = 400;
export const MIN_HEIGHT = 400;

const Coordinate = v.pipe(v.number(), v.finite(), v.transform(Math.round));
const WindowStateSchema = v.object({
  x: Coordinate,
  y: Coordinate,
  width: v.pipe(Coordinate, v.minValue(1)),
  height: v.pipe(Coordinate, v.minValue(1)),
  maximized: v.fallback(v.boolean(), false),
  fullscreen: v.fallback(v.boolean(), false),
});

export function sanitizeWindowState(value: unknown): WindowState | undefined {
  const result = v.safeParse(WindowStateSchema, value);
  return result.success ? result.output : undefined;
}

export function readWindowState(path: string): WindowState | undefined {
  try {
    return sanitizeWindowState(JSON.parse(readFileSync(path, 'utf8')));
  } catch {
    return undefined;
  }
}

export function writeWindowState(path: string, state: WindowState): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileAtomicSync(path, JSON.stringify(state));
  } catch (error) {
    console.error('[sable window] could not save the window state', error);
  }
}

function overlap(a: Rectangle, b: Rectangle): number {
  const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return width > 0 && height > 0 ? width * height : 0;
}

export function windowStateOnScreen(
  state: WindowState,
  workAreas: readonly Rectangle[]
): WindowState | undefined {
  let area: Rectangle | undefined;
  let overlapWithArea = 0;
  for (const candidate of workAreas) {
    const shared = overlap(state, candidate);
    if (shared > overlapWithArea) {
      area = candidate;
      overlapWithArea = shared;
    }
  }
  if (!area) return undefined;

  const width = Math.min(state.width, area.width);
  const height = Math.min(state.height, area.height);
  return {
    ...state,
    x: Math.min(Math.max(state.x, area.x), area.x + area.width - width),
    y: Math.min(Math.max(state.y, area.y), area.y + area.height - height),
    width,
    height,
  };
}
