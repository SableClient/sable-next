import type { CallParticipant } from './call-transport';

export type CallTileSource = 'camera' | 'screen';

export type CallTile = {
  key: string;
  participant: CallParticipant;
  source: CallTileSource;
};

export type CallGrid = { columns: number; width: number; height: number };

const visible = (participant: CallParticipant, track: CallParticipant['camera']): boolean =>
  track !== undefined && !track.muted && (participant.local === true || track.subscribed);

export function screenShareVisible(participant: CallParticipant): boolean {
  return visible(participant, participant.screenShare);
}

export function cameraVisible(participant: CallParticipant): boolean {
  return visible(participant, participant.camera);
}

export function callTiles(
  participants: readonly CallParticipant[],
  watchedScreenShareIds: readonly string[] = []
): CallTile[] {
  const tiles: CallTile[] = [];
  for (const participant of participants) {
    const base = `${participant.backendId ?? 'legacy'}:${participant.identity}`;
    tiles.push({ key: `${base}:camera`, participant, source: 'camera' });
    const screenShare = participant.screenShare;
    if (
      screenShareVisible(participant) &&
      screenShare &&
      (participant.local === true || watchedScreenShareIds.includes(screenShare.id))
    ) {
      tiles.push({ key: `${base}:screen`, participant, source: 'screen' });
    }
  }
  return tiles;
}

export function featuredTiles(tiles: readonly CallTile[], pinned: string | null): CallTile[] {
  if (pinned !== null) {
    const tile = tiles.find((candidate) => candidate.key === pinned);
    if (tile) return [tile];
  }
  const screens = tiles.filter((tile) => tile.source === 'screen');
  const remote = screens.filter((tile) => !tile.participant.local);
  return remote.length > 0 ? remote : screens;
}

export type CallPin = { pinned: string | null; gridForced: boolean };

const only = (tiles: readonly CallTile[], tile: CallTile): boolean =>
  tiles.length === 1 && tiles[0].key === tile.key;

export function togglePin(
  tiles: readonly CallTile[],
  featured: readonly CallTile[],
  tile: CallTile
): CallPin {
  if (!only(featured, tile)) return { pinned: tile.key, gridForced: false };
  return { pinned: null, gridForced: only(featuredTiles(tiles, null), tile) };
}

export const GRID_GAP_PX = 8;
export const NARROW_STAGE_PX = 560;

export function bestGrid(
  count: number,
  width: number,
  height: number,
  gap: number,
  aspect = 16 / 9
): CallGrid {
  let best: CallGrid = { columns: 1, width: 0, height: 0 };
  if (count <= 0 || width <= 0 || height <= 0) return best;
  for (let columns = 1; columns <= count; columns += 1) {
    const rows = Math.ceil(count / columns);
    const cellWidth = (width - gap * (columns - 1)) / columns;
    const cellHeight = (height - gap * (rows - 1)) / rows;
    if (cellWidth <= 0 || cellHeight <= 0) break;
    const tileWidth = Math.min(cellWidth, cellHeight * aspect);
    if (tileWidth > best.width) {
      best = { columns, width: tileWidth, height: tileWidth / aspect };
    }
  }
  return best;
}
