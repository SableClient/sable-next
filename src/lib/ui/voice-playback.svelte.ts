import { readText, writeText } from '#lib/platform/local-json.js';

const SPEED_KEY = 'sable.voice.speed';
const VOLUME_KEY = 'sable.voice.volume';

export const VOICE_SPEEDS = [1, 1.25, 1.5, 2];

function readSpeed(): number {
  const stored = Number(readText(SPEED_KEY));
  return VOICE_SPEEDS.includes(stored) ? stored : 1;
}

function readVolume(): number {
  const raw = readText(VOLUME_KEY);
  const stored = raw === null ? Number.NaN : Number(raw);
  return Number.isFinite(stored) ? Math.max(0, Math.min(1, stored)) : 1;
}

let speed = $state(readSpeed());
let volume = $state(readVolume());

export const voicePlayback = {
  get speed() {
    return speed;
  },
  get volume() {
    return volume;
  },
  cycleSpeed(): void {
    speed = VOICE_SPEEDS[(VOICE_SPEEDS.indexOf(speed) + 1) % VOICE_SPEEDS.length] ?? 1;
    writeText(SPEED_KEY, String(speed));
  },
  setVolume(next: number): void {
    volume = Math.max(0, Math.min(1, next));
    writeText(VOLUME_KEY, String(volume));
  },
};
