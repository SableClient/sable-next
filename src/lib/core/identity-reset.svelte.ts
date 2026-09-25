import { CoreError } from '#src/transport';
import type { CoreClient } from '#lib/core/client.svelte.js';
import { t } from '#lib/i18n.js';

export type IdentityResetPhase = 'confirm' | 'password' | 'approve' | 'done';

function resetErrorMessage(cause: unknown): string {
  if (cause instanceof CoreError) {
    if (cause.detail.code === 'denied') return t('settings.wrongPassword');
    if (cause.detail.code === 'interactive_auth_required') {
      return t('settings.resetIdentityUnsupportedAuth');
    }
  }
  return t('settings.actionFailed');
}

export class IdentityReset {
  phase = $state<IdentityResetPhase>('confirm');
  password = $state('');
  approvalUrl = $state<string | null>(null);
  recoveryKey = $state<string | null>(null);
  busy = $state(false);
  error = $state<string | null>(null);
  private cancelled = false;

  constructor(private readonly core: CoreClient) {}

  async start(): Promise<void> {
    this.busy = true;
    this.error = null;
    this.cancelled = false;
    try {
      const step = await this.core.commands.resetIdentity();
      if (step.step === 'done') {
        this.finish(step.recovery_key);
      } else if (step.step === 'password') {
        this.phase = 'password';
      } else {
        this.approvalUrl = step.url;
        this.phase = 'approve';
      }
    } catch (cause) {
      this.error = resetErrorMessage(cause);
    } finally {
      this.busy = false;
    }
  }

  async submitPassword(): Promise<void> {
    await this.continue(this.password);
  }

  async awaitApproval(): Promise<void> {
    await this.continue(null);
  }

  async cancel(): Promise<void> {
    if (this.phase !== 'password' && this.phase !== 'approve') return;
    this.cancelled = true;
    this.phase = 'confirm';
    this.password = '';
    this.approvalUrl = null;
    this.error = null;
    await this.core.commands.cancelIdentityReset();
  }

  private async continue(password: string | null): Promise<void> {
    this.busy = true;
    this.error = null;
    try {
      const recoveryKey = await this.core.commands.continueIdentityReset(password);
      if (!this.cancelled) this.finish(recoveryKey);
    } catch (cause) {
      if (this.cancelled) return;
      this.error =
        this.phase === 'approve'
          ? t('settings.resetIdentityApprovalMissing')
          : resetErrorMessage(cause);
    } finally {
      this.busy = false;
    }
  }

  private finish(recoveryKey: string): void {
    this.password = '';
    this.approvalUrl = null;
    this.recoveryKey = recoveryKey;
    this.phase = 'done';
  }
}
