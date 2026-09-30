declare module 'opus-recorder' {
  export default class OpusRecorder {
    constructor(options: {
      encoderPath: string;
      sourceNode: MediaStreamAudioSourceNode;
      numberOfChannels: number;
      encoderApplication: number;
      encoderBitRate: number;
      encoderSampleRate: number;
    });
    onstart: () => void;
    onstop: () => void;
    ondataavailable: (bytes: Uint8Array) => void;
    start(): Promise<void>;
    stop(): Promise<void>;
    close(): Promise<void>;
  }
}
