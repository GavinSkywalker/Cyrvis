/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import path from 'node:path';

export interface ToolUsageRecord {
  toolId: string;
  providerId: string | null;
  successes: number;
  failures: number;
  consecutiveFailures: number;
  lastUsedAt: number | null;
  lastError: string | null;
  lastDurationMs: number | null;
  averageDurationMs: number | null;
  timeouts: number;
}

export interface ToolUsageEvent {
  timestamp: number;
  toolId: string;
  providerId: string | null;
  ok: boolean;
  durationMs: number;
  error?: string;
  timedOut?: boolean;
}

interface UsageFile {
  version: 1;
  records: ToolUsageRecord[];
}

export interface ToolUsageStoreOptions {
  stateFile?: string;
  auditFile?: string;
}

export class ToolUsageStore {
  private readonly records = new Map<string, ToolUsageRecord>();
  private readonly stateFile?: string;
  private readonly auditFile?: string;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(options: ToolUsageStoreOptions = {}) {
    this.stateFile = options.stateFile;
    this.auditFile = options.auditFile;
    this.load();
  }

  get(toolId: string): ToolUsageRecord {
    return (
      this.records.get(toolId) || {
        toolId,
        providerId: null,
        successes: 0,
        failures: 0,
        consecutiveFailures: 0,
        lastUsedAt: null,
        lastError: null,
        lastDurationMs: null,
        averageDurationMs: null,
        timeouts: 0,
      }
    );
  }

  record(event: ToolUsageEvent): void {
    const previous = this.get(event.toolId);
    const completed = previous.successes + previous.failures;
    const averageDurationMs =
      previous.averageDurationMs === null
        ? event.durationMs
        : (previous.averageDurationMs * completed + event.durationMs) /
          (completed + 1);
    const next: ToolUsageRecord = event.ok
      ? {
          ...previous,
          providerId: event.providerId,
          successes: previous.successes + 1,
          consecutiveFailures: 0,
          lastUsedAt: event.timestamp,
          lastError: null,
          lastDurationMs: event.durationMs,
          averageDurationMs,
          timeouts: previous.timeouts + (event.timedOut ? 1 : 0),
        }
      : {
          ...previous,
          providerId: event.providerId,
          failures: previous.failures + 1,
          consecutiveFailures: previous.consecutiveFailures + 1,
          lastUsedAt: event.timestamp,
          lastError: event.error || '工具执行失败',
          lastDurationMs: event.durationMs,
          averageDurationMs,
          timeouts: previous.timeouts + (event.timedOut ? 1 : 0),
        };
    this.records.set(event.toolId, next);
    this.persist(event);
  }

  score(toolId: string, now = Date.now()): number {
    const usage = this.get(toolId);
    if (!usage.lastUsedAt) {
      return 0;
    }
    const ageMs = Math.max(0, now - usage.lastUsedAt);
    const recency =
      ageMs <= 10 * 60_000
        ? 18
        : ageMs <= 60 * 60_000
          ? 10
          : ageMs <= 24 * 60 * 60_000
            ? 4
            : 0;
    const frequency = Math.min(
      8,
      Math.log2(usage.successes + usage.failures + 1) * 2,
    );
    const failurePenalty = Math.min(10, usage.consecutiveFailures * 3);
    return recency + frequency - failurePenalty;
  }

  snapshot(): ToolUsageRecord[] {
    return [...this.records.values()].sort(
      (left, right) => (right.lastUsedAt || 0) - (left.lastUsedAt || 0),
    );
  }

  private load(): void {
    if (!this.stateFile || !fs.existsSync(this.stateFile)) {
      return;
    }
    try {
      const parsed = JSON.parse(
        fs.readFileSync(this.stateFile, 'utf8'),
      ) as UsageFile;
      if (parsed.version !== 1 || !Array.isArray(parsed.records)) {
        return;
      }
      for (const record of parsed.records) {
        if (record?.toolId) {
          this.records.set(record.toolId, record);
        }
      }
    } catch {
      // Corrupt usage state must not prevent tool registration.
    }
  }

  private persist(event: ToolUsageEvent): void {
    if (!this.stateFile && !this.auditFile) {
      return;
    }
    this.writeChain = this.writeChain
      .then(async () => {
        if (this.stateFile) {
          await fs.promises.mkdir(path.dirname(this.stateFile), {
            recursive: true,
          });
          const payload: UsageFile = {
            version: 1,
            records: this.snapshot(),
          };
          await fs.promises.writeFile(
            this.stateFile,
            `${JSON.stringify(payload, null, 2)}\n`,
            'utf8',
          );
        }
        if (this.auditFile) {
          await fs.promises.mkdir(path.dirname(this.auditFile), {
            recursive: true,
          });
          await fs.promises.appendFile(
            this.auditFile,
            `${JSON.stringify(event)}\n`,
            'utf8',
          );
        }
      })
      .catch(() => undefined);
  }
}
