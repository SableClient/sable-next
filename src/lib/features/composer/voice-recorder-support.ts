const CANDIDATE_MIME_TYPES = ['audio/ogg;codecs=opus', 'audio/ogg'];

export interface VoiceMediaRecorder {
  readonly mimeType: string;
  state: RecordingState;
  onstart: ((event: Event) => void) | null;
  onstop: ((event: Event) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  ondataavailable: ((event: BlobEvent) => void) | null;
  start: () => void;
  stop: () => void;
}

export interface VoiceRecordingSession {
  recorder: VoiceMediaRecorder;
  dispose: () => void;
}

export async function loadVoiceRecorder(): Promise<
  (stream: MediaStream, context: AudioContext) => VoiceRecordingSession
> {
  const mimeType = pickRecordingMimeType();
  if (mimeType !== null) {
    return (stream) => {
      const recorder = new MediaRecorder(stream, { mimeType });
      return {
        recorder,
        dispose: () => {
          if (recorder.state !== 'inactive') recorder.stop();
        },
      };
    };
  }
  const { createOggRecorder } = await import('./voice-recorder-encoder');
  return createOggRecorder;
}

export function isVoiceRecordingSupported(): boolean {
  return (
    typeof AudioContext !== 'undefined' &&
    typeof Worker !== 'undefined' &&
    typeof WebAssembly !== 'undefined' &&
    typeof navigator !== 'undefined' &&
    'mediaDevices' in navigator &&
    typeof navigator.mediaDevices.getUserMedia === 'function'
  );
}

export function pickRecordingMimeType(): string | null {
  if (typeof MediaRecorder === 'undefined') return null;
  return CANDIDATE_MIME_TYPES.find((type) => MediaRecorder.isTypeSupported(type)) ?? null;
}

export function extensionForMimeType(mime: string): string {
  const base = mime.split(';')[0]?.trim() ?? mime;
  switch (base) {
    case 'audio/ogg':
      return 'ogg';
    case 'audio/webm':
      return 'webm';
    case 'audio/mp4':
      return 'm4a';
    case 'audio/mpeg':
      return 'mp3';
    case 'audio/wav':
      return 'wav';
    case 'audio/aac':
      return 'aac';
    default:
      return 'webm';
  }
}
