import { describe, expect, it } from 'vitest';

import { bestGrid, callTiles, spotlightTile } from './call-layout';
import type { CallParticipant } from './call-transport';

const track = (muted = false) => ({ id: 't', muted, subscribed: true });

describe('bestGrid', () => {
  it('fills a wide stage with one 16:9 tile bounded by height', () => {
    expect(bestGrid(1, 1600, 450, 8)).toEqual({ columns: 1, width: 800, height: 450 });
  });

  it('puts two tiles side by side on a wide stage', () => {
    expect(bestGrid(2, 1600, 900, 8).columns).toBe(2);
  });

  it('stacks two tiles on a tall stage', () => {
    expect(bestGrid(2, 400, 900, 8).columns).toBe(1);
  });

  it('uses a 3x3 grid for nine tiles on a 16:9 stage', () => {
    expect(bestGrid(9, 1600, 900, 8).columns).toBe(3);
  });

  it('returns an empty grid before the stage is measured', () => {
    expect(bestGrid(3, 0, 0, 8).width).toBe(0);
  });
});

describe('callTiles', () => {
  it('adds a separate screen tile next to the camera tile', () => {
    const sharer: CallParticipant = { identity: 'a', screenShare: track() };
    const other: CallParticipant = { identity: 'b', screenShare: track(true) };
    expect(callTiles([sharer, other]).map((tile) => tile.key)).toEqual([
      'legacy:a:camera',
      'legacy:a:screen',
      'legacy:b:camera',
    ]);
  });
});

describe('spotlightTile', () => {
  const self: CallParticipant = { identity: 'me', local: true, screenShare: track() };
  const remote: CallParticipant = { identity: 'them', screenShare: track() };

  it('spotlights a remote screen over your own', () => {
    expect(spotlightTile(callTiles([self, remote]), null)?.key).toBe('legacy:them:screen');
  });

  it('prefers the pinned tile', () => {
    expect(spotlightTile(callTiles([self, remote]), 'legacy:me:camera')?.key).toBe(
      'legacy:me:camera'
    );
  });

  it('falls back to the grid when nothing is shared or pinned', () => {
    expect(spotlightTile(callTiles([{ identity: 'x' }]), 'gone')).toBeNull();
  });
});
