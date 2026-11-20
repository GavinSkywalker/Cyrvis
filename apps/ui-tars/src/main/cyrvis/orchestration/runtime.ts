import path from 'node:path';

import type { RuntimeSnapshotView } from '@shared/orchestration';

import type { CodingAgentService } from '../coding-agent';
import type { DynamicContextStore } from '../context';
import type { CyrvisController } from '../controller';
import type { SystemStateStore } from '../system/system-state';
import type { CapabilityCatalog } from '../tools/capability-catalog';
import type { ToolRegistry } from '../tools/registry';
import type { ProviderRegistry } from '../tools/provider-registry';
import type { LocalWorkflowEngine } from '../tools/workflow-engine';
import { AutonomyEngine } from './autonomy-engine';
import { CapabilitySynthesisService } from './capability-synthesis';
import {
  AtomicTaskExecutor,
  CodingTaskExecutor,
  GUITaskExecutor,
  WorkflowTaskExecutor,
} from './executors';
import { RuntimeMemoryStore } from './runtime-memory';
import { RuntimeTraceStore } from './runtime-trace';
import { TaskScheduler } from './task-scheduler';
import { TaskPlanner } from './task-planner';
import { createOrchestrationTools } from './tools';
import type {
  CapabilityProposal,
  RuntimeTask,
  RuntimeTaskEvent,
  RuntimeTaskQueueSnapshot,
  RuntimeTaskSubmitInput,
  WorldStateSnapshot,
} from './types';

export interface OrchestrationRuntimeOptions {
  stateDirectory?: string;
  autonomyMode?: 'off' | 'suggest' | 'low-risk';
  maxConcurrentTasks?: number;
  maxInteractiveTasks?: number;
  maxNormalTasks?: number;
  maxBackgroundTasks?: number;
  taskIdempotencyTtlMs?: number;
  capabilityApiKey?: string;
  capabilityBaseUrl?: string;
  capabilityModel?: string;
  capabilityIntervalMs?: number;
}

export class WorldStateStore {
  private readonly listeners = new Set<
    (snapshot: WorldStateSnapshot) => void
  >();
  private readonly unsubscribers: Array<() => void> = [];
  private revision = 0;
  private notifyTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly sources: {
      system: SystemStateStore;
      context: DynamicContextStore;
      scheduler: TaskScheduler;
      catalog: CapabilityCatalog;
      autonomy: AutonomyEngine;
      capabilities: CapabilitySynthesisService;
      memory: RuntimeMemoryStore;
      trace: RuntimeTraceStore;
    },
  ) {
    const touch = () => this.scheduleNotify();
    this.unsubscribers.push(
      sources.system.onChange(() => {
        const snapshot = sources.system.getSnapshot();
        sources.trace.record({
          category: 'system',
          name: 'system.changed',
          summary: `系统状态更新：${snapshot.runningProcesses.length} 进程，${snapshot.windows.length} 窗口。`,
          data: {
            runtimeObservedAt: snapshot.runtimeObservedAt,
            fullObservedAt: snapshot.fullObservedAt,
          },
        });
        touch();
      }),
      sources.context.subscribe((snapshot) => {
        sources.trace.record({
          category: 'context',
          name: 'context.changed',
          summary: `动态上下文更新：${snapshot.resources.length} 个资源，${snapshot.bindings.length} 个绑定。`,
          data: {
            revision: snapshot.revision,
            activeResourceIds: snapshot.activeResourceIds,
            perception: snapshot.perception.map((provider) => ({
              id: provider.id,
              state: provider.state,
            })),
          },
        });
        touch();
      }),
      sources.context.intent.subscribe(() => {
        const intent = sources.context.intent.getSnapshot();
        sources.trace.record({
          category: 'intent',
          name: 'intent.changed',
          summary: `用户意图更新：${intent.activity} (${intent.confidence.toFixed(2)})。`,
          data: {
            activity: intent.activity,
            episodeId: intent.currentEpisode?.id || null,
            candidateIntents: intent.candidateIntents
              .slice(0, 4)
              .map((candidate) => ({
                kind: candidate.kind,
                confidence: candidate.confidence,
              })),
          },
        });
        touch();
      }),
      sources.scheduler.subscribe((event) => {
        sources.trace.record({
          category: 'task',
          name: event.type,
          summary: event.message,
          taskId: event.task.id,
          data: {
            status: event.task.status,
            lane: event.task.lane,
            kind: event.task.kind,
            checkpoint: event.task.checkpoint,
            progress: event.task.progress,
            verification: event.task.verification.status,
          },
        });
        touch();
      }),
      sources.autonomy.subscribe(() => {
        const snapshot = sources.autonomy.snapshot();
        sources.trace.record({
          category: 'autonomy',
          name: 'autonomy.changed',
          summary: `自主状态更新：${snapshot.proposals.length} 个提案。`,
          data: { mode: snapshot.mode },
        });
        touch();
      }),
      sources.capabilities.subscribe(() => {
        const proposals = sources.capabilities.list();
        sources.trace.record({
          category: 'capability',
          name: 'capability.changed',
          summary: `能力状态更新：${proposals.length} 个提案。`,
          data: { proposals: proposals.length },
        });
        touch();
      }),
      sources.memory.subscribe(() => {
        const snapshot = sources.memory.snapshot(1);
        sources.trace.record({
          category: 'memory',
          name: 'memory.changed',
          summary: `运行记忆更新，版本 ${snapshot.revision}。`,
          data: { revision: snapshot.revision },
        });
        touch();
      }),
      sources.trace.subscribe(touch),
    );
  }

  getSnapshot(): WorldStateSnapshot {
    let lastError: string | null = null;
    const safe = <T>(read: () => T, fallback: T): T => {
      try {
        return read();
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        return fallback;
      }
    };
    const system = this.sources.system.getSnapshot();
    const context = this.sources.context.getSnapshot();
    return {
      revision: this.revision,
      updatedAt: Date.now(),
      system,
      context,
      intent: this.sources.context.intent.getSnapshot(),
      tasks: this.sources.scheduler.snapshot(),
      capabilities: safe(() => this.sources.catalog.list(), []),
      autonomy: this.sources.autonomy.snapshot(),
      capabilityProposals: safe(() => this.sources.capabilities.list(), []),
      memoryRevision: this.sources.memory.snapshot(1).revision,
      recentEvents: this.sources.trace.list({ limit: 80 }),
      health: {
        system: Boolean(system.capturedAt),
        dynamicContext: Boolean(context.revision || context.systemCapturedAt),
        scheduler: true,
        autonomy: this.sources.autonomy.snapshot().enabled,
        capabilitySynthesis: true,
        trace: true,
        lastError,
      },
    };
  }

  subscribe(listener: (snapshot: WorldStateSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    if (this.notifyTimer) clearTimeout(this.notifyTimer);
    this.notifyTimer = null;
    for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe();
    this.listeners.clear();
  }

  private scheduleNotify(): void {
    if (this.notifyTimer) return;
    this.notifyTimer = setTimeout(() => {
      this.notifyTimer = null;
      this.revision += 1;
      const snapshot = this.getSnapshot();
      for (const listener of [...this.listeners]) {
        try {
          listener(snapshot);
        } catch {
          // World-state observers must not block updates.
        }
      }
    }, 50);
    this.notifyTimer.unref?.();
  }
}

export class OrchestrationRuntime {
  readonly memory: RuntimeMemoryStore;
  readonly scheduler: TaskScheduler;
  readonly planner: TaskPlanner;
  readonly autonomy: AutonomyEngine;
  readonly capabilitySynthesis: CapabilitySynthesisService;
  readonly trace: RuntimeTraceStore;
  readonly world: WorldStateStore;
  private readonly unsubscribeScheduler: () => void;
  private readonly unsubscribeToolExecutions: () => void;
  private readonly unsubscribeAutonomyFeedback: () => void;
  private consolidationTimer: ReturnType<typeof setInterval> | null = null;
  private started = false;

  constructor(
    private readonly dependencies: {
      registry: ToolRegistry;
      catalog: CapabilityCatalog;
      systemState: SystemStateStore;
      context: DynamicContextStore;
      workflow: LocalWorkflowEngine;
      controller: CyrvisController;
      codingAgent: CodingAgentService;
      providerRegistry: ProviderRegistry;
    },
    options: OrchestrationRuntimeOptions = {},
  ) {
    const stateDirectory =
      options.stateDirectory || path.resolve(process.cwd(), 'cyrvis-runtime');
    this.memory = new RuntimeMemoryStore({
      stateFile: path.join(stateDirectory, 'memory.json'),
    });
    this.trace = new RuntimeTraceStore({
      stateFile: path.join(stateDirectory, 'trace.json'),
    });
    this.scheduler = new TaskScheduler({
      stateFile: path.join(stateDirectory, 'tasks.json'),
      maxConcurrent:
        typeof options.maxConcurrentTasks === 'number' &&
        Number.isFinite(options.maxConcurrentTasks)
          ? options.maxConcurrentTasks
          : undefined,
      maxInteractive: options.maxInteractiveTasks,
      maxNormal: options.maxNormalTasks,
      maxBackground: options.maxBackgroundTasks,
      idempotencyTtlMs: options.taskIdempotencyTtlMs,
    });
    this.scheduler.registerExecutor(
      new AtomicTaskExecutor(dependencies.registry, 'atomic'),
    );
    this.scheduler.registerExecutor(
      new AtomicTaskExecutor(dependencies.registry, 'observe'),
    );
    this.scheduler.registerExecutor(
      new WorkflowTaskExecutor(dependencies.workflow),
    );
    this.scheduler.registerExecutor(
      new GUITaskExecutor(dependencies.controller),
    );
    this.scheduler.registerExecutor(
      new CodingTaskExecutor(dependencies.codingAgent),
    );
    this.planner = new TaskPlanner(this.scheduler, dependencies.catalog);
    this.autonomy = new AutonomyEngine(this.scheduler, this.memory, {
      stateFile: path.join(stateDirectory, 'autonomy.json'),
      mode: options.autonomyMode,
    });
    this.capabilitySynthesis = new CapabilitySynthesisService(
      dependencies.registry,
      dependencies.catalog,
      dependencies.workflow,
      dependencies.systemState,
      dependencies.context,
      this.memory,
      {
        stateFile: path.join(stateDirectory, 'capability-proposals.json'),
        // secretlint-disable-next-line @secretlint/secretlint-rule-pattern
        apiKey: options.capabilityApiKey,
        baseUrl: options.capabilityBaseUrl,
        model: options.capabilityModel,
        intervalMs: options.capabilityIntervalMs,
        providers: dependencies.providerRegistry,
      },
    );
    this.world = new WorldStateStore({
      system: dependencies.systemState,
      context: dependencies.context,
      scheduler: this.scheduler,
      catalog: dependencies.catalog,
      autonomy: this.autonomy,
      capabilities: this.capabilitySynthesis,
      memory: this.memory,
      trace: this.trace,
    });
    this.autonomy.setSignalProvider(() => {
      const intent = this.world.getSnapshot().intent;
      return {
        activity: intent.activity,
        activeApplication: intent.activeApplication,
        activeWindow: intent.activeWindow,
        gazeTarget: intent.gaze?.label || intent.gaze?.role || null,
        recentUtterance: intent.recentUtterance?.text || null,
        focusedControl: intent.focusedControl,
        recentUtteranceAgeMs: intent.recentUtterance
          ? Date.now() - intent.recentUtterance.at
          : null,
      };
    });
    this.unsubscribeScheduler = this.scheduler.subscribe((event) =>
      this.handleTaskEvent(event),
    );
    this.unsubscribeToolExecutions = dependencies.registry.subscribeExecutions(
      (event) =>
        this.trace.record({
          category: 'tool',
          name: event.toolId,
          summary: event.speech,
          data: {
            ok: event.ok,
            durationMs: event.durationMs,
            error: event.error || null,
          },
        }),
    );
    this.unsubscribeAutonomyFeedback = this.autonomy.subscribeFeedback(
      (feedback) => {
        if (feedback !== 'ignored') {
          dependencies.context.intent.recordFeedback(feedback);
        }
      },
    );
    dependencies.registry.registerAll(
      createOrchestrationTools(this),
      'orchestration',
    );
  }

  async ready(): Promise<void> {
    await Promise.all([
      this.memory.ready(),
      this.scheduler.ready(),
      this.autonomy.ready(),
      this.capabilitySynthesis.ready(),
      this.trace.ready(),
    ]);
  }

  async start(): Promise<void> {
    if (this.started) return;
    await this.ready();
    this.started = true;
    this.autonomy.start();
    this.capabilitySynthesis.start();
    this.consolidationTimer = setInterval(() => {
      void this.memory.consolidate().catch(() => undefined);
    }, 5 * 60_000);
    this.consolidationTimer.unref?.();
  }

  dispose(): void {
    this.started = false;
    if (this.consolidationTimer) clearInterval(this.consolidationTimer);
    this.consolidationTimer = null;
    this.unsubscribeScheduler();
    this.unsubscribeToolExecutions();
    this.unsubscribeAutonomyFeedback();
    this.world.dispose();
    this.capabilitySynthesis.dispose();
    this.autonomy.dispose();
    this.scheduler.dispose();
    void this.trace.flush();
  }

  snapshot(): WorldStateSnapshot {
    return this.world.getSnapshot();
  }

  publicSnapshot(): RuntimeSnapshotView {
    const world = this.snapshot();
    const foreground =
      world.system.windows.find((window) => window.focused) || null;
    const proposals = world.capabilityProposals
      .filter((proposal) => proposal.status === 'proposed')
      .map((proposal) => ({
        id: proposal.id,
        kind: proposal.kind,
        title: proposal.title,
        reason: proposal.reason,
        risk: proposal.risk,
        createdAt: proposal.createdAt,
        status: proposal.status,
        activatedToolId: proposal.activatedToolId,
      }));
    return {
      revision: world.revision,
      updatedAt: world.updatedAt,
      system: {
        platform: world.system.platform,
        release: world.system.release,
        processCount: world.system.runningProcesses.length,
        windowCount: world.system.windows.length,
        foregroundProcess: foreground?.process || null,
        foregroundTitle: foreground?.title || null,
        runtimeObservedAt: world.system.runtimeObservedAt,
        fullObservedAt: world.system.fullObservedAt,
      },
      user: {
        activity: world.intent.activity,
        confidence: world.intent.confidence,
        activeApplication: world.intent.activeApplication,
        activeWindow: world.intent.activeWindow,
        focusedControl: world.intent.focusedControl,
        gazeTarget: world.intent.gaze?.label || world.intent.gaze?.role || null,
        recentUtterance: world.intent.recentUtterance?.text || null,
        timelineRevision: world.intent.timelineRevision,
        currentEpisode: world.intent.currentEpisode
          ? {
              id: world.intent.currentEpisode.id,
              activity: world.intent.currentEpisode.activity,
              activeApplication: world.intent.currentEpisode.activeApplication,
              startedAt: world.intent.currentEpisode.startedAt,
              confidence: world.intent.currentEpisode.confidence,
              feedback: world.intent.currentEpisode.feedback,
            }
          : null,
        candidateIntents: world.intent.candidateIntents.map((intent) => ({
          kind: intent.kind,
          confidence: intent.confidence,
          evidence: [...intent.evidence],
        })),
      },
      perception: world.context.perception.map((provider) => ({
        id: provider.id,
        state: provider.state,
        resourceCount: provider.resourceCount,
        lastRefreshAt: provider.lastSuccessAt,
        error: provider.error,
      })),
      taskQueue: {
        active: world.tasks.active,
        tasks: world.tasks.tasks.map((task) => ({
          id: task.id,
          source: task.source,
          kind: task.kind,
          goal: task.goal,
          lane: task.lane,
          idempotencyKey: task.idempotencyKey,
          priorityClass: task.priorityClass,
          priority: task.priority,
          status: task.status,
          preemptible: task.preemptible,
          risk: task.risk,
          resources: [...task.resources],
          dependsOn: [...task.dependsOn],
          createdAt: task.createdAt,
          updatedAt: task.updatedAt,
          startedAt: task.startedAt,
          endedAt: task.endedAt,
          externalId: task.externalId,
          result: task.result,
          error: task.error,
          checkpoint: task.checkpoint
            ? {
                revision: task.checkpoint.revision,
                phase: task.checkpoint.phase,
                at: task.checkpoint.at,
              }
            : null,
          progress: task.progress ? { ...task.progress } : null,
          verification: {
            status: task.verification.status,
            message: task.verification.message,
            at: task.verification.at,
          },
        })),
        locks: world.tasks.locks.map((lock) => ({ ...lock })),
      },
      autonomy: {
        mode: world.autonomy.mode,
        enabled: world.autonomy.enabled,
        proposals: world.autonomy.proposals.map((proposal) => ({
          id: proposal.id,
          title: proposal.title,
          reason: proposal.reason,
          goal: proposal.goal,
          taskKind: proposal.taskKind,
          risk: proposal.risk,
          sideEffect: proposal.sideEffect,
          confidence: proposal.confidence,
          score: proposal.score,
          attentionCost: proposal.attentionCost,
          interruptive: proposal.interruptive,
          createdAt: proposal.createdAt,
          expiresAt: proposal.expiresAt,
          status: proposal.status,
          queuedTaskId: proposal.queuedTaskId,
        })),
        goals: world.autonomy.goals.map((goal) => ({
          id: goal.id,
          text: goal.text,
          enabled: goal.enabled,
          intervalMs: goal.intervalMs,
          nextRunAt: goal.nextRunAt,
        })),
        budget: { ...world.autonomy.budget },
      },
      capabilities: {
        total: world.capabilities.length,
        available: world.capabilities.filter(
          (capability) =>
            capability.availability === 'available' ||
            capability.availability === 'degraded',
        ).length,
        proposed: proposals,
      },
      memoryRevision: world.memoryRevision,
      recentEvents: world.recentEvents.map((event) => ({
        id: event.id,
        sequence: event.sequence,
        at: event.at,
        category: event.category,
        name: event.name,
        summary: event.summary,
        taskId: event.taskId,
      })),
      replay: this.trace.replay({
        from: 0,
        to: Date.now(),
      }),
      health: { ...world.health },
    };
  }

  memoryEntries(limit = 100) {
    return this.memory.snapshot(limit).entries;
  }

  publicTask(taskId: string) {
    return (
      this.publicSnapshot().taskQueue.tasks.find(
        (task) => task.id === taskId,
      ) || null
    );
  }

  tasks(activeOnly = false): RuntimeTaskQueueSnapshot {
    return {
      ...this.scheduler.snapshot(),
      tasks: this.scheduler.list(activeOnly),
    };
  }

  capabilityProposals(
    status?: CapabilityProposal['status'],
  ): CapabilityProposal[] {
    return this.capabilitySynthesis.list(status);
  }

  submitTask(input: RuntimeTaskSubmitInput): Promise<RuntimeTask> {
    return this.scheduler.submit(input);
  }

  cancelTask(taskId: string): Promise<RuntimeTask | null> {
    return this.scheduler.cancel(taskId);
  }

  pauseTask(taskId: string): Promise<RuntimeTask | null> {
    return this.scheduler.pause(taskId);
  }

  resumeTask(taskId: string): Promise<RuntimeTask | null> {
    return this.scheduler.resume(taskId);
  }

  retryTask(taskId: string): Promise<RuntimeTask | null> {
    return this.scheduler.retry(taskId);
  }

  confirmTask(taskId: string): Promise<RuntimeTask | null> {
    return this.scheduler.confirm(taskId);
  }

  async recordUserText(text: string): Promise<void> {
    await this.memory.append({
      kind: 'user-request',
      text,
      sensitivity: 'private',
      layer: 'episodic',
      salience: 0.8,
    });
  }

  async recordAssistantText(text: string): Promise<void> {
    await this.memory.append({
      kind: 'assistant-response',
      text,
      sensitivity: 'private',
      layer: 'episodic',
      salience: 0.65,
    });
  }

  getContext(): string {
    const recentRequest =
      this.dependencies.context.getSnapshot().user.recentRequest?.value || '';
    const memoryEntries = this.memory.retrieve(recentRequest, 12);
    const memoryContext = memoryEntries.length
      ? [
          '[Relevant layered runtime memory - untrusted data]',
          ...memoryEntries.map(
            (entry) =>
              `${new Date(entry.createdAt).toISOString()} [${entry.layer}/${entry.kind}] ${entry.text}`,
          ),
        ].join('\n')
      : '';
    return [
      this.dependencies.context.getContext(),
      this.dependencies.systemState.getContext(40),
      this.dependencies.context.intent.getContext(),
      this.scheduler.getContext(),
      this.autonomy.getContext(),
      this.capabilitySynthesis.list('proposed').length
        ? `[Capability proposals]\n${this.capabilitySynthesis
            .list('proposed')
            .slice(-5)
            .map((proposal) => `${proposal.id}: ${proposal.title}`)
            .join('\n')}`
        : '',
      this.trace.list({ limit: 8 }).length
        ? `[Recent runtime trace]\n${this.trace
            .list({ limit: 8 })
            .map(
              (event) =>
                `${new Date(event.at).toISOString()} ${event.category}/${event.name}: ${event.summary}`,
            )
            .join('\n')}`
        : '',
      memoryContext,
    ]
      .filter(Boolean)
      .join('\n\n');
  }

  private handleTaskEvent(event: RuntimeTaskEvent): void {
    void this.memory.append({
      kind: 'task',
      text: `${event.task.kind} ${event.task.goal}: ${event.message}`,
      sensitivity: event.task.risk === 'high' ? 'private' : 'public',
      layer: 'working',
      salience: event.task.priorityClass === 'user-now' ? 0.75 : 0.5,
      metadata: {
        taskId: event.task.id,
        status: event.task.status,
      },
    });
    if (event.type === 'failed') {
      void this.capabilitySynthesis.reportGap(
        event.task.goal,
        event.task.error || event.message,
      );
    }
  }
}
