import type { CoreClient } from '#lib/core/client.svelte.js';
import type { SignOutSafetyView } from '#src/generated/protocol';

export type SignOutRisk = 'unverified' | 'no_recovery' | 'no_backup' | 'backup_pending' | 'unknown';

export function signOutRisk(safety: SignOutSafetyView): SignOutRisk | null {
  if (!safety.has_encrypted_rooms) return null;
  if (safety.encryption.verification !== 'verified') return 'unverified';
  if (safety.encryption.recovery !== 'enabled') return 'no_recovery';
  if (!safety.backup_enabled) return 'no_backup';
  if (!safety.backup_uploaded) return 'backup_pending';
  return null;
}

export class SignOutGuard {
  risk = $state<SignOutRisk | null>(null);
  checking = $state(false);
  signingOut = $state(false);
  #core: CoreClient;
  #proceed: (() => Promise<void>) | null = null;

  constructor(core: CoreClient) {
    this.#core = core;
  }

  async request(proceed: () => Promise<void>): Promise<void> {
    if (this.checking || this.signingOut) return;

    this.checking = true;
    let risk: SignOutRisk | null;
    try {
      risk = signOutRisk(await this.#core.commands.signOutSafety());
    } catch {
      risk = 'unknown';
    } finally {
      this.checking = false;
    }

    if (risk === null) return proceed();
    this.#proceed = proceed;
    this.risk = risk;
  }

  async confirm(): Promise<void> {
    const proceed = this.#proceed;
    if (!proceed || this.signingOut) return;

    this.signingOut = true;
    try {
      await proceed();
      this.dismiss();
    } finally {
      this.signingOut = false;
    }
  }

  dismiss(): void {
    this.#proceed = null;
    this.risk = null;
  }
}
