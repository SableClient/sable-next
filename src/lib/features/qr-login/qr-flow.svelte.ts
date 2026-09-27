import { uint8ArrayToBase64 } from 'uint8array-extras';

import type { QrLoginFailureView, QrLoginProgressView } from '#src/generated/protocol';
import { CoreError } from '#src/transport';

import type { CoreClient } from '#lib/core/client.svelte.js';

export type QrMode = 'login' | 'grant';

export type QrFailure = QrLoginFailureView | 'wrong_code';

export type QrProgress =
  | Exclude<QrLoginProgressView, { stage: 'failed' }>
  | { stage: 'failed'; reason: QrFailure };

export type QrFlowCore = Pick<
  CoreClient,
  | 'subscribeEvents'
  | 'startQrLogin'
  | 'finishQrLogin'
  | 'startQrGrant'
  | 'qrCheckCode'
  | 'qrGrantContinue'
  | 'cancelQr'
>;

export interface QrLoginTarget {
  homeserver: () => string | null;
  redirectUri: () => string;
}

export class QrFlow {
  progress = $state.raw<QrProgress | null>(null);
  scanning = $state(false);
  pending = $state(false);

  private stopEvents: (() => void) | null = null;

  constructor(
    private readonly core: QrFlowCore,
    private readonly mode: () => QrMode,
    private readonly target: () => QrLoginTarget | null = () => null,
    private readonly onSignedIn: () => void = () => {}
  ) {}

  listen(): () => void {
    this.stopEvents?.();
    const grant = this.mode() === 'grant';
    this.stopEvents = this.core.subscribeEvents((event) => {
      if (event.type !== 'qr_login' || event.grant !== grant) return;
      this.progress = event.progress;
      if (event.progress.stage === 'signed_in') void this.signIn(event.progress.user_id);
    });
    return () => {
      this.stopEvents?.();
      this.stopEvents = null;
      void this.cancel();
    };
  }

  showCode(): Promise<void> {
    return this.start(null);
  }

  startScanning(): void {
    this.reset();
    this.scanning = true;
  }

  scanned(data: Uint8Array): Promise<void> {
    this.scanning = false;
    return this.start(uint8ArrayToBase64(data));
  }

  async submitCheckCode(code: number): Promise<void> {
    await this.run(() => this.core.qrCheckCode(code));
  }

  async continueGrant(confirm: boolean): Promise<void> {
    await this.run(() => this.core.qrGrantContinue(confirm));
  }

  async cancel(): Promise<void> {
    this.scanning = false;
    try {
      await this.core.cancelQr();
    } catch (error) {
      console.debug('[sable qr] cancel failed', error);
    }
  }

  reset(): void {
    this.progress = null;
    this.scanning = false;
    this.pending = false;
  }

  private async start(scanned: string | null): Promise<void> {
    this.progress = { stage: 'starting' };
    const target = this.target();
    await this.run(() =>
      this.mode() === 'grant'
        ? this.core.startQrGrant(scanned)
        : this.core.startQrLogin(target?.homeserver() ?? null, target?.redirectUri() ?? '', scanned)
    );
  }

  private async signIn(userId: string): Promise<void> {
    if (await this.run(() => this.core.finishQrLogin(userId))) this.onSignedIn();
  }

  private async run(action: () => Promise<void>): Promise<boolean> {
    if (this.pending) return false;
    this.pending = true;
    try {
      await action();
      return true;
    } catch (error) {
      console.warn('[sable qr] QR sign-in step failed', error);
      void this.cancel();
      const denied = error instanceof CoreError && error.detail.code === 'denied';
      this.progress = { stage: 'failed', reason: denied ? 'wrong_code' : 'other' };
      return false;
    } finally {
      this.pending = false;
    }
  }
}
