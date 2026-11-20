import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { isSensitiveMemoryText } from '../memory-context';

export type RuntimeTraceCategory =
  | 'system'
  | 'context'
  | 'perception'
  | 'intent'
  | 'task'
  | 'tool'
  | 'autonomy'
  | 'capability'
  | 'memory';

export interface RuntimeTraceEvent {
  id: string;
  sequence: number;
  at: number;
  category: RuntimeTraceCategory;
  name: string;
  summary: string;
  taskId: string | null;
  data: Record<string, unknown>;
}

export interface RuntimeTraceReplay {
  from: number;
  to: number;
  eventCount: number;
  categories: Record<string, number>;
  taskLifecycles: Array<{
    taskId: string;
    states: string[];
    complete: boolean;
  }>;
  gaps: string[];
}

export interface RuntimeTraceOptions {
  stateFile?: string;
  now?: () => number;
  maxEvents?: number;
}

interface PersistedRuntimeTrace {
  version: 1;
  sequence: number;
  events: RuntimeTraceEvent[];
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const safeData = (
  value: Record<string, unknown> | undefined,
): Record<string, unknown> => {
  if (!value) return {};
  try {
    const serialized = JSON.stringify(value);
    if (isSensitiveMemoryText(serialized)) {
      return { redacted: true, reason: 'sensitive trace payload' };
    }
    return clone(value);
  } catch {
    return { redacted: true, reason: 'non-serializable trace payload' };
  }
};

export class RuntimeTraceStore {
  private readonly now: () => number;
  private readonly maxEvents: number;
  private readonly stateFile?: string;
  private readonly events: RuntimeTraceEvent[] = [];
  private readonly listeners = new Set<() => void>();
  private sequence = 0;
  private persistChain = Promise.resolve();
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly readyPromise: Promise<void>;

  constructor(options: RuntimeTraceOptions = {}) {
    this.now = options.now || Date.now;
    this.maxEvents = Math.max(100, options.maxEvents ?? 5_000);
    this.stateFile = options.stateFile
      ? path.resolve(options.stateFile)
      : undefined;
    this.readyPromise = this.load();
  }

  ready(): Promise<void> {
    return this.readyPromise;
  }

  record(input: {
    category: RuntimeTraceCategory;
    name: string;
    summary: string;
    taskId?: string | null;
    data?: Record<string, unknown>;
  }): RuntimeTraceEvent {
    const nextSummary = input.summary.trim().slice(0, 1_000);
    const at = this.now();
    const previous = this.events.at(-1);
    if (
      previous &&
      previous.category === input.category &&
      previous.name === input.name.slice(0, 160) &&
      previous.summary ===
        (isSensitiveMemoryText(nextSummary)
          ? '[敏感轨迹已过滤]'
          : nextSummary) &&
      previous.taskId === (input.taskId || null) &&
      at - previous.at < 750
    ) {
      return clone(previous);
    }
    this.sequence += 1;
    const summary = nextSummary;
    const event: RuntimeTraceEvent = {
      id: randomUUID(),
      sequence: this.sequence,
      at,
      category: input.category,
      name: input.name.slice(0, 160),
      summary: isSensitiveMemoryText(summary) ? '[敏感轨迹已过滤]' : summary,
      taskId: input.taskId || null,
      data: safeData(input.data),
    };
    this.events.push(event);
    if (this.events.length > this.maxEvents) {
      this.events.splice(0, this.events.length - this.maxEvents);
    }
    this.schedulePersist();
    this.notify();
    return clone(event);
  }

  list(
    options: {
      limit?: number;
      category?: RuntimeTraceCategory;
      taskId?: string;
    } = {},
  ): RuntimeTraceEvent[] {
    const limit = Math.max(1, Math.min(1_000, options.limit ?? 100));
    return clone(
      this.events
        .filter(
          (event) =>
            (!options.category || event.category === options.category) &&
            (!options.taskId || event.taskId === options.taskId),
        )
        .slice(-limit),
    );
  }

  replay(
    options: {
      from?: number;
      to?: number;
      taskId?: string;
    } = {},
  ): RuntimeTraceReplay {
    const from = options.from ?? 0;
    const to = options.to ?? Number.MAX_SAFE_INTEGER;
    const events = this.events.filter(
      (event) =>
        event.at >= from &&
        event.at <= to &&
        (!options.taskId || event.taskId === options.taskId),
    );
    const categories: Record<string, number> = {};
    const lifecycle = new Map<string, string[]>();
    const gaps: string[] = [];
    for (const event of events) {
      categories[event.category] = (categories[event.category] || 0) + 1;
      if (event.category !== 'task' || !event.taskId) continue;
      const states = lifecycle.get(event.taskId) || [];
      states.push(event.name);
      lifecycle.set(event.taskId, states);
    }
    const taskLifecycles = [...lifecycle.entries()].map(([taskId, states]) => {
      const complete = states.some((state) =>
        ['done', 'failed', 'cancelled'].includes(state),
      );
      if (!complete) gaps.push(`任务 ${taskId} 在回放区间内没有终态。`);
      if (
        !states.includes('started') &&
        states.some((state) => ['done', 'failed', 'cancelled'].includes(state))
      ) {
        gaps.push(`任务 ${taskId} 有终态但缺少 started 事件。`);
      }
      return { taskId, states, complete };
    });
    return {
      from,
      to,
      eventCount: events.length,
      categories,
      taskLifecycles,
      gaps,
    };
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  flush(): Promise<void> {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    return this.persist();
  }

  private notify(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch {
        // Trace observers must not block runtime behavior.
      }
    }
  }

  private async load(): Promise<void> {
    if (!this.stateFile) return;
    try {
      const parsed = JSON.parse(
        await fs.readFile(this.stateFile, 'utf8'),
      ) as PersistedRuntimeTrace;
      if (parsed.version !== 1 || !Array.isArray(parsed.events)) return;
      this.sequence = Math.max(0, parsed.sequence || 0);
      this.events.push(
        ...parsed.events
          .filter(
            (event) =>
              event &&
              typeof event.summary === 'string' &&
              !isSensitiveMemoryText(event.summary),
          )
          .slice(-this.maxEvents),
      );
      this.events.sort(
        (left, right) => left.sequence - right.sequence || left.at - right.at,
      );
      this.sequence = Math.max(
        this.sequence,
        ...this.events.map((event) => event.sequence),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn('[cyrvis trace] load failed', error);
      }
    }
  }

  private persist(): Promise<void> {
    if (!this.stateFile || process.env.CYRVIS_VOICE_TEST === '1') {
      return Promise.resolve();
    }
    const snapshot: PersistedRuntimeTrace = {
      version: 1,
      sequence: this.sequence,
      events: clone(this.events),
    };
    this.persistChain = this.persistChain
      .then(async () => {
        await fs.mkdir(path.dirname(this.stateFile!), { recursive: true });
        const temporary = `${this.stateFile}.${process.pid}.${randomUUID()}.tmp`;
        await fs.writeFile(
          temporary,
          JSON.stringify(snapshot, null, 2),
          'utf8',
        );
        for (let attempt = 0; attempt < 3; attempt += 1) {
          try {
            await fs.rename(temporary, this.stateFile!);
            break;
          } catch (error) {
            if (attempt === 2) throw error;
            await fs.mkdir(path.dirname(this.stateFile!), {
              recursive: true,
            });
            await new Promise((resolve) =>
              setTimeout(resolve, 25 * (attempt + 1)),
            );
          }
        }
      })
      .catch((error) => {
        console.warn('[cyrvis trace] persist failed', error);
      });
    return this.persistChain;
  }

  private schedulePersist(): void {
    if (!this.stateFile || process.env.CYRVIS_VOICE_TEST === '1') return;
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      void this.persist();
    }, 150);
    this.persistTimer.unref?.();
  }
}
