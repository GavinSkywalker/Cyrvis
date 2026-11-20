import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import type { RuntimeMemoryStore } from './runtime-memory';
import type { TaskScheduler } from './task-scheduler';
import type {
  AutonomyGoal,
  AutonomyMode,
  AutonomyProposal,
  AutonomySnapshot,
  RuntimeTask,
  RuntimeTaskEvent,
} from './types';

export interface AutonomyEngineOptions {
  stateFile?: string;
  now?: () => number;
  idFactory?: () => string;
  mode?: AutonomyMode;
  maxPerHour?: number;
  checkIntervalMs?: number;
  quietStart?: string;
  quietEnd?: string;
}

interface PersistedAutonomyState {
  version: 1;
  mode: AutonomyMode;
  maxPerHour: number;
  proposals: AutonomyProposal[];
  goals: AutonomyGoal[];
}

export interface AutonomySignals {
  activity: string;
  activeApplication: string | null;
  activeWindow: string | null;
  gazeTarget: string | null;
  recentUtterance: string | null;
  focusedControl?: string | null;
  recentUtteranceAgeMs?: number | null;
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const parseClockMinutes = (value: string): number | null => {
  const match = value.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (
    !Number.isInteger(hours) ||
    !Number.isInteger(minutes) ||
    hours < 0 ||
    hours > 23 ||
    minutes < 0 ||
    minutes > 59
  ) {
    return null;
  }
  return hours * 60 + minutes;
};

export class AutonomyEngine {
  private readonly now: () => number;
  private readonly idFactory: () => string;
  private readonly stateFile?: string;
  private readonly checkIntervalMs: number;
  private mode: AutonomyMode;
  private maxPerHour: number;
  private proposals: AutonomyProposal[] = [];
  private goals: AutonomyGoal[] = [];
  private readonly listeners = new Set<() => void>();
  private readonly proposalListeners = new Set<
    (proposal: AutonomyProposal) => void
  >();
  private readonly feedbackListeners = new Set<
    (feedback: 'accepted' | 'rejected' | 'ignored') => void
  >();
  private readonly quietStart: string | null;
  private readonly quietEnd: string | null;
  private attentionCost = 0.1;
  private revision = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private signalProvider: (() => AutonomySignals | null) | null = null;
  private readyPromise: Promise<void>;
  private persistChain = Promise.resolve();
  private readonly unsubscribeScheduler: () => void;

  constructor(
    private readonly scheduler: TaskScheduler,
    private readonly memory: RuntimeMemoryStore,
    options: AutonomyEngineOptions = {},
  ) {
    this.now = options.now || Date.now;
    this.idFactory = options.idFactory || randomUUID;
    this.stateFile = options.stateFile
      ? path.resolve(options.stateFile)
      : undefined;
    this.checkIntervalMs =
      typeof options.checkIntervalMs === 'number' &&
      Number.isFinite(options.checkIntervalMs)
        ? Math.max(5_000, options.checkIntervalMs)
        : 15_000;
    this.mode =
      options.mode ||
      (['off', 'suggest', 'low-risk'].includes(
        process.env.CYRVIS_AUTONOMY_MODE || '',
      )
        ? (process.env.CYRVIS_AUTONOMY_MODE as AutonomyMode)
        : 'suggest');
    this.maxPerHour = Math.max(1, Math.min(20, options.maxPerHour ?? 4));
    this.quietStart =
      options.quietStart?.trim() ||
      process.env.CYRVIS_AUTONOMY_QUIET_START?.trim() ||
      null;
    this.quietEnd =
      options.quietEnd?.trim() ||
      process.env.CYRVIS_AUTONOMY_QUIET_END?.trim() ||
      null;
    this.readyPromise = this.load();
    this.unsubscribeScheduler = scheduler.subscribe((event) =>
      this.handleTaskEvent(event),
    );
  }

  ready(): Promise<void> {
    return this.readyPromise;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  subscribeProposals(
    listener: (proposal: AutonomyProposal) => void,
  ): () => void {
    this.proposalListeners.add(listener);
    return () => this.proposalListeners.delete(listener);
  }

  subscribeFeedback(
    listener: (feedback: 'accepted' | 'rejected' | 'ignored') => void,
  ): () => void {
    this.feedbackListeners.add(listener);
    return () => this.feedbackListeners.delete(listener);
  }

  setSignalProvider(provider: (() => AutonomySignals | null) | null): void {
    this.signalProvider = provider;
  }

  start(): void {
    if (this.timer || this.mode === 'off') return;
    this.timer = setInterval(() => {
      void this.tick().catch(() => undefined);
    }, this.checkIntervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  dispose(): void {
    this.stop();
    this.unsubscribeScheduler();
    this.proposalListeners.clear();
    this.feedbackListeners.clear();
    void this.persist();
  }

  snapshot(): AutonomySnapshot {
    this.prune();
    const cutoff = this.now() - 60 * 60_000;
    const recent = this.proposals.filter(
      (proposal) => proposal.createdAt >= cutoff,
    );
    const latest = [...recent].sort(
      (left, right) => right.createdAt - left.createdAt,
    )[0];
    return {
      revision: this.revision,
      mode: this.mode,
      enabled: this.mode !== 'off',
      proposals: clone(this.proposals),
      goals: clone(this.goals),
      budget: {
        maxPerHour: this.maxPerHour,
        usedLastHour: recent.length,
        nextAllowedAt:
          recent.length >= this.maxPerHour && latest
            ? latest.createdAt + 60 * 60_000
            : 0,
        quietHours: {
          start: this.quietStart,
          end: this.quietEnd,
          active: this.isQuietHours(),
        },
        feedback: {
          accepted: this.proposals.filter((proposal) =>
            ['queued', 'accepted'].includes(proposal.status),
          ).length,
          rejected: this.proposals.filter(
            (proposal) => proposal.status === 'rejected',
          ).length,
          ignored: this.proposals.filter(
            (proposal) => proposal.status === 'expired',
          ).length,
        },
      },
    };
  }

  getContext(): string {
    const snapshot = this.snapshot();
    const proposed = snapshot.proposals.filter(
      (proposal) => proposal.status === 'proposed',
    );
    return [
      '[Autonomy state - proposals are not execution authorization]',
      `Mode: ${snapshot.mode}`,
      `Budget used this hour: ${snapshot.budget.usedLastHour}/${snapshot.budget.maxPerHour}`,
      proposed.length
        ? `Open proposals: ${proposed
            .slice(-5)
            .map((proposal) => `${proposal.id}:${proposal.title}`)
            .join(' | ')}`
        : 'Open proposals: none',
      snapshot.goals.length
        ? `Standing goals: ${snapshot.goals
            .filter((goal) => goal.enabled)
            .map((goal) => goal.text)
            .join(' | ')}`
        : '',
    ]
      .filter(Boolean)
      .join('\n');
  }

  async configure(
    mode: AutonomyMode,
    maxPerHour = this.maxPerHour,
  ): Promise<AutonomySnapshot> {
    await this.readyPromise;
    this.mode = mode;
    this.maxPerHour = Math.max(1, Math.min(20, maxPerHour));
    if (mode === 'off') this.stop();
    else this.start();
    this.touch();
    await this.persist();
    return this.snapshot();
  }

  async addGoal(text: string, intervalMs = 30 * 60_000): Promise<AutonomyGoal> {
    await this.readyPromise;
    const normalized = text.trim().slice(0, 500);
    if (!normalized) throw new Error('Autonomy goal is required.');
    const goal: AutonomyGoal = {
      id: this.idFactory(),
      text: normalized,
      enabled: true,
      intervalMs: Math.max(5 * 60_000, intervalMs),
      nextRunAt: this.now(),
      lastProposedAt: null,
    };
    this.goals.push(goal);
    void this.memory.append({
      kind: 'preference',
      text: `自主长期目标：${normalized}`,
      metadata: { goalId: goal.id },
    });
    this.touch();
    await this.persist();
    return clone(goal);
  }

  async removeGoal(goalId: string): Promise<boolean> {
    await this.readyPromise;
    const previous = this.goals.length;
    this.goals = this.goals.filter((goal) => goal.id !== goalId);
    if (this.goals.length === previous) return false;
    this.touch();
    await this.persist();
    return true;
  }

  async accept(proposalId: string): Promise<RuntimeTask | null> {
    await this.readyPromise;
    const proposal = this.proposals.find((entry) => entry.id === proposalId);
    if (!proposal || proposal.status !== 'proposed') return null;
    if (this.now() >= proposal.expiresAt) {
      proposal.status = 'expired';
      this.touch();
      await this.persist();
      return null;
    }
    const task = await this.scheduler.submit({
      source: 'autonomy',
      kind: proposal.taskKind,
      goal: proposal.goal,
      payload: proposal.payload,
      priorityClass: 'autonomy',
      risk: proposal.risk,
      preemptible: true,
    });
    proposal.status = 'queued';
    proposal.queuedTaskId = task.id;
    this.touch();
    this.emitFeedback('accepted');
    await this.memory.append({
      kind: 'autonomy',
      text: `用户接受了自主建议：${proposal.title}`,
      metadata: { proposalId, taskId: task.id },
    });
    await this.persist();
    return task;
  }

  async reject(proposalId: string): Promise<boolean> {
    await this.readyPromise;
    const proposal = this.proposals.find((entry) => entry.id === proposalId);
    if (!proposal || proposal.status !== 'proposed') return false;
    proposal.status = 'rejected';
    this.touch();
    this.emitFeedback('rejected');
    await this.memory.append({
      kind: 'autonomy',
      text: `用户拒绝了自主建议：${proposal.title}`,
      metadata: { proposalId },
    });
    await this.persist();
    return true;
  }

  async tick(): Promise<AutonomySnapshot> {
    await this.readyPromise;
    if (this.mode === 'off' || this.budgetFull()) return this.snapshot();
    const now = this.now();
    const signal = this.signalProvider?.() || null;
    this.attentionCost = this.computeAttentionCost(signal);
    for (const goal of this.goals) {
      if (!goal.enabled || goal.nextRunAt > now) continue;
      this.propose({
        title: `推进长期目标：${goal.text.slice(0, 80)}`,
        reason: '用户设置了长期目标，当前到达检查时间。',
        goal: goal.text,
        taskKind: 'gui',
        payload: {
          instruction: goal.text,
          metadata: { autonomyGoalId: goal.id },
        },
        risk: 'medium',
        confidence: 0.72,
        score: 55,
      });
      goal.lastProposedAt = now;
      goal.nextRunAt = now + goal.intervalMs;
      this.touch();
      if (this.budgetFull()) break;
    }
    if (!this.budgetFull() && !this.scheduler.list(true).length) {
      if (signal) {
        if (
          signal.gazeTarget &&
          ['coding', 'editing', 'browsing', 'reading'].includes(signal.activity)
        ) {
          this.propose({
            title: `检查当前注视内容：${signal.gazeTarget.slice(0, 80)}`,
            reason: '用户持续关注当前区域，可能希望获得解释或下一步建议。',
            goal: `检查用户当前注视的“${signal.gazeTarget}”区域，理解可见内容并给出简短、只读的下一步建议，不自动修改。`,
            taskKind: 'gui',
            payload: {
              instruction: `查看当前界面中用户正在注视的区域，读取可见内容并给出下一步建议，不执行修改。`,
            },
            risk: 'medium',
            confidence: 0.58,
            score: 35,
          });
        } else if (
          signal.activeWindow &&
          /错误|失败|无响应|error|failed|not responding/i.test(
            signal.activeWindow,
          )
        ) {
          this.propose({
            title: `检查异常窗口：${signal.activeWindow.slice(0, 80)}`,
            reason: '当前窗口标题包含错误或失败信号。',
            goal: `检查当前异常窗口“${signal.activeWindow}”，解释问题并给出安全处理建议。`,
            taskKind: 'gui',
            payload: {
              instruction: `检查当前窗口中的错误信息并解释，不点击确认、购买或删除。`,
            },
            risk: 'medium',
            confidence: 0.66,
            score: 45,
          });
        }
      }
    }
    this.prune();
    await this.persist();
    return this.snapshot();
  }

  private handleTaskEvent(event: RuntimeTaskEvent): void {
    if (event.type !== 'failed') return;
    const task = event.task;
    this.attentionCost = this.computeAttentionCost(
      this.signalProvider?.() || null,
    );
    this.propose({
      title: `检查失败任务：${task.goal.slice(0, 70)}`,
      reason: `任务失败：${task.error || event.message}`,
      goal: `检查任务“${task.goal}”的失败原因并给出下一步建议。`,
      taskKind: 'observe',
      payload: {
        tool: 'system.snapshot',
        args: {},
        metadata: { failedTaskId: task.id },
      },
      risk: 'low',
      confidence: 0.82,
      score: 65,
    });
    void this.persist();
  }

  private propose(input: {
    title: string;
    reason: string;
    goal: string;
    taskKind: AutonomyProposal['taskKind'];
    payload: AutonomyProposal['payload'];
    risk: AutonomyProposal['risk'];
    confidence: number;
    score: number;
  }): AutonomyProposal | null {
    if (this.mode === 'off' || this.budgetFull()) return null;
    const duplicate = this.proposals.some(
      (proposal) =>
        proposal.status === 'proposed' &&
        proposal.goal === input.goal &&
        this.now() - proposal.createdAt < 10 * 60_000,
    );
    if (duplicate) return null;
    const at = this.now();
    const proposal: AutonomyProposal = {
      id: this.idFactory(),
      title: input.title.slice(0, 160),
      reason: input.reason.slice(0, 500),
      goal: input.goal.slice(0, 500),
      taskKind: input.taskKind,
      payload: clone(input.payload),
      risk: input.risk,
      sideEffect:
        input.risk === 'high'
          ? 'irreversible'
          : input.taskKind === 'observe'
            ? 'read'
            : 'external',
      confidence: Math.max(0, Math.min(1, input.confidence)),
      score: this.adjustScore(input.score, input.confidence, input.title),
      attentionCost: this.attentionCost,
      interruptive:
        !this.isQuietHours() &&
        this.attentionCost < 0.7 &&
        input.confidence >= 0.55,
      createdAt: at,
      expiresAt: at + 5 * 60_000,
      status: 'proposed',
      queuedTaskId: null,
    };
    this.proposals = [...this.proposals, proposal].slice(-100);
    this.touch();
    for (const listener of [...this.proposalListeners]) {
      try {
        listener(clone(proposal));
      } catch {
        // Autonomy proposal observers must not block behavior.
      }
    }
    void this.memory.append({
      kind: 'autonomy',
      text: `生成自主建议：${proposal.title}`,
      metadata: { proposalId: proposal.id, score: proposal.score },
    });
    if (this.mode === 'low-risk' && proposal.risk === 'low') {
      void this.accept(proposal.id).catch(() => undefined);
    }
    return clone(proposal);
  }

  private adjustScore(base: number, confidence: number, title: string): number {
    const category = title.split(/[：:]/)[0] || title.slice(0, 12);
    const related = this.proposals.filter((proposal) =>
      proposal.title.startsWith(category),
    );
    const accepted = related.filter((proposal) =>
      ['queued', 'accepted'].includes(proposal.status),
    ).length;
    const rejected = related.filter(
      (proposal) => proposal.status === 'rejected',
    ).length;
    const total = accepted + rejected;
    const acceptance = (accepted + 1) / (total + 2);
    return Math.max(
      0,
      Math.min(100, base * 0.75 + confidence * 20 + acceptance * 15),
    );
  }

  private computeAttentionCost(signal: AutonomySignals | null): number {
    if (!signal) return 0.1;
    const activityCost: Record<string, number> = {
      idle: 0.05,
      unknown: 0.15,
      reading: 0.25,
      browsing: 0.3,
      watching: 0.35,
      editing: 0.55,
      coding: 0.6,
      operating: 0.8,
    };
    let cost = activityCost[signal.activity] ?? 0.3;
    if (
      signal.recentUtteranceAgeMs !== null &&
      signal.recentUtteranceAgeMs !== undefined &&
      signal.recentUtteranceAgeMs < 60_000
    ) {
      cost += 0.25;
    }
    if (signal.gazeTarget) cost += 0.05;
    if (signal.focusedControl) cost += 0.05;
    return Math.max(0, Math.min(1, cost));
  }

  private isQuietHours(now = new Date()): boolean {
    if (!this.quietStart || !this.quietEnd) return false;
    const start = parseClockMinutes(this.quietStart);
    const end = parseClockMinutes(this.quietEnd);
    if (start === null || end === null || start === end) return false;
    const current = now.getHours() * 60 + now.getMinutes();
    return start < end
      ? current >= start && current < end
      : current >= start || current < end;
  }

  private emitFeedback(feedback: 'accepted' | 'rejected' | 'ignored'): void {
    for (const listener of [...this.feedbackListeners]) {
      try {
        listener(feedback);
      } catch {
        // Feedback observers must not block autonomy.
      }
    }
  }

  private budgetFull(): boolean {
    const cutoff = this.now() - 60 * 60_000;
    return (
      this.proposals.filter((proposal) => proposal.createdAt >= cutoff)
        .length >= this.maxPerHour
    );
  }

  private prune(): void {
    const now = this.now();
    for (const proposal of this.proposals) {
      if (proposal.status === 'proposed' && proposal.expiresAt <= now) {
        proposal.status = 'expired';
        this.emitFeedback('ignored');
      }
    }
    this.proposals = this.proposals
      .filter(
        (proposal) =>
          proposal.status === 'proposed' ||
          now - proposal.createdAt < 7 * 24 * 60 * 60_000,
      )
      .slice(-100);
  }

  private touch(): void {
    this.revision += 1;
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch {
        // Autonomy observers must not block behavior.
      }
    }
  }

  private async load(): Promise<void> {
    if (!this.stateFile) return;
    try {
      const parsed = JSON.parse(
        await fs.readFile(this.stateFile, 'utf8'),
      ) as PersistedAutonomyState;
      if (parsed.version !== 1) return;
      this.mode = parsed.mode || this.mode;
      this.maxPerHour = Math.max(1, parsed.maxPerHour || this.maxPerHour);
      this.proposals = Array.isArray(parsed.proposals) ? parsed.proposals : [];
      for (const proposal of this.proposals) {
        proposal.sideEffect ??=
          proposal.risk === 'high'
            ? 'irreversible'
            : proposal.taskKind === 'observe'
              ? 'read'
              : 'external';
        proposal.attentionCost ??= 0.45;
        proposal.interruptive ??= true;
      }
      this.goals = Array.isArray(parsed.goals) ? parsed.goals : [];
      this.prune();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn('[cyrvis autonomy] load failed', error);
      }
    }
  }

  private persist(): Promise<void> {
    if (!this.stateFile) return Promise.resolve();
    const snapshot: PersistedAutonomyState = {
      version: 1,
      mode: this.mode,
      maxPerHour: this.maxPerHour,
      proposals: clone(this.proposals),
      goals: clone(this.goals),
    };
    this.persistChain = this.persistChain
      .then(async () => {
        await fs.mkdir(path.dirname(this.stateFile!), { recursive: true });
        const temporary = `${this.stateFile}.${process.pid}.tmp`;
        await fs.writeFile(
          temporary,
          JSON.stringify(snapshot, null, 2),
          'utf8',
        );
        await fs.rename(temporary, this.stateFile!);
      })
      .catch((error) => {
        console.warn('[cyrvis autonomy] persist failed', error);
      });
    return this.persistChain;
  }
}
