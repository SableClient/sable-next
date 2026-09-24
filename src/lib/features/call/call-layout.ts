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

export function callTiles(participants: readonly CallParticipant[]): CallTile[] {
  const tiles: CallTile[] = [];
  for (const participant of participants) {
    const base = `${participant.backendId ?? 'legacy'}:${participant.identity}`;
    tiles.push({ key: `${base}:camera`, participant, source: 'camera' });
    if (screenShareVisible(participant)) {
      tiles.push({ key: `${base}:screen`, participant, source: 'screen' });
    }
  }
  return tiles;
}

export function spotlightTile(tiles: readonly CallTile[], pinned: string | null): CallTile | null {
  if (pinned !== null) {
    const tile = tiles.find((candidate) => candidate.key === pinned);
    if (tile) return tile;
  }
  const screens = tiles.filter((tile) => tile.source === 'screen');
  return screens.find((tile) => !tile.participant.local) ?? screens.at(0) ?? null;
}

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
