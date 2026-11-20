import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type { UserActivity } from './intent-fusion';

export type UserEpisodeFeedback =
  | 'none'
  | 'accepted'
  | 'rejected'
  | 'corrected';

export interface UserActivityEpisode {
  id: string;
  activity: UserActivity;
  activeApplication: string | null;
  activeWindow: string | null;
  focusedControl: string | null;
  startedAt: number;
  lastSeenAt: number;
  endedAt: number | null;
  confidence: number;
  evidence: string[];
  feedback: UserEpisodeFeedback;
}

export interface UserTimelineSnapshot {
  revision: number;
  current: UserActivityEpisode | null;
  episodes: UserActivityEpisode[];
}

export interface UserTimelineOptions {
  stateFile?: string;
  now?: () => number;
  idFactory?: () => string;
  maxEpisodes?: number;
  episodeGapMs?: number;
  retentionMs?: number;
}

interface PersistedUserTimeline {
  version: 1;
  revision: number;
  episodes: UserActivityEpisode[];
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

export class UserTimelineStore {
  private readonly now: () => number;
  private readonly idFactory: () => string;
  private readonly maxEpisodes: number;
  private readonly episodeGapMs: number;
  private readonly retentionMs: number;
  private readonly stateFile?: string;
  private episodes: UserActivityEpisode[];
  private revision = 0;

  constructor(options: UserTimelineOptions = {}) {
    this.now = options.now || Date.now;
    this.idFactory = options.idFactory || randomUUID;
    this.maxEpisodes = Math.max(20, options.maxEpisodes ?? 200);
    this.episodeGapMs = Math.max(30_000, options.episodeGapMs ?? 5 * 60_000);
    this.retentionMs = Math.max(
      60 * 60_000,
      options.retentionMs ?? 7 * 24 * 60 * 60_000,
    );
    this.stateFile = options.stateFile
      ? path.resolve(options.stateFile)
      : undefined;
    this.episodes = this.load();
  }

  observe(input: {
    activity: UserActivity;
    activeApplication: string | null;
    activeWindow: string | null;
    focusedControl: string | null;
    confidence: number;
    evidence: string[];
  }): UserActivityEpisode {
    const now = this.now();
    const current = this.episodes.at(-1) || null;
    const sameEpisode =
      current &&
      current.endedAt === null &&
      current.activity === input.activity &&
      current.activeApplication === input.activeApplication &&
      current.activeWindow === input.activeWindow &&
      current.focusedControl === input.focusedControl &&
      now - current.lastSeenAt <= this.episodeGapMs;
    if (sameEpisode) {
      const nextEvidence = [...new Set(input.evidence)].slice(0, 12);
      const changed =
        Math.abs(current.confidence - input.confidence) >= 0.01 ||
        current.evidence.join('\0') !== nextEvidence.join('\0');
      current.lastSeenAt = now;
      current.confidence = Math.max(0, Math.min(1, input.confidence));
      current.evidence = nextEvidence;
      if (changed) this.revision += 1;
      return clone(current);
    }

    if (current?.endedAt === null) {
      current.endedAt = now;
    }
    const episode: UserActivityEpisode = {
      id: this.idFactory(),
      activity: input.activity,
      activeApplication: input.activeApplication,
      activeWindow: input.activeWindow,
      focusedControl: input.focusedControl,
      startedAt: now,
      lastSeenAt: now,
      endedAt: null,
      confidence: Math.max(0, Math.min(1, input.confidence)),
      evidence: [...new Set(input.evidence)].slice(0, 12),
      feedback: 'none',
    };
    this.episodes.push(episode);
    this.prune(now);
    this.revision += 1;
    this.persist();
    return clone(episode);
  }

  recordFeedback(feedback: Exclude<UserEpisodeFeedback, 'none'>): boolean {
    const current =
      [...this.episodes]
        .reverse()
        .find((episode) => episode.endedAt === null) ||
      this.episodes.at(-1) ||
      null;
    if (!current) return false;
    current.feedback = feedback;
    this.revision += 1;
    this.persist();
    return true;
  }

  snapshot(limit = 40): UserTimelineSnapshot {
    this.prune(this.now());
    const episodes = clone(this.episodes.slice(-Math.max(1, limit)));
    return {
      revision: this.revision,
      current: episodes.find((episode) => episode.endedAt === null) || null,
      episodes,
    };
  }

  getContext(limit = 8): string {
    const snapshot = this.snapshot(limit);
    if (!snapshot.episodes.length) return '';
    return [
      '[Recent user activity episodes]',
      ...snapshot.episodes.map((episode) => {
        const state = episode.endedAt ? 'ended' : 'active';
        return `${new Date(episode.startedAt).toISOString()} ${episode.activity} ${state} ${episode.activeApplication || episode.activeWindow || 'unknown'} (${episode.confidence.toFixed(2)})`;
      }),
    ].join('\n');
  }

  private prune(now: number): void {
    const previous = this.episodes.length;
    const cutoff = now - this.retentionMs;
    this.episodes = this.episodes
      .filter(
        (episode) => episode.endedAt === null || episode.lastSeenAt >= cutoff,
      )
      .slice(-this.maxEpisodes);
    if (this.episodes.length !== previous) this.revision += 1;
  }

  private load(): UserActivityEpisode[] {
    if (!this.stateFile || !fs.existsSync(this.stateFile)) return [];
    try {
      const parsed = JSON.parse(
        fs.readFileSync(this.stateFile, 'utf8'),
      ) as PersistedUserTimeline;
      if (parsed.version !== 1 || !Array.isArray(parsed.episodes)) return [];
      this.revision = Math.max(0, parsed.revision || 0);
      return parsed.episodes
        .filter(
          (episode) =>
            episode &&
            typeof episode.id === 'string' &&
            typeof episode.startedAt === 'number',
        )
        .slice(-this.maxEpisodes);
    } catch {
      return [];
    }
  }

  private persist(): void {
    if (!this.stateFile) return;
    try {
      fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
      const payload: PersistedUserTimeline = {
        version: 1,
        revision: this.revision,
        episodes: this.episodes,
      };
      const temporary = `${this.stateFile}.${process.pid}.tmp`;
      fs.writeFileSync(temporary, JSON.stringify(payload, null, 2), 'utf8');
      fs.renameSync(temporary, this.stateFile);
    } catch (error) {
      console.warn('[cyrvis intent] timeline persist failed', error);
    }
  }
}
