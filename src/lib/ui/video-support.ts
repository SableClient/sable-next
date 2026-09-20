/* A bare `video/mp4` answers `maybe` and then fails on the H.264 inside. */
const PROBES = new Map<string, string>([
  ['video/mp4', 'video/mp4; codecs="avc1.42E01E, mp4a.40.2"'],
  ['video/quicktime', 'video/mp4; codecs="avc1.42E01E, mp4a.40.2"'],
  ['video/x-matroska', 'video/webm; codecs="vp9, opus"'],
]);

const answers = new Map<string, boolean>();

/** Unknown types count as playable: letting the element try is the cheaper miss. */
export function canPlayVideo(mime: string | null | undefined): boolean {
  if (typeof document === 'undefined') return true;
  const type = mime?.split(';')[0]?.trim().toLowerCase();
  if (type === undefined || type === '') return true;

  const cached = answers.get(type);
  if (cached !== undefined) return cached;

  const probe = PROBES.get(type);
  if (probe === undefined) {
    answers.set(type, true);
    return true;
  }

  let playable: boolean;
  try {
    playable = document.createElement('video').canPlayType(probe) !== '';
  } catch {
    playable = true;
  }
  answers.set(type, playable);
  return playable;
}

/** Test seam: answers are memoised per process. */
export function resetVideoSupport(): void {
  answers.clear();
}
