import type { DynamicContextSnapshot } from '../context/types';
import type { UserIntentSnapshot } from '../context/intent-fusion';
import type { SystemStateSnapshot } from '../system/types';
import type {
  CapabilityDescriptor,
  ToolExecutionContract,
  ToolRisk,
  ToolSideEffect,
} from '../tools/types';
import type { WorkflowStartInput } from '../tools/workflow-engine';
import type { ProviderManifest } from '../tools/provider-types';
import type { RuntimeTraceEvent } from './runtime-trace';

export type TaskSourceKind =
  | 'user-voice'
  | 'user-text'
  | 'schedule'
  | 'autonomy'
  | 'system';

export type TaskPriorityClass =
  | 'stop'
  | 'user-now'
  | 'continuation'
  | 'scheduled'
  | 'autonomy';

export type RuntimeTaskKind =
  | 'atomic'
  | 'workflow'
  | 'gui'
  | 'coding'
  | 'observe';

export type TaskLane = 'interactive' | 'normal' | 'background';

export interface TaskCheckpoint {
  revision: number;
  phase: string;
  at: number;
  data: Record<string, unknown>;
}

export interface TaskProgressSnapshot {
  message: string;
  percent: number | null;
  updatedAt: number;
}

export interface TaskVerificationSnapshot {
  status: 'not_required' | 'pending' | 'passed' | 'failed';
  message: string;
  at: number | null;
  data?: unknown;
}

export type RuntimeTaskStatus =
  | 'queued'
  | 'running'
  | 'waiting_confirmation'
  | 'paused'
  | 'cancelling'
  | 'done'
  | 'failed'
  | 'cancelled';

export interface RuntimeTaskPayload {
  instruction?: string;
  tool?: string;
  args?: Record<string, unknown>;
  workflow?: WorkflowStartInput;
  workspace?: string;
  resources?: string[];
  metadata?: Record<string, unknown>;
}

export interface RuntimeTask {
  id: string;
  source: TaskSourceKind;
  kind: RuntimeTaskKind;
  goal: string;
  payload: RuntimeTaskPayload;
  lane: TaskLane;
  idempotencyKey: string | null;
  contract: Required<ToolExecutionContract>;
  checkpoint: TaskCheckpoint | null;
  progress: TaskProgressSnapshot | null;
  verification: TaskVerificationSnapshot;
  priorityClass: TaskPriorityClass;
  priority: number;
  preemptible: boolean;
  risk: ToolRisk;
  resources: string[];
  dependsOn: string[];
  contextRevision: number;
  createdAt: number;
  updatedAt: number;
  notBefore: number | null;
  deadline: number | null;
  startedAt: number | null;
  endedAt: number | null;
  status: RuntimeTaskStatus;
  attempts: number;
  externalId: string | null;
  result: string | null;
  data: unknown | null;
  error: string | null;
}

export interface RuntimeTaskSubmitInput {
  source: TaskSourceKind;
  kind: RuntimeTaskKind;
  goal: string;
  payload?: RuntimeTaskPayload;
  lane?: TaskLane;
  idempotencyKey?: string;
  contract?: ToolExecutionContract;
  priorityClass?: TaskPriorityClass;
  priority?: number;
  preemptible?: boolean;
  risk?: ToolRisk;
  resources?: string[];
  dependsOn?: string[];
  contextRevision?: number;
  notBefore?: number;
  deadline?: number;
}

export interface RuntimeTaskEvent {
  type:
    | 'submitted'
    | 'queued'
    | 'started'
    | 'progress'
    | 'checkpoint'
    | 'retrying'
    | 'verified'
    | 'waiting_confirmation'
    | 'paused'
    | 'resumed'
    | 'done'
    | 'failed'
    | 'cancelled';
  task: RuntimeTask;
  message: string;
  source?: 'executor' | 'heartbeat';
}

export interface ResourceLockSnapshot {
  resource: string;
  mode: 'read' | 'write';
  taskId: string;
  acquiredAt: number;
}

export interface RuntimeTaskQueueSnapshot {
  revision: number;
  active: number;
  tasks: RuntimeTask[];
  locks: ResourceLockSnapshot[];
}

export type AutonomyMode = 'off' | 'suggest' | 'low-risk';

export type AutonomyProposalStatus =
  | 'proposed'
  | 'accepted'
  | 'rejected'
  | 'queued'
  | 'expired';

export interface AutonomyProposal {
  id: string;
  title: string;
  reason: string;
  goal: string;
  taskKind: RuntimeTaskKind;
  payload: RuntimeTaskPayload;
  risk: ToolRisk;
  sideEffect: ToolSideEffect;
  confidence: number;
  score: number;
  attentionCost: number;
  interruptive: boolean;
  createdAt: number;
  expiresAt: number;
  status: AutonomyProposalStatus;
  queuedTaskId: string | null;
}

export interface AutonomyGoal {
  id: string;
  text: string;
  enabled: boolean;
  intervalMs: number;
  nextRunAt: number;
  lastProposedAt: number | null;
}

export interface AutonomySnapshot {
  revision: number;
  mode: AutonomyMode;
  enabled: boolean;
  proposals: AutonomyProposal[];
  goals: AutonomyGoal[];
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
}

export type CapabilityProposalKind =
  | 'workflow-template'
  | 'resource-binding'
  | 'provider-manifest';

export type CapabilityProposalStatus = 'proposed' | 'approved' | 'rejected';

export interface CapabilityProposal {
  id: string;
  kind: CapabilityProposalKind;
  title: string;
  reason: string;
  risk: ToolRisk;
  providerId: string;
  workflow?: WorkflowStartInput;
  providerManifest?: ProviderManifest;
  resourceBinding?: {
    resourceKind: string;
    capabilityId: string;
    toolId: string;
  };
  createdAt: number;
  status: CapabilityProposalStatus;
  activatedToolId: string | null;
}

export interface RuntimeHealthSnapshot {
  system: boolean;
  dynamicContext: boolean;
  scheduler: boolean;
  autonomy: boolean;
  capabilitySynthesis: boolean;
  trace: boolean;
  lastError: string | null;
}

export interface WorldStateSnapshot {
  revision: number;
  updatedAt: number;
  system: SystemStateSnapshot;
  context: DynamicContextSnapshot;
  intent: UserIntentSnapshot;
  tasks: RuntimeTaskQueueSnapshot;
  capabilities: CapabilityDescriptor[];
  autonomy: AutonomySnapshot;
  capabilityProposals: CapabilityProposal[];
  memoryRevision: number;
  recentEvents: RuntimeTraceEvent[];
  health: RuntimeHealthSnapshot;
}
