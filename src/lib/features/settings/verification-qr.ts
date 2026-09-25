import type { QrCodeView } from '#src/generated/protocol';

export const QUIET_ZONE = 4;
const LOGO_SHARE = 0.22;

export interface QrLayout {
  size: number;
  dark: [number, number][];
  logo: { start: number; size: number };
  plate: { centre: number; radius: number };
}

export function qrLayout(code: QrCodeView): QrLayout {
  const size = code.width + QUIET_ZONE * 2;
  const logoSize = Math.round(code.width * LOGO_SHARE);
  const centre = size / 2;
  const radius = logoSize / 2 + 1;
  const dark: [number, number][] = [];
  for (let y = 0; y < code.width; y += 1) {
    for (let x = 0; x < code.width; x += 1) {
      if (code.modules[y * code.width + x] !== '1') continue;
      const left = x + QUIET_ZONE;
      const top = y + QUIET_ZONE;
      if (Math.hypot(left + 0.5 - centre, top + 0.5 - centre) < radius) continue;
      dark.push([left, top]);
    }
  }
  return {
    size,
    dark,
    logo: { start: QUIET_ZONE + (code.width - logoSize) / 2, size: logoSize },
    plate: { centre, radius },
  };
}
