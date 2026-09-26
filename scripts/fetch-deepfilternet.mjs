import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const assetsDir = resolve(dirname(fileURLToPath(import.meta.url)), '../static/deepfilternet3');

const assets = [
  {
    path: 'v3/pkg/df_bg.wasm',
    url: 'https://cdn.mezon.ai/AI/models/datas/noise_suppression/deepfilternet3/v3/pkg/df_bg.wasm',
    sha256: '440b5d12b6ea7d95008736f844221d7874ee15de5cb10d3015002470fdba0432',
  },
  {
    path: 'v3/models/DeepFilterNet3_onnx.tar.gz',
    url: 'https://github.com/Rikorose/DeepFilterNet/raw/84d57ec2c08fe08e68a13fb32a58cd7092060a0f/models/DeepFilterNet3_onnx.tar.gz',
    sha256: 'c94d91f70911001c946e0fabb4aa9adc37045f45a03b56008cb0c8244cb63616',
  },
];

/** @param {Buffer} bytes */
const digestOf = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** @param {{ path: string; url: string; sha256: string }} asset */
async function provision({ path, url, sha256 }) {
  const target = join(assetsDir, path);
  const existing = await readFile(target).catch(() => undefined);
  if (existing && digestOf(existing) === sha256) return;

  console.log(`Downloading ${path} from ${url}`);
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) {
    throw new Error(`failed to download ${path}: HTTP ${response.status} ${response.statusText}`);
  }

  const bytes = Buffer.from(await response.arrayBuffer());
  const digest = digestOf(bytes);
  if (digest !== sha256) {
    throw new Error(`checksum mismatch for ${path}: expected ${sha256}, got ${digest}`);
  }

  await mkdir(dirname(target), { recursive: true });
  await writeFile(`${target}.tmp`, bytes);
  await rename(`${target}.tmp`, target);
}

export async function fetchDeepFilterNet() {
  for (const asset of assets) await provision(asset);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await fetchDeepFilterNet();
