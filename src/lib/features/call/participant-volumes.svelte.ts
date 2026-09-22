const STORAGE_KEY = 'sable-call-volumes';
const OUTPUT_KEY = 'sable-call-output-volume';

export const MAX_PARTICIPANT_VOLUME = 2;

function load(): Record<string, number> {
  if (typeof localStorage === 'undefined') return {};
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return {};
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).filter(
        (entry): entry is [string, number] =>
          typeof entry[1] === 'number' &&
          Number.isFinite(entry[1]) &&
          entry[1] >= 0 &&
          entry[1] <= MAX_PARTICIPANT_VOLUME
      )
    );
  } catch {
    return {};
  }
}

function loadOutput(): number {
  if (typeof localStorage === 'undefined') return 1;
  const stored = Number(localStorage.getItem(OUTPUT_KEY));
  return Number.isFinite(stored) && stored >= 0 && stored <= 1 ? stored : 1;
}

const volumes = $state<Record<string, number>>(load());
const output = $state({ volume: loadOutput() });

export function outputVolume(): number {
  return output.volume;
}

export function setOutputVolume(volume: number): void {
  output.volume = Math.min(Math.max(volume, 0), 1);
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(OUTPUT_KEY, String(output.volume));
  } catch (error) {
    console.debug('[sable call] output volume not persisted', error);
  }
}

export function effectiveVolume(userId: string): number {
  return Math.min(participantVolume(userId) * output.volume, 1);
}

export function participantVolume(userId: string): number {
  return volumes[userId] ?? 1;
}

export function setParticipantVolume(userId: string, volume: number): void {
  volumes[userId] = Math.min(Math.max(volume, 0), MAX_PARTICIPANT_VOLUME);
  persist();
}

function persist(): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(volumes));
  } catch (error) {
    console.debug('[sable call] participant volumes not persisted', error);
  }
}
