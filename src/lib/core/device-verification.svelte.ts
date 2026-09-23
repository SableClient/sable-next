import type { CoreClient } from '#lib/core/client.svelte.js';
import { verificationErrorMessage } from '#lib/core/verification-errors.js';

type Continuation = () => void | Promise<void>;

export class DeviceVerification {
  recoveryKey = $state('');
  requesting = $state(false);
  recovering = $state(false);
  error = $state<string | null>(null);

  constructor(private readonly core: CoreClient) {}

  async requestVerification(onRequested?: Continuation): Promise<void> {
    const userId = this.core.session?.user_id;
    if (!userId) return;
    this.requesting = true;
    this.error = null;
    try {
      await this.core.requestVerification(userId);
      await onRequested?.();
    } catch (cause) {
      this.error = verificationErrorMessage(cause);
    } finally {
      this.requesting = false;
    }
  }

  async recoverIdentity(onRecovered?: Continuation): Promise<void> {
    const key = this.recoveryKey.trim();
    if (!key) return;
    this.recovering = true;
    this.error = null;
    try {
      await this.core.commands.recoverIdentity(key);
      this.recoveryKey = '';
      await onRecovered?.();
    } catch (cause) {
      this.error = verificationErrorMessage(cause, { invalidRecoveryKey: true });
    } finally {
      this.recovering = false;
    }
  }
}
