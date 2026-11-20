export type RuntimeTaskStatus =
  | 'queued'
  | 'running'
  | 'waiting_confirmation'
  | 'paused'
  | 'cancelling'
  | 'done'
  | 'failed'
  | 'cancelled';

export type RuntimeTaskKind =
  | 'atomic'
  | 'workflow'
  | 'gui'
  | 'coding'
  | 'observe';

export interface RuntimeTaskProgressView {
  message: string;
  percent: number | null;
  updatedAt: number;
}

export interface RuntimeTaskView {
  id: string;
  source: string;
  kind: RuntimeTaskKind;
  goal: string;
  lane: 'interactive' | 'normal' | 'background';
  idempotencyKey: string | null;
  priorityClass: string;
  priority: number;
  status: RuntimeTaskStatus;
  preemptible: boolean;
  risk: 'low' | 'medium' | 'high';
  resources: string[];
  dependsOn: string[];
  createdAt: number;
  updatedAt: number;
  startedAt: number | null;
  endedAt: number | null;
  externalId: string | null;
  result: string | null;
  error: string | null;
  checkpoint: {
    revision: number;
    phase: string;
    at: number;
  } | null;
  verification: {
    status: 'not_required' | 'pending' | 'passed' | 'failed';
    message: string;
    at: number | null;
  };
  progress: RuntimeTaskProgressView | null;
}

export interface RuntimeLockView {
  resource: string;
  mode: 'read' | 'write';
  taskId: string;
  acquiredAt: number;
}

export interface AutonomyProposalView {
  id: string;
  title: string;
  reason: string;
  goal: string;
  taskKind: RuntimeTaskKind;
  risk: 'low' | 'medium' | 'high';
  sideEffect: 'none' | 'read' | 'write' | 'external' | 'irreversible';
  confidence: number;
  score: number;
  attentionCost: number;
  interruptive: boolean;
  createdAt: number;
  expiresAt: number;
  status: string;
  queuedTaskId: string | null;
}

export interface CapabilityProposalView {
  id: string;
  kind: string;
  title: string;
  reason: string;
  risk: 'low' | 'medium' | 'high';
  createdAt: number;
  status: string;
  activatedToolId: string | null;
}

export interface RuntimeMemoryView {
  id: string;
  kind: string;
  text: string;
  createdAt: number;
  expiresAt: number | null;
  sensitivity: 'public' | 'private' | 'secret';
  layer: 'working' | 'episodic' | 'semantic';
  salience: number;
  metadata: Record<string, unknown>;
}

export interface RuntimeTraceEventView {
  id: string;
  sequence: number;
  at: number;
  category: string;
  name: string;
  summary: string;
  taskId: string | null;
}

export interface RuntimeTraceReplayView {
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

export interface RuntimeSnapshotView {
  revision: number;
  updatedAt: number;
  system: {
    platform: string;
    release: string;
    processCount: number;
    windowCount: number;
    foregroundProcess: string | null;
    foregroundTitle: string | null;
    runtimeObservedAt: number;
    fullObservedAt: number;
  };
  user: {
    activity: string;
    confidence: number;
    activeApplication: string | null;
    activeWindow: string | null;
    focusedControl: string | null;
    gazeTarget: string | null;
    recentUtterance: string | null;
    timelineRevision: number;
    currentEpisode: {
      id: string;
      activity: string;
      activeApplication: string | null;
      startedAt: number;
      confidence: number;
      feedback: string;
    } | null;
    candidateIntents: Array<{
      kind: string;
      confidence: number;
      evidence: string[];
    }>;
  };
  perception: Array<{
    id: string;
    state: string;
    resourceCount: number;
    lastRefreshAt: number | null;
    error: string | null;
  }>;
  taskQueue: {
    active: number;
    tasks: RuntimeTaskView[];
    locks: RuntimeLockView[];
  };
  autonomy: {
    mode: string;
    enabled: boolean;
    proposals: AutonomyProposalView[];
    goals: Array<{
      id: string;
      text: string;
      enabled: boolean;
      intervalMs: number;
      nextRunAt: number;
    }>;
    budget: {
      maxPerHour: number;
      usedLastHour: number;
      nextAllowedAt: number;
      quietHours: {
        start: string | null;
        end: string | null;
        active: boolean;
      };
      feedback: {
        accepted: number;
        rejected: number;
        ignored: number;
      };
    };
  };
  capabilities: {
    total: number;
    available: number;
    proposed: CapabilityProposalView[];
  };
  memoryRevision: number;
  recentEvents: RuntimeTraceEventView[];
  replay: RuntimeTraceReplayView;
  health: {
    system: boolean;
    dynamicContext: boolean;
    scheduler: boolean;
    autonomy: boolean;
    capabilitySynthesis: boolean;
    trace: boolean;
    lastError: string | null;
  };
}
