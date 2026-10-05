import { untrack } from 'svelte';

import type { SupporterConfig } from '#lib/config/runtime-config.js';
import type { CoreClient } from '#lib/core/client.svelte.js';
import { openExternalAuthUrl } from '#lib/platform/external-auth.js';
import { SUPPORTER_FIELD, SUPPORTER_BADGE_FIELD } from '#lib/profile/fields.js';

import { badgeFor, type Award, type SupporterBadgeData } from './award.js';
import { supporterConfig } from './config.js';
import { fetchAwards, refreshAwards, startVerification } from './service.js';
import {
  profileSupporterAppearance,
  supporterAppearance,
  type SupporterAppearance,
} from './variants.js';

const POLL_INTERVAL_MS = 2_000;
const POLL_TIMEOUT_MS = 10 * 60 * 1000;
const STEP_TIMEOUT_MS = 15_000;
const REFRESH_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export type SupporterStatus = 'idle' | 'waiting' | 'refreshing' | 'checking' | 'none' | 'failed';

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true }
    );
  });
}

function withTimeout<T>(work: Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('timed out'));
    }, STEP_TIMEOUT_MS);
    work.then(resolve, reject).finally(() => {
      clearTimeout(timer);
    });
  });
}

function needsRefresh(raw: string | null, badge: SupporterBadgeData | null): boolean {
  if (!raw || raw === '[]') return false;
  if (!badge) return true;
  return badge.expiresAt !== null && badge.expiresAt * 1000 - Date.now() < REFRESH_WINDOW_MS;
}

function newerThan(next: SupporterBadgeData, current: SupporterBadgeData | null): boolean {
  if (!current) return true;
  return (next.expiresAt ?? Infinity) > (current.expiresAt ?? Infinity);
}

class Supporter {
  badge = $state.raw<SupporterBadgeData | null>(null);
  status = $state<SupporterStatus>('idle');
  config = $state.raw<SupporterConfig | null>(null);
  appearance = $state(supporterAppearance());
  savingAppearance = $state(false);
  removing = $state(false);

  private core: CoreClient | null = null;
  private generation = 0;
  private abort: AbortController | null = null;
  private appearanceSave: Promise<void> | null = null;

  get enabled(): boolean {
    return this.config !== null;
  }

  start(core: CoreClient): void {
    const generation = ++this.generation;
    this.core = core;
    void untrack(() => this.init(core, generation));
  }

  stop(): void {
    this.generation += 1;
    this.abort?.abort();
    this.abort = null;
    this.core = null;
    this.config = null;
    this.badge = null;
    this.status = 'idle';
    this.appearance = supporterAppearance();
    this.savingAppearance = false;
    this.removing = false;
    this.appearanceSave = null;
  }

  cancel(): void {
    this.abort?.abort();
  }

  async verify(): Promise<void> {
    const { core, config } = this;
    const userId = core?.session?.user_id;
    if (!core || !config || !userId || this.status === 'waiting') return;

    const generation = this.generation;
    const abort = new AbortController();
    const aborted = (): boolean => abort.signal.aborted;
    this.abort = abort;
    this.status = 'waiting';
    try {
      const url = await startVerification(
        config.serviceUrl,
        await withTimeout(core.commands.requestOpenIdToken())
      );
      await withTimeout(openExternalAuthUrl(url));

      const deadline = Date.now() + POLL_TIMEOUT_MS;
      while (!aborted() && Date.now() < deadline) {
        await sleep(POLL_INTERVAL_MS, abort.signal);
        if (aborted() || generation !== this.generation) break;
        const awards = await fetchAwards(config.serviceUrl, userId).catch(() => []);
        if (await this.adopt(core, config, userId, awards)) {
          this.status = 'idle';
          return;
        }
      }
      this.status = aborted() ? 'idle' : 'failed';
    } catch (error) {
      console.warn('[sable supporter] verification failed', error);
      if (generation === this.generation) this.status = 'failed';
    }
  }

  async claim(): Promise<void> {
    const { core, config } = this;
    const userId = core?.session?.user_id;
    if (!core || !config || !userId || this.status === 'waiting' || this.status === 'checking')
      return;

    this.status = 'checking';
    try {
      const awards = await fetchAwards(config.serviceUrl, userId);
      this.status = (await this.adopt(core, config, userId, awards)) ? 'idle' : 'none';
    } catch (error) {
      console.warn('[sable supporter] award lookup failed', error);
      this.status = 'failed';
    }
  }

  async refresh(): Promise<void> {
    const { core, config } = this;
    const userId = core?.session?.user_id;
    if (!core || !config || !userId || this.status !== 'idle') return;

    this.status = 'refreshing';
    try {
      const awards = await refreshAwards(
        config.serviceUrl,
        await core.commands.requestOpenIdToken()
      );
      if (awards) await this.adopt(core, config, userId, awards, true);
      this.status = 'idle';
    } catch (error) {
      console.warn('[sable supporter] refresh failed', error);
      this.status = 'failed';
    }
  }

  async remove(): Promise<void> {
    const core = this.core;
    if (!core || this.removing) return;
    const generation = this.generation;
    this.removing = true;
    try {
      await this.appearanceSave?.catch(() => {});
      await core.setProfileField(SUPPORTER_BADGE_FIELD, null);
      if (generation === this.generation) this.appearance = supporterAppearance();
      await core.setProfileField(SUPPORTER_FIELD, null);
      if (generation === this.generation) this.badge = null;
    } finally {
      if (generation === this.generation) this.removing = false;
    }
  }

  async selectAppearance(patch: Partial<SupporterAppearance>): Promise<void> {
    const core = this.core;
    if (!core || !this.badge || this.savingAppearance || this.removing) return;
    const generation = this.generation;
    const appearance = supporterAppearance({ ...this.appearance, ...patch });
    this.savingAppearance = true;
    try {
      this.appearanceSave = core.setProfileField(SUPPORTER_BADGE_FIELD, appearance);
      await this.appearanceSave;
      if (generation === this.generation) this.appearance = appearance;
    } finally {
      if (generation === this.generation) {
        this.savingAppearance = false;
        this.appearanceSave = null;
      }
    }
  }

  private async adopt(
    core: CoreClient,
    config: SupporterConfig,
    userId: string,
    awards: Award[],
    force = false
  ): Promise<boolean> {
    const next = await badgeFor(JSON.stringify(awards), userId, config.keys);
    if (!next || (!force && !newerThan(next, this.badge))) return false;
    await core.setProfileField(SUPPORTER_FIELD, awards);
    this.badge = next;
    return true;
  }

  private async init(core: CoreClient, generation: number): Promise<void> {
    const config = await supporterConfig();
    if (!config || generation !== this.generation) return;
    this.config = config;

    const userId = core.session?.user_id;
    if (!userId) return;
    try {
      const profile = await core.userProfile(userId);
      if (generation !== this.generation) return;
      this.appearance = profileSupporterAppearance(profile.extra);
      this.badge = await badgeFor(profile.supporter_awards, userId, config.keys);
      if (needsRefresh(profile.supporter_awards, this.badge)) await this.refresh();
    } catch (error) {
      console.warn('[sable supporter] profile unavailable', error);
    }
  }
}

export const supporter = new Supporter();
