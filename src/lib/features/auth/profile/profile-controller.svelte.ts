import type { CoreClient } from '#lib/core/client.svelte.js';
import { t } from '#lib/i18n.js';

export function revokeAvatarPreview(preview: string | null): void {
  if (preview) URL.revokeObjectURL(preview);
}

export function nextAvatarPreview(
  file: File | null,
  previousPreview: string | null
): { preview: string | null; cleared: boolean } {
  const cleared = file === null && previousPreview !== null;
  revokeAvatarPreview(previousPreview);
  return {
    preview: file ? URL.createObjectURL(file) : null,
    cleared,
  };
}

export function profileOnboardingMarker(matrixId: string): string {
  return `sable-registration-onboarding:${matrixId}`;
}

interface ProfileControllerOptions {
  core: CoreClient;
  getUserId: () => string;
  onNavigateHome: () => Promise<void>;
}

export class ProfileController {
  displayName = $state('');
  avatarPreview = $state<string | null>(null);
  avatarFile = $state<File | null>(null);
  avatarCleared = $state(false);
  error = $state<string | null>(null);
  isSaving = $state(false);

  constructor(private readonly options: ProfileControllerOptions) {}

  setDisplayName(value: string): void {
    this.displayName = value;
  }

  setAvatar(file: File | null): void {
    const next = nextAvatarPreview(file, this.avatarPreview);
    this.avatarCleared = next.cleared;
    this.avatarFile = file;
    this.avatarPreview = next.preview;
  }

  async save(): Promise<void> {
    this.isSaving = true;
    this.error = null;
    try {
      const name = this.displayName.trim();
      if (name) await this.options.core.commands.setDisplayName(name);
      if (this.avatarFile) {
        const bytes = new Uint8Array(await this.avatarFile.arrayBuffer());
        await this.options.core.uploadAvatar(this.avatarFile.type || 'image/*', bytes);
      } else if (this.avatarCleared) {
        await this.options.core.commands.setAvatarUrl(null);
      }
      await this.finish();
    } catch {
      this.error = t('errors.profileSaveFailed');
    } finally {
      this.isSaving = false;
    }
  }

  async skip(): Promise<void> {
    await this.finish();
  }

  cleanup(): void {
    revokeAvatarPreview(this.avatarPreview);
  }

  private async finish(): Promise<void> {
    const userId = this.options.getUserId();
    if (userId) localStorage.removeItem(profileOnboardingMarker(userId));
    await this.options.onNavigateHome();
  }
}
