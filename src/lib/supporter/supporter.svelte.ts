import { untrack } from 'svelte';

import { SABLE_AWARDS_KEYS } from '#lib/config/links.js';
import type { CoreClient } from '#lib/core/client.svelte.js';
import { openExternalAuthUrl } from '#lib/platform/external-auth.js';
import { SUPPORTER_FIELD } from '#lib/profile/fields.js';

import { badgeFor, type Award, type SupporterBadgeData } from './award.js';
import { fetchAwards, refreshAwards, startVerification } from './service.js';

const POLL_INTERVAL_MS = 2_000;
const POLL_TIMEOUT_MS = 10 * 60 * 1000;
const REFRESH_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export type SupporterStatus = 'idle' | 'waiting' | 'refreshing' | 'failed';

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
  readonly enabled = Object.keys(SABLE_AWARDS_KEYS).length > 0;

  private core: CoreClient | null = null;
  private generation = 0;
  private abort: AbortController | null = null;

  start(core: CoreClient): void {
    if (!this.enabled) return;
    const generation = ++this.generation;
    this.core = core;
    void untrack(() => this.load(core, generation));
  }

  stop(): void {
    this.generation += 1;
    this.abort?.abort();
    this.abort = null;
    this.core = null;
    this.badge = null;
    this.status = 'idle';
  }

  cancel(): void {
    this.abort?.abort();
  }

  async verify(): Promise<void> {
    const core = this.core;
    const userId = core?.session?.user_id;
    if (!core || !userId || this.status === 'waiting') return;

    const generation = this.generation;
    const abort = new AbortController();
    const aborted = (): boolean => abort.signal.aborted;
    this.abort = abort;
    this.status = 'waiting';
    try {
      const url = await startVerification(await core.commands.requestOpenIdToken());
      await openExternalAuthUrl(url);

      const deadline = Date.now() + POLL_TIMEOUT_MS;
      while (!aborted() && Date.now() < deadline) {
        await sleep(POLL_INTERVAL_MS, abort.signal);
        if (aborted() || generation !== this.generation) break;
        const awards = await fetchAwards(userId).catch(() => []);
        if (await this.adopt(core, userId, awards)) {
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

  async refresh(): Promise<void> {
    const core = this.core;
    const userId = core?.session?.user_id;
    if (!core || !userId || this.status !== 'idle') return;

    this.status = 'refreshing';
    try {
      const awards = await refreshAwards(await core.commands.requestOpenIdToken());
      if (awards) await this.adopt(core, userId, awards, true);
      this.status = 'idle';
    } catch (error) {
      console.warn('[sable supporter] refresh failed', error);
      this.status = 'failed';
    }
  }

  async remove(): Promise<void> {
    if (!this.core) return;
    await this.core.setProfileField(SUPPORTER_FIELD, null);
    this.badge = null;
  }

  private async adopt(
    core: CoreClient,
    userId: string,
    awards: Award[],
    force = false
  ): Promise<boolean> {
    const next = await badgeFor(JSON.stringify(awards), userId);
    if (!next || (!force && !newerThan(next, this.badge))) return false;
    await core.setProfileField(SUPPORTER_FIELD, awards);
    this.badge = next;
    return true;
  }

  private async load(core: CoreClient, generation: number): Promise<void> {
    const userId = core.session?.user_id;
    if (!userId) return;
    try {
      const profile = await core.userProfile(userId);
      if (generation !== this.generation) return;
      this.badge = await badgeFor(profile.supporter_awards, userId);
      if (needsRefresh(profile.supporter_awards, this.badge)) await this.refresh();
    } catch (error) {
      console.warn('[sable supporter] profile unavailable', error);
    }
  }
}

export const supporter = new Supporter();
