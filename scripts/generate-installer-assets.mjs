#!/usr/bin/env node
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync, inflateSync } from 'node:zlib';

const root = fileURLToPath(new URL('..', import.meta.url));
const outDir = join(root, 'src-tauri', 'icons', 'installer');
const iconPath = join(root, 'src-tauri', 'icons', 'icon.png');

const BG = [0x24, 0x23, 0x2c, 255];
const ACCENT = [0x99, 0x87, 0xf7, 255];
const MUTED = [0x40, 0x3f, 0x4c, 255];
const ARROW = [0xbd, 0xb6, 0xec, 180];

function solid(width, height, color = BG) {
  const data = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    data[i * 4] = color[0];
    data[i * 4 + 1] = color[1];
    data[i * 4 + 2] = color[2];
    data[i * 4 + 3] = color[3];
  }
  return { width, height, data };
}

function setPixel(img, x, y, color) {
  if (x < 0 || y < 0 || x >= img.width || y >= img.height) return;
  const i = (y * img.width + x) * 4;
  const srcA = color[3] / 255;
  if (srcA >= 1) {
    img.data[i] = color[0];
    img.data[i + 1] = color[1];
    img.data[i + 2] = color[2];
    img.data[i + 3] = 255;
    return;
  }
  const dstA = img.data[i + 3] / 255;
  const outA = srcA + dstA * (1 - srcA);
  if (outA <= 0) return;
  img.data[i] = Math.round((color[0] * srcA + img.data[i] * dstA * (1 - srcA)) / outA);
  img.data[i + 1] = Math.round((color[1] * srcA + img.data[i + 1] * dstA * (1 - srcA)) / outA);
  img.data[i + 2] = Math.round((color[2] * srcA + img.data[i + 2] * dstA * (1 - srcA)) / outA);
  img.data[i + 3] = Math.round(outA * 255);
}

function fillRect(img, x0, y0, x1, y1, color) {
  const left = Math.max(0, Math.min(x0, x1));
  const right = Math.min(img.width - 1, Math.max(x0, x1));
  const top = Math.max(0, Math.min(y0, y1));
  const bottom = Math.min(img.height - 1, Math.max(y0, y1));
  for (let y = top; y <= bottom; y += 1) {
    for (let x = left; x <= right; x += 1) setPixel(img, x, y, color);
  }
}

function drawLine(img, x0, y0, x1, y1, color, width = 1) {
  const dx = Math.abs(x1 - x0);
  const dy = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx - dy;
  let x = x0;
  let y = y0;
  const radius = Math.max(0, Math.floor((width - 1) / 2));
  for (;;) {
    for (let oy = -radius; oy <= radius; oy += 1) {
      for (let ox = -radius; ox <= radius; ox += 1) setPixel(img, x + ox, y + oy, color);
    }
    if (x === x1 && y === y1) break;
    const e2 = 2 * err;
    if (e2 > -dy) {
      err -= dy;
      x += sx;
    }
    if (e2 < dx) {
      err += dx;
      y += sy;
    }
  }
}

function fillPolygon(img, points, color) {
  const xs = points.map(([x]) => x);
  const ys = points.map(([, y]) => y);
  const minX = Math.floor(Math.min(...xs));
  const maxX = Math.ceil(Math.max(...xs));
  const minY = Math.floor(Math.min(...ys));
  const maxY = Math.ceil(Math.max(...ys));
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      if (pointInPolygon(x + 0.5, y + 0.5, points)) setPixel(img, x, y, color);
    }
  }
}

function pointInPolygon(x, y, points) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i, i += 1) {
    const [xi, yi] = points[i];
    const [xj, yj] = points[j];
    const intersect =
      yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi + Number.EPSILON) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function strokeEllipse(img, cx, cy, rx, ry, color, width = 1) {
  const steps = Math.max(64, Math.ceil(2 * Math.PI * Math.max(rx, ry)));
  let prevX = Math.round(cx + rx);
  let prevY = Math.round(cy);
  for (let i = 1; i <= steps; i += 1) {
    const t = (i / steps) * Math.PI * 2;
    const x = Math.round(cx + rx * Math.cos(t));
    const y = Math.round(cy + ry * Math.sin(t));
    drawLine(img, prevX, prevY, x, y, color, width);
    prevX = x;
    prevY = y;
  }
}

function resizeNearest(src, size) {
  const scale = Math.min(size / src.width, size / src.height);
  const width = Math.max(1, Math.round(src.width * scale));
  const height = Math.max(1, Math.round(src.height * scale));
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    const sy = Math.min(src.height - 1, Math.floor((y + 0.5) / scale));
    for (let x = 0; x < width; x += 1) {
      const sx = Math.min(src.width - 1, Math.floor((x + 0.5) / scale));
      const si = (sy * src.width + sx) * 4;
      const di = (y * width + x) * 4;
      data[di] = src.data[si];
      data[di + 1] = src.data[si + 1];
      data[di + 2] = src.data[si + 2];
      data[di + 3] = src.data[si + 3];
    }
  }
  return { width, height, data };
}

function resizeArea(src, size) {
  const scale = Math.min(size / src.width, size / src.height);
  const width = Math.max(1, Math.round(src.width * scale));
  const height = Math.max(1, Math.round(src.height * scale));
  if (scale >= 1) return resizeNearest(src, size);

  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    const y0 = (y / height) * src.height;
    const y1 = ((y + 1) / height) * src.height;
    for (let x = 0; x < width; x += 1) {
      const x0 = (x / width) * src.width;
      const x1 = ((x + 1) / width) * src.width;
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let area = 0;
      const iy0 = Math.floor(y0);
      const iy1 = Math.min(src.height, Math.ceil(y1));
      const ix0 = Math.floor(x0);
      const ix1 = Math.min(src.width, Math.ceil(x1));
      for (let sy = iy0; sy < iy1; sy += 1) {
        const rowTop = Math.max(y0, sy);
        const rowBottom = Math.min(y1, sy + 1);
        const rowWeight = Math.max(0, rowBottom - rowTop);
        if (rowWeight <= 0) continue;
        for (let sx = ix0; sx < ix1; sx += 1) {
          const colLeft = Math.max(x0, sx);
          const colRight = Math.min(x1, sx + 1);
          const weight = rowWeight * Math.max(0, colRight - colLeft);
          if (weight <= 0) continue;
          const si = (sy * src.width + sx) * 4;
          const alpha = src.data[si + 3] / 255;
          r += src.data[si] * alpha * weight;
          g += src.data[si + 1] * alpha * weight;
          b += src.data[si + 2] * alpha * weight;
          a += alpha * weight;
          area += weight;
        }
      }
      const di = (y * width + x) * 4;
      if (a > 0) {
        data[di] = Math.round(r / a);
        data[di + 1] = Math.round(g / a);
        data[di + 2] = Math.round(b / a);
        data[di + 3] = Math.round((a / area) * 255);
      }
    }
  }
  return { width, height, data };
}

function pasteLogo(canvas, logo, size, centerX, centerY) {
  const icon = resizeArea(logo, size);
  const x0 = centerX - Math.floor(icon.width / 2);
  const y0 = centerY - Math.floor(icon.height / 2);
  for (let y = 0; y < icon.height; y += 1) {
    for (let x = 0; x < icon.width; x += 1) {
      const si = (y * icon.width + x) * 4;
      setPixel(canvas, x0 + x, y0 + y, [
        icon.data[si],
        icon.data[si + 1],
        icon.data[si + 2],
        icon.data[si + 3],
      ]);
    }
  }
}

function flattenRgb(img, i) {
  const alpha = img.data[i + 3] / 255;
  return [
    Math.round(img.data[i] * alpha + BG[0] * (1 - alpha)),
    Math.round(img.data[i + 1] * alpha + BG[1] * (1 - alpha)),
    Math.round(img.data[i + 2] * alpha + BG[2] * (1 - alpha)),
  ];
}

function decodePng(buffer) {
  if (buffer.subarray(0, 8).compare(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) !== 0) {
    throw new Error('not a PNG');
  }
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idat = [];
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.subarray(offset + 4, offset + 8).toString('binary');
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    offset += 12 + length;
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
  }
  if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6)) {
    throw new Error(`unsupported PNG (bitDepth=${bitDepth} colorType=${colorType})`);
  }
  const channels = colorType === 6 ? 4 : 3;
  const inflated = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const rgba = Buffer.alloc(width * height * 4);
  let src = 0;
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y += 1) {
    const filter = inflated[src++];
    const row = Buffer.from(inflated.subarray(src, src + stride));
    src += stride;
    applyPngFilter(filter, row, prev, channels);
    for (let x = 0; x < width; x += 1) {
      const di = (y * width + x) * 4;
      const si = x * channels;
      rgba[di] = row[si];
      rgba[di + 1] = row[si + 1];
      rgba[di + 2] = row[si + 2];
      rgba[di + 3] = channels === 4 ? row[si + 3] : 255;
    }
    prev = row;
  }
  return { width, height, data: rgba };
}

function applyPngFilter(filter, row, prev, channels) {
  for (let i = 0; i < row.length; i += 1) {
    const left = i >= channels ? row[i - channels] : 0;
    const up = prev[i];
    const upLeft = i >= channels ? prev[i - channels] : 0;
    if (filter === 1) row[i] = (row[i] + left) & 255;
    else if (filter === 2) row[i] = (row[i] + up) & 255;
    else if (filter === 3) row[i] = (row[i] + ((left + up) >> 1)) & 255;
    else if (filter === 4) row[i] = (row[i] + paeth(left, up, upLeft)) & 255;
    else if (filter !== 0) throw new Error(`unsupported PNG filter ${filter}`);
  }
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function encodeBmp(img) {
  const rowSize = Math.ceil((img.width * 3) / 4) * 4;
  const pixelBytes = rowSize * img.height;
  const buffer = Buffer.alloc(54 + pixelBytes);
  buffer.write('BM', 0);
  buffer.writeUInt32LE(buffer.length, 2);
  buffer.writeUInt32LE(54, 10);
  buffer.writeUInt32LE(40, 14);
  buffer.writeInt32LE(img.width, 18);
  buffer.writeInt32LE(img.height, 22);
  buffer.writeUInt16LE(1, 26);
  buffer.writeUInt16LE(24, 28);
  buffer.writeUInt32LE(pixelBytes, 34);

  for (let y = 0; y < img.height; y += 1) {
    const srcY = img.height - 1 - y;
    const destRow = 54 + y * rowSize;
    for (let x = 0; x < img.width; x += 1) {
      const [r, g, b] = flattenRgb(img, (srcY * img.width + x) * 4);
      const di = destRow + x * 3;
      buffer[di] = b;
      buffer[di + 1] = g;
      buffer[di + 2] = r;
    }
  }
  return buffer;
}

function encodePng(img) {
  const stride = img.width * 3;
  const raw = Buffer.alloc((stride + 1) * img.height);
  for (let y = 0; y < img.height; y += 1) {
    const rowStart = y * (stride + 1);
    raw[rowStart] = 0;
    for (let x = 0; x < img.width; x += 1) {
      const [r, g, b] = flattenRgb(img, (y * img.width + x) * 4);
      const di = rowStart + 1 + x * 3;
      raw[di] = r;
      raw[di + 1] = g;
      raw[di + 2] = b;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(img.width, 0);
  ihdr.writeUInt32BE(img.height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function pngChunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([length, typeBuf, data, crc]);
}

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j += 1) {
      const mask = -(crc & 1);
      crc = (crc >>> 1) ^ (0xedb88320 & mask);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function decodeBmpSize(buffer) {
  return { width: buffer.readInt32LE(18), height: Math.abs(buffer.readInt32LE(22)) };
}

async function writeAsset(name, img, encode) {
  await writeFile(join(outDir, name), encode(img));
}

async function main() {
  await mkdir(outDir, { recursive: true });
  const logo = decodePng(await readFile(iconPath));

  const header = solid(150, 57);
  fillRect(header, 0, 0, 5, 56, ACCENT);
  pasteLogo(header, logo, 44, 118, 28);
  await writeAsset('nsis-header.bmp', header, encodeBmp);

  const sidebar = solid(164, 314);
  fillRect(sidebar, 0, 0, 163, 5, ACCENT);
  pasteLogo(sidebar, logo, 96, 82, 120);
  await writeAsset('nsis-sidebar.bmp', sidebar, encodeBmp);

  const banner = solid(493, 58);
  fillRect(banner, 0, 0, 5, 57, ACCENT);
  pasteLogo(banner, logo, 44, 40, 29);
  await writeAsset('wix-banner.bmp', banner, encodeBmp);

  const dialog = solid(493, 312);
  fillRect(dialog, 0, 0, 492, 5, ACCENT);
  pasteLogo(dialog, logo, 140, 246, 140);
  await writeAsset('wix-dialog.bmp', dialog, encodeBmp);

  const dmg = solid(660, 400);
  fillRect(dmg, 0, 0, 659, 3, ACCENT);
  const y = 170;
  drawLine(dmg, 260, y, 400, y, ARROW, 4);
  fillPolygon(dmg, [[400, y], [382, y - 12], [382, y + 12]], ARROW);
  for (const cx of [180, 480]) strokeEllipse(dmg, cx, y, 52, 52, MUTED, 2);
  await writeAsset('dmg-background.png', dmg, encodePng);

  for (const name of (await readdir(outDir)).sort()) {
    if (!name.endsWith('.bmp') && !name.endsWith('.png')) continue;
    const path = join(outDir, name);
    const bytes = await readFile(path);
    const size = name.endsWith('.png') ? decodePng(bytes) : decodeBmpSize(bytes);
    console.log(`${name}: ${(await stat(path)).size} bytes ${size.width}x${size.height}`);
  }
}

await main();
