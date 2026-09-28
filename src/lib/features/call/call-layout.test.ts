import { describe, expect, it } from 'vitest';

import { bestGrid, callTiles, featuredTiles, togglePin } from './call-layout';
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

describe('featuredTiles', () => {
  const self: CallParticipant = { identity: 'me', local: true, screenShare: track() };
  const remote: CallParticipant = { identity: 'them', screenShare: track() };
  const keys = (tiles: { key: string }[]) => tiles.map((tile) => tile.key);

  it('features a remote screen over your own', () => {
    expect(keys(featuredTiles(callTiles([self, remote]), null))).toEqual(['legacy:them:screen']);
  });

  it('features every remote screen together', () => {
    const other: CallParticipant = { identity: 'other', screenShare: track() };
    expect(keys(featuredTiles(callTiles([self, remote, other]), null))).toEqual([
      'legacy:them:screen',
      'legacy:other:screen',
    ]);
  });

  it('features your own screen when it is the only one', () => {
    expect(keys(featuredTiles(callTiles([self, { identity: 'x' }]), null))).toEqual([
      'legacy:me:screen',
    ]);
  });

  it('prefers the pinned tile', () => {
    expect(keys(featuredTiles(callTiles([self, remote]), 'legacy:me:camera'))).toEqual([
      'legacy:me:camera',
    ]);
  });

  it('falls back to the grid when nothing is shared or pinned', () => {
    expect(featuredTiles(callTiles([{ identity: 'x' }]), 'gone')).toEqual([]);
  });
});

describe('togglePin', () => {
  const self: CallParticipant = { identity: 'me', local: true, screenShare: track() };
  const remote: CallParticipant = { identity: 'them', screenShare: track() };
  const tiles = callTiles([self, remote]);
  const tile = (key: string) => tiles.find((candidate) => candidate.key === key) ?? tiles[0];

  it('leaves for the grid when unpinning the screen shown on its own', () => {
    const shown = tile('legacy:them:screen');
    expect(togglePin(tiles, [shown], shown)).toEqual({ pinned: null, gridForced: true });
  });

  it('goes back to the shared screen when unpinning a pinned camera', () => {
    const camera = tile('legacy:me:camera');
    expect(togglePin(tiles, [camera], camera)).toEqual({ pinned: null, gridForced: false });
  });

  it('pins another tile over the spotlight', () => {
    const own = tile('legacy:me:screen');
    expect(togglePin(tiles, [tile('legacy:them:screen')], own)).toEqual({
      pinned: 'legacy:me:screen',
      gridForced: false,
    });
  });

  it('pins one of several featured screens', () => {
    const other: CallParticipant = { identity: 'other', screenShare: track() };
    const all = callTiles([self, remote, other]);
    const featured = featuredTiles(all, null);
    expect(togglePin(all, featured, featured[1])).toEqual({
      pinned: 'legacy:other:screen',
      gridForced: false,
    });
  });
});
