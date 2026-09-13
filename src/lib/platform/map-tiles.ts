import { convertFileSrc, isTauri } from '@tauri-apps/api/core';

const OSM_TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const TILE_URI_SCHEME = 'sable-tiles';

export const TILE_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';

export function tileUrl(): string {
  return isTauri() ? `${convertFileSrc('', TILE_URI_SCHEME)}{z}/{x}/{y}.png` : OSM_TILE_URL;
}
