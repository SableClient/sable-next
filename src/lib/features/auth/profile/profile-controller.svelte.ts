import type { ProfileView } from '#src/generated/protocol';
import type { CoreClient } from '#lib/core/client.svelte.js';
import {
  BANNER_FIELD,
  NAME_COLOR_FIELD,
  PRONOUNS_FIELD,
  STATUS_FIELD,
} from '#lib/profile/fields.js';
import { pronounSets, pronounText } from '#lib/profile/pronouns.js';
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

interface LoadedProfile {
  displayName: string;
  pronouns: string;
  nameColor: string;
  status: string;
}

function loadedFields(profile: ProfileView): LoadedProfile {
  return {
    displayName: profile.display_name ?? '',
    pronouns: pronounText(profile.pronouns),
    nameColor: profile.name_color_dark ?? profile.name_color_light ?? '',
    status: profile.status?.text ?? '',
  };
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
  bannerUrl = $state<string | null>(null);
  bannerCleared = $state(false);
  avatarPreview = $state<string | null>(null);
  avatarUrl = $state<string | null>(null);
  avatarFile = $state<File | null>(null);
  avatarCleared = $state(false);
  error = $state<string | null>(null);
  isSaving = $state(false);
  #loaded: LoadedProfile = { displayName: '', pronouns: '', nameColor: '', status: '' };

  constructor(private readonly options: ProfileControllerOptions) {}

  get shownAvatar(): string | null {
    return this.avatarPreview ?? (this.avatarCleared ? null : this.avatarUrl);
  }

  get shownBanner(): string | null {
    return this.bannerPreview ?? (this.bannerCleared ? null : this.bannerUrl);
  }

  async load(): Promise<void> {
    const userId = this.options.getUserId();
    if (!userId) return;
    let profile: ProfileView;
    try {
      profile = await this.options.core.userProfile(userId);
    } catch (error) {
      console.debug('[sable setup] profile unavailable', error);
      return;
    }
    const loaded = loadedFields(profile);
    const previous = this.#loaded;
    if (this.displayName === previous.displayName) this.displayName = loaded.displayName;
    if (this.pronouns === previous.pronouns) this.pronouns = loaded.pronouns;
    if (this.nameColor === previous.nameColor) this.nameColor = loaded.nameColor;
    if (this.status === previous.status) this.status = loaded.status;
    this.#loaded = loaded;
    this.avatarUrl = profile.avatar_url?.startsWith('mxc://') ? profile.avatar_url : null;
    this.bannerUrl = profile.banner_url?.startsWith('mxc://') ? profile.banner_url : null;
  }

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
    this.bannerCleared = file === null && this.bannerUrl !== null;
    this.bannerFile = file;
    this.bannerPreview = file ? URL.createObjectURL(file) : null;
  }

  setAvatar(file: File | null): void {
    const next = nextAvatarPreview(file, this.avatarPreview);
    this.avatarCleared = next.cleared || (file === null && this.avatarUrl !== null);
    this.avatarFile = file;
    this.avatarPreview = next.preview;
  }

  async save(): Promise<void> {
    this.isSaving = true;
    this.error = null;
    try {
      const loaded = this.#loaded;
      const name = this.displayName.trim();
      const propagateTo = preferences.profileChangePropagation;
      if (name && name !== loaded.displayName) {
        await this.options.core.commands.setDisplayName(name, propagateTo);
      }
      const core = this.options.core;
      if (this.pronouns.trim() !== loaded.pronouns) {
        await core.setProfileField(PRONOUNS_FIELD, pronounSets(this.pronouns));
      }
      const color = this.nameColor.trim();
      if (color !== loaded.nameColor) {
        await core.setProfileField(
          NAME_COLOR_FIELD,
          color ? { on_light: color, on_dark: color } : null
        );
      }
      const status = this.status.trim();
      if (status !== loaded.status) {
        await core.setProfileField(STATUS_FIELD, status ? { text: status } : null);
      }
      if (this.bannerFile) {
        const url = await core.commands.uploadMedia(
          this.bannerFile.type || 'image/*',
          new Uint8Array(await this.bannerFile.arrayBuffer())
        );
        await core.setProfileField(BANNER_FIELD, url);
      } else if (this.bannerCleared) {
        await core.setProfileField(BANNER_FIELD, null);
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
