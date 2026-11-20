import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import type { ToolRegistry } from './registry';
import type { ToolResult } from './types';

export const WORKFLOW_STATE_VERSION = 1;
const MAX_WORKFLOW_STEPS = 32;
const DEFAULT_MAX_DURATION_MS = 30 * 60_000;

export type WorkflowRunStatus =
  | 'queued'
  | 'running'
  | 'waiting_confirmation'
  | 'paused'
  | 'cancelling'
  | 'done'
  | 'failed'
  | 'cancelled';

export type WorkflowStepStatus =
  | 'pending'
  | 'running'
  | 'waiting_confirmation'
  | 'done'
  | 'skipped'
  | 'failed'
  | 'cancelled';

export interface WorkflowCondition {
  kind:
    | 'path_exists'
    | 'path_missing'
    | 'path_is_file'
    | 'path_is_directory'
    | 'process_running'
    | 'process_missing'
    | 'window_exists'
    | 'window_missing';
  target: string | number;
  timeoutMs?: number;
  intervalMs?: number;
}

export interface WorkflowRetryPolicy {
  maxAttempts?: number;
  backoffMs?: number;
}

export interface WorkflowStepInput {
  id: string;
  tool: string;
  args?: Record<string, unknown>;
  dependsOn?: string[];
  when?: WorkflowCondition;
  verify?: WorkflowCondition;
  retry?: WorkflowRetryPolicy;
}

export interface WorkflowStartInput {
  name?: string;
  goal?: string;
  steps: WorkflowStepInput[];
  maxDurationMs?: number;
}

export interface WorkflowStepState extends WorkflowStepInput {
  status: WorkflowStepStatus;
  attempts: number;
  confirmed: boolean;
  result?: ToolResult;
  error?: string;
  startedAt?: number;
  endedAt?: number;
}

export interface WorkflowPendingConfirmation {
  stepId: string;
  tool: string;
  reason: string;
}

export interface WorkflowRun {
  id: string;
  name: string;
  goal: string;
  status: WorkflowRunStatus;
  steps: WorkflowStepState[];
  createdAt: number;
  updatedAt: number;
  startedAt: number | null;
  endedAt: number | null;
  maxDurationMs: number;
  cancelRequested: boolean;
  currentStepId: string | null;
  pendingConfirmation: WorkflowPendingConfirmation | null;
  error: string | null;
}

export interface WorkflowEngineEvent {
  type:
    | 'started'
    | 'step_done'
    | 'waiting_confirmation'
    | 'done'
    | 'failed'
    | 'cancelled';
  run: WorkflowRun;
  stepId?: string;
  message: string;
}

interface PersistedWorkflowState {
  version: number;
  runs: WorkflowRun[];
}

export interface WorkflowEngineOptions {
  stateFile?: string;
  now?: () => number;
  idFactory?: () => string;
  maxConcurrentRuns?: number;
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const readPath = (value: unknown, pathParts: string[]): unknown => {
  let current = value;
  for (const part of pathParts) {
    if (
      part === '__proto__' ||
      part === 'prototype' ||
      part === 'constructor'
    ) {
      return undefined;
    }
    if (!current || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
};

const resolveTemplateString = (
  value: string,
  results: Map<string, ToolResult>,
): unknown => {
  const exact = value.match(/^\{\{steps\.([A-Za-z0-9_-]+)\.([^}]+)\}\}$/);
  if (exact) {
    return readPath(results.get(exact[1]), exact[2].split('.'));
  }
  return value.replace(
    /\{\{steps\.([A-Za-z0-9_-]+)\.([^}]+)\}\}/g,
    (_match, stepId: string, resultPath: string) => {
      const resolved = readPath(results.get(stepId), resultPath.split('.'));
      return resolved === undefined || resolved === null
        ? ''
        : String(resolved);
    },
  );
};

export const resolveWorkflowTemplates = (
  value: unknown,
  results: Map<string, ToolResult>,
): unknown => {
  if (typeof value === 'string') {
    return resolveTemplateString(value, results);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => resolveWorkflowTemplates(entry, results));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        resolveWorkflowTemplates(entry, results),
      ]),
    );
  }
  return value;
};

export const validateWorkflowStructure = (steps: WorkflowStepInput[]): void => {
  if (!steps.length || steps.length > MAX_WORKFLOW_STEPS) {
    throw new Error(`工作流步骤数必须在 1 到 ${MAX_WORKFLOW_STEPS} 之间。`);
  }
  const ids = new Set<string>();
  for (const step of steps) {
    if (!step.id.trim() || !/^[A-Za-z0-9_-]+$/.test(step.id)) {
      throw new Error(`无效步骤 ID：${step.id}`);
    }
    if (ids.has(step.id)) throw new Error(`重复步骤 ID：${step.id}`);
    ids.add(step.id);
    if (!step.tool.trim()) throw new Error(`步骤 ${step.id} 缺少工具名。`);
    if (step.tool.startsWith('workflow.')) {
      throw new Error('工作流步骤不能递归调用 workflow.* 工具。');
    }
  }
  for (const step of steps) {
    for (const dependency of step.dependsOn || []) {
      if (!ids.has(dependency)) {
        throw new Error(`步骤 ${step.id} 依赖不存在的步骤 ${dependency}。`);
      }
      if (dependency === step.id) {
        throw new Error(`步骤 ${step.id} 不能依赖自身。`);
      }
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const byId = new Map(steps.map((step) => [step.id, step]));
  const visit = (stepId: string) => {
    if (visiting.has(stepId)) throw new Error('工作流依赖存在循环。');
    if (visited.has(stepId)) return;
    visiting.add(stepId);
    for (const dependency of byId.get(stepId)?.dependsOn || []) {
      visit(dependency);
    }
    visiting.delete(stepId);
    visited.add(stepId);
  };
  for (const step of steps) visit(step.id);
};

export class LocalWorkflowEngine {
  private readonly runs = new Map<string, WorkflowRun>();
  private readonly listeners = new Set<(event: WorkflowEngineEvent) => void>();
  private readonly now: () => number;
  private readonly idFactory: () => string;
  private readonly stateFile?: string;
  private readonly maxConcurrentRuns: number;
  private readonly readyPromise: Promise<void>;
  private persistChain = Promise.resolve();
  private pumpPromise: Promise<void> | null = null;
  private disposed = false;

  constructor(
    private readonly registry: ToolRegistry,
    options: WorkflowEngineOptions = {},
  ) {
    this.now = options.now || Date.now;
    this.idFactory = options.idFactory || randomUUID;
    this.stateFile = options.stateFile
      ? path.resolve(options.stateFile)
      : undefined;
    this.maxConcurrentRuns = Math.max(
      1,
      Math.min(4, options.maxConcurrentRuns ?? 1),
    );
    this.readyPromise = this.load();
  }

  ready(): Promise<void> {
    return this.readyPromise;
  }

  subscribe(listener: (event: WorkflowEngineEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async start(input: WorkflowStartInput): Promise<WorkflowRun> {
    await this.readyPromise;
    validateWorkflowStructure(input.steps);
    for (const step of input.steps) {
      if (!this.registry.get(step.tool)) {
        throw new Error(`步骤 ${step.id} 使用未知工具：${step.tool}`);
      }
    }
    const at = this.now();
    const run: WorkflowRun = {
      id: this.idFactory(),
      name: input.name?.trim() || input.goal?.trim() || '本地工作流',
      goal: input.goal?.trim() || '',
      status: 'queued',
      steps: input.steps.map((step) => ({
        ...clone(step),
        args: step.args || {},
        dependsOn: [...(step.dependsOn || [])],
        status: 'pending',
        attempts: 0,
        confirmed: false,
      })),
      createdAt: at,
      updatedAt: at,
      startedAt: null,
      endedAt: null,
      maxDurationMs: Math.max(
        10_000,
        Math.min(
          24 * 60 * 60_000,
          input.maxDurationMs ?? DEFAULT_MAX_DURATION_MS,
        ),
      ),
      cancelRequested: false,
      currentStepId: null,
      pendingConfirmation: null,
      error: null,
    };
    this.runs.set(run.id, run);
    await this.persist();
    this.emit(run, 'started', `工作流 ${run.name} 已启动。`);
    this.pump();
    return clone(run);
  }

  async get(runId?: string): Promise<WorkflowRun | null> {
    await this.readyPromise;
    if (runId) return clone(this.runs.get(runId) || null);
    return clone(
      [...this.runs.values()].sort(
        (left, right) => right.createdAt - left.createdAt,
      )[0] || null,
    );
  }

  async list(activeOnly = false): Promise<WorkflowRun[]> {
    await this.readyPromise;
    return clone(
      [...this.runs.values()]
        .filter(
          (run) =>
            !activeOnly ||
            !['done', 'failed', 'cancelled'].includes(run.status),
        )
        .sort((left, right) => right.createdAt - left.createdAt),
    );
  }

  latestSnapshot(activeOnly = true): WorkflowRun | null {
    const run = this.latest(
      (entry) =>
        !activeOnly || !['done', 'failed', 'cancelled'].includes(entry.status),
    );
    return run ? clone(run) : null;
  }

  async cancel(runId?: string): Promise<WorkflowRun | null> {
    await this.readyPromise;
    const run = runId
      ? this.runs.get(runId)
      : this.latest((entry) =>
          ['queued', 'running', 'waiting_confirmation', 'paused'].includes(
            entry.status,
          ),
        );
    if (!run) return null;
    run.cancelRequested = true;
    if (
      run.status === 'queued' ||
      run.status === 'waiting_confirmation' ||
      run.status === 'paused'
    ) {
      run.status = 'cancelled';
      run.endedAt = this.now();
      run.pendingConfirmation = null;
      for (const step of run.steps) {
        if (
          step.status === 'pending' ||
          step.status === 'waiting_confirmation'
        ) {
          step.status = 'cancelled';
        }
      }
      this.emit(run, 'cancelled', `工作流 ${run.name} 已取消。`);
    } else if (run.status === 'running') {
      run.status = 'cancelling';
    }
    this.touch(run);
    await this.persist();
    return clone(run);
  }

  async confirm(runId?: string, stepId?: string): Promise<WorkflowRun | null> {
    await this.readyPromise;
    const run = runId
      ? this.runs.get(runId)
      : this.latest((entry) => entry.status === 'waiting_confirmation');
    if (!run) return null;
    const resolvedStepId = stepId || run.pendingConfirmation?.stepId;
    if (
      run.status !== 'waiting_confirmation' ||
      !resolvedStepId ||
      run.pendingConfirmation?.stepId !== resolvedStepId
    ) {
      throw new Error('当前没有等待确认的对应工作流步骤。');
    }
    const step = run.steps.find((entry) => entry.id === resolvedStepId);
    if (!step) throw new Error(`步骤不存在：${resolvedStepId}`);
    step.confirmed = true;
    step.attempts = Math.max(0, step.attempts - 1);
    step.status = 'pending';
    step.error = undefined;
    run.pendingConfirmation = null;
    run.status = 'queued';
    this.touch(run);
    await this.persist();
    this.pump();
    return clone(run);
  }

  async resume(runId?: string): Promise<WorkflowRun | null> {
    await this.readyPromise;
    const run = runId
      ? this.runs.get(runId)
      : this.latest((entry) => entry.status === 'paused');
    if (!run) return null;
    if (run.status !== 'paused') {
      throw new Error('只有已暂停或中断的工作流可以恢复。');
    }
    for (const step of run.steps) {
      if (step.status === 'running') step.status = 'pending';
    }
    run.status = 'queued';
    run.error = null;
    run.cancelRequested = false;
    this.touch(run);
    await this.persist();
    this.pump();
    return clone(run);
  }

  dispose(): void {
    this.disposed = true;
    for (const run of this.runs.values()) {
      if (['queued', 'running', 'cancelling'].includes(run.status)) {
        run.status = 'paused';
        run.error = '应用退出或工作流引擎已停止。';
      }
    }
    void this.persist();
  }

  private pump(): void {
    if (this.disposed || this.pumpPromise) return;
    this.pumpPromise = this.runQueuedWorkflows()
      .catch((error) => {
        console.error('[cyrvis workflow] scheduler failed', error);
      })
      .finally(() => {
        this.pumpPromise = null;
        if (
          !this.disposed &&
          [...this.runs.values()].some((run) => run.status === 'queued')
        ) {
          this.pump();
        }
      });
  }

  private async runQueuedWorkflows(): Promise<void> {
    let active = 0;
    const queue = () =>
      [...this.runs.values()]
        .filter((run) => run.status === 'queued')
        .sort((left, right) => left.createdAt - right.createdAt);
    while (!this.disposed) {
      const available = queue().slice(
        0,
        Math.max(0, this.maxConcurrentRuns - active),
      );
      if (!available.length) return;
      await Promise.all(
        available.map(async (run) => {
          active += 1;
          try {
            await this.executeRun(run);
          } catch (error) {
            run.status = 'failed';
            run.error = error instanceof Error ? error.message : String(error);
            run.endedAt = this.now();
            this.touch(run);
            await this.persist();
            this.emit(run, 'failed', run.error);
          } finally {
            active -= 1;
          }
        }),
      );
    }
  }

  private async executeRun(run: WorkflowRun): Promise<void> {
    run.status = 'running';
    run.startedAt ||= this.now();
    this.touch(run);
    await this.persist();
    const results = new Map<string, ToolResult>();
    for (const step of run.steps) {
      if (step.result) results.set(step.id, step.result);
    }

    while (!this.disposed) {
      if (run.cancelRequested) {
        run.status = 'cancelled';
        run.endedAt = this.now();
        this.touch(run);
        await this.persist();
        this.emit(run, 'cancelled', `工作流 ${run.name} 已取消。`);
        return;
      }
      if (run.startedAt && this.now() - run.startedAt > run.maxDurationMs) {
        run.status = 'failed';
        run.error = '工作流超过最大运行时间。';
        run.endedAt = this.now();
        this.touch(run);
        await this.persist();
        this.emit(run, 'failed', run.error);
        return;
      }

      const step = this.nextStep(run);
      if (!step) {
        const waiting = run.steps.some(
          (entry) =>
            entry.status === 'pending' ||
            entry.status === 'running' ||
            entry.status === 'waiting_confirmation',
        );
        if (!waiting) {
          run.status = run.steps.some((entry) => entry.status === 'failed')
            ? 'failed'
            : 'done';
          run.endedAt = this.now();
          this.touch(run);
          await this.persist();
          this.emit(
            run,
            run.status === 'done' ? 'done' : 'failed',
            run.status === 'done'
              ? `工作流 ${run.name} 已完成。`
              : run.error || `工作流 ${run.name} 失败。`,
          );
        }
        return;
      }

      if (step.when) {
        const condition = await this.checkCondition(step.when, false);
        if (!condition.ok) {
          step.status = 'skipped';
          step.endedAt = this.now();
          this.touch(run);
          await this.persist();
          continue;
        }
      }

      run.currentStepId = step.id;
      step.status = 'running';
      step.startedAt = this.now();
      step.endedAt = undefined;
      step.error = undefined;
      this.touch(run);
      await this.persist();

      const retry = {
        maxAttempts: Math.max(1, Math.min(5, step.retry?.maxAttempts ?? 1)),
        backoffMs: Math.max(0, Math.min(60_000, step.retry?.backoffMs ?? 500)),
      };
      let result: ToolResult | null = null;
      let verificationError = '';
      while (step.attempts < retry.maxAttempts) {
        step.attempts += 1;
        const args = resolveWorkflowTemplates(
          step.args || {},
          results,
        ) as Record<string, unknown>;
        try {
          result = await this.registry.execute(step.tool, args, {
            confirmed: step.confirmed,
          });
        } catch (error) {
          result = {
            ok: false,
            tool: step.tool,
            speech: error instanceof Error ? error.message : String(error),
            error: {
              code: 'WORKFLOW_STEP_EXCEPTION',
              message: error instanceof Error ? error.message : String(error),
            },
          };
        }
        if (!result.ok) {
          verificationError = result.error?.message || result.speech;
        } else if (step.verify) {
          const verified = await this.checkCondition(step.verify, true);
          if (!verified.ok) {
            result = verified;
            verificationError = verified.error?.message || verified.speech;
          }
        }
        if (result.ok) break;
        if (step.attempts < retry.maxAttempts) {
          await new Promise((resolve) => setTimeout(resolve, retry.backoffMs));
        }
      }

      step.result = result || undefined;
      run.currentStepId = null;
      step.endedAt = this.now();
      if (result?.ok) {
        step.status = 'done';
        results.set(step.id, result);
        this.emit(
          run,
          'step_done',
          `工作流 ${run.name} 已完成步骤 ${step.id}。`,
          step.id,
        );
      } else {
        step.status = 'failed';
        step.error = verificationError || result?.speech || '步骤执行失败。';
        run.status = 'failed';
        run.error = `步骤 ${step.id} 失败：${step.error}`;
        run.endedAt = this.now();
        for (const pending of run.steps) {
          if (pending.status === 'pending') pending.status = 'skipped';
        }
        this.touch(run);
        await this.persist();
        this.emit(run, 'failed', run.error);
        return;
      }
      this.touch(run);
      await this.persist();
    }
  }

  private nextStep(run: WorkflowRun): WorkflowStepState | null {
    const states = new Map(run.steps.map((step) => [step.id, step.status]));
    return (
      run.steps.find(
        (step) =>
          step.status === 'pending' &&
          (step.dependsOn || []).every((dependency) =>
            ['done', 'skipped'].includes(states.get(dependency) || ''),
          ),
      ) || null
    );
  }

  private latest(predicate: (run: WorkflowRun) => boolean): WorkflowRun | null {
    return (
      [...this.runs.values()]
        .filter(predicate)
        .sort((left, right) => right.createdAt - left.createdAt)[0] || null
    );
  }

  private async checkCondition(
    condition: WorkflowCondition,
    wait: boolean,
  ): Promise<ToolResult> {
    const tool =
      wait && condition.timeoutMs ? 'condition.wait' : 'condition.check';
    if (!this.registry.get(tool)) {
      return {
        ok: false,
        tool,
        speech: `工作流缺少验证工具：${tool}`,
        error: {
          code: 'WORKFLOW_CONDITION_TOOL_MISSING',
          message: `Unknown workflow condition tool: ${tool}`,
        },
      };
    }
    return this.registry.execute(tool, {
      kind: condition.kind,
      target: String(condition.target),
      ...(tool === 'condition.wait'
        ? {
            timeoutMs: condition.timeoutMs,
            intervalMs: condition.intervalMs ?? 250,
          }
        : {}),
    });
  }

  private touch(run: WorkflowRun): void {
    run.updatedAt = this.now();
  }

  private emit(
    run: WorkflowRun,
    type: WorkflowEngineEvent['type'],
    message: string,
    stepId?: string,
  ): void {
    const event: WorkflowEngineEvent = {
      type,
      run: clone(run),
      stepId,
      message,
    };
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch {
        // Workflow observers must not interrupt execution.
      }
    }
  }

  private async load(): Promise<void> {
    if (!this.stateFile) return;
    try {
      const parsed = JSON.parse(
        await fs.readFile(this.stateFile, 'utf8'),
      ) as PersistedWorkflowState;
      if (
        parsed.version !== WORKFLOW_STATE_VERSION ||
        !Array.isArray(parsed.runs)
      ) {
        return;
      }
      let resumeMigratedWaitingRuns = false;
      for (const run of parsed.runs) {
        if (run.status === 'waiting_confirmation') {
          run.status = 'queued';
          run.pendingConfirmation = null;
          for (const step of run.steps) {
            if (step.status === 'waiting_confirmation') {
              step.status = 'pending';
              step.confirmed = true;
            }
          }
          resumeMigratedWaitingRuns = true;
        } else if (['queued', 'running', 'cancelling'].includes(run.status)) {
          run.status = 'paused';
          run.error = '应用上次退出时工作流仍在运行，可确认上下文后恢复。';
          for (const step of run.steps) {
            if (step.status === 'running') step.status = 'pending';
          }
        }
        this.runs.set(run.id, run);
      }
      if (resumeMigratedWaitingRuns) {
        await this.persist();
        this.pump();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn('[cyrvis workflow] state load failed', error);
      }
    }
  }

  private persist(): Promise<void> {
    if (!this.stateFile) return Promise.resolve();
    const snapshot: PersistedWorkflowState = {
      version: WORKFLOW_STATE_VERSION,
      runs: [...this.runs.values()],
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
        console.warn('[cyrvis workflow] state persist failed', error);
      });
    return this.persistChain;
  }
}
