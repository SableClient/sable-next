import type { CoreClient } from '#lib/core/client.svelte.js';
import {
  BANNER_FIELD,
  NAME_COLOR_FIELD,
  PRONOUNS_FIELD,
  STATUS_FIELD,
} from '#lib/profile/fields.js';
import { pronounSets } from '#lib/profile/pronouns.js';
import { t } from '#lib/i18n.js';
import { preferences } from '#lib/settings/preferences.svelte.js';
import { uprightJpeg } from '#lib/ui/upright-jpeg.js';

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
  pronouns = $state('');
  nameColor = $state('');
  status = $state('');
  bannerFile = $state<File | null>(null);
  bannerPreview = $state<string | null>(null);
  avatarPreview = $state<string | null>(null);
  avatarFile = $state<File | null>(null);
  avatarCleared = $state(false);
  error = $state<string | null>(null);
  isSaving = $state(false);

  constructor(private readonly options: ProfileControllerOptions) {}

  setDisplayName(value: string): void {
    this.displayName = value;
  }

  setPronouns(value: string): void {
    this.pronouns = value;
  }

  setNameColor(value: string): void {
    this.nameColor = value;
  }

  setStatus(value: string): void {
    this.status = value;
  }

  setBanner(file: File | null): void {
    revokeAvatarPreview(this.bannerPreview);
    this.bannerFile = file;
    this.bannerPreview = file ? URL.createObjectURL(file) : null;
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
      const propagateTo = preferences.profileChangePropagation;
      if (name) await this.options.core.commands.setDisplayName(name, propagateTo);
      const pronouns = pronounSets(this.pronouns);
      const core = this.options.core;
      if (pronouns.length > 0) await core.setProfileField(PRONOUNS_FIELD, pronouns);
      const color = this.nameColor.trim();
      if (color) await core.setProfileField(NAME_COLOR_FIELD, { on_light: color, on_dark: color });
      const status = this.status.trim();
      if (status) await core.setProfileField(STATUS_FIELD, { text: status });
      if (this.bannerFile) {
        const url = await core.commands.uploadMedia(
          this.bannerFile.type || 'image/*',
          new Uint8Array(await this.bannerFile.arrayBuffer())
        );
        await core.setProfileField(BANNER_FIELD, url);
      }
      if (this.avatarFile) {
        const upright = await uprightJpeg(this.avatarFile);
        const bytes = new Uint8Array(await upright.arrayBuffer());
        await this.options.core.uploadAvatar(upright.type || 'image/*', bytes, propagateTo);
      } else if (this.avatarCleared) {
        await this.options.core.commands.setAvatarUrl(null, propagateTo);
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
    revokeAvatarPreview(this.bannerPreview);
  }

  private async finish(): Promise<void> {
    const userId = this.options.getUserId();
    if (userId) localStorage.removeItem(profileOnboardingMarker(userId));
    await this.options.onNavigateHome();
  }
}
