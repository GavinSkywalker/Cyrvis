import type { CapabilityAvailability } from '../tools/types';
import type { PerceptionProviderSnapshot } from './perception/types';

export type ContextSource =
  | 'system'
  | 'user'
  | 'task'
  | 'usage'
  | 'memory'
  | 'perception';
export type ContextSensitivity = 'public' | 'private' | 'secret';
export type ResourceKind =
  | 'application'
  | 'window'
  | 'tab'
  | 'document'
  | 'file'
  | 'website'
  | 'account'
  | 'device'
  | 'control'
  | 'clipboard';
export type ResourceHealth =
  | 'available'
  | 'degraded'
  | 'unavailable'
  | 'unknown';

export interface StateFact<T> {
  value: T;
  source: ContextSource;
  confidence: number;
  observedAt: number;
  expiresAt: number | null;
  sensitivity: ContextSensitivity;
}

export interface WindowContext {
  pid: number;
  process: string;
  title: string;
  handle?: number;
}

export interface FocusedControlContext {
  name: string;
  role?: string;
  automationId?: string;
}

export interface RecentActionContext {
  toolId: string;
  ok: boolean;
  speech: string;
  at: number;
  resourceId?: string;
}

export interface TaskContext {
  taskId: string;
  status: string;
  instruction: string | null;
  step: number;
  at: number;
}

export interface UserContextSnapshot {
  revision: number;
  updatedAt: number;
  activeApplication: StateFact<string> | null;
  activeWindow: StateFact<WindowContext> | null;
  focusedControl: StateFact<FocusedControlContext> | null;
  selectedText: StateFact<string> | null;
  clipboard: StateFact<string> | null;
  recentRequest: StateFact<string> | null;
  recentActions: RecentActionContext[];
  recentResourceIds: string[];
  currentTask: TaskContext | null;
}

export interface ResourceDescriptor {
  id: string;
  kind: ResourceKind;
  name: string;
  aliases: string[];
  source: string;
  active: boolean;
  health: ResourceHealth;
  providerIds: string[];
  capabilities: string[];
  updatedAt: number;
  metadata: Record<string, string | number | boolean | null>;
  parentId?: string;
  lastSeenAt?: number;
  expiresAt?: number;
  confidence?: number;
  sensitivity?: ContextSensitivity;
}

export interface CapabilityBinding {
  id: string;
  capabilityId: string;
  resourceId: string | null;
  providerId: string;
  method: string;
  defaultArgs: Record<string, unknown>;
  availability: CapabilityAvailability;
  active: boolean;
  reasons: string[];
  expiresAt: number | null;
}

export interface DynamicContextSnapshot {
  revision: number;
  updatedAt: number;
  systemCapturedAt: number;
  user: UserContextSnapshot;
  resources: ResourceDescriptor[];
  activeResourceIds: string[];
  fallbackResourceIds: string[];
  bindings: CapabilityBinding[];
  perception: PerceptionProviderSnapshot[];
}

export interface ToolVerificationPlan {
  kind:
    | 'path_exists'
    | 'path_missing'
    | 'process_running'
    | 'window_exists'
    | 'tool_result';
  target?: string | number;
  timeoutMs?: number;
}

export interface ToolVerificationResult {
  ok: boolean | null;
  kind: ToolVerificationPlan['kind'] | 'none';
  message: string;
}

export type ContextEvent =
  | {
      type: 'foreground_changed';
      at: number;
      resourceId: string | null;
    }
  | {
      type: 'resource_catalog_changed';
      at: number;
      resourceIds: string[];
    }
  | {
      type: 'tool_invoked';
      at: number;
      toolId: string;
      ok: boolean;
    }
  | {
      type: 'task_changed';
      at: number;
      taskId: string;
      status: string;
    }
  | {
      type: 'context_changed';
      at: number;
      revision: number;
    };

export interface DynamicContextOptions {
  now?: () => number;
  foregroundRefreshMs?: number;
  windowTtlMs?: number;
  focusTtlMs?: number;
  selectedTextTtlMs?: number;
  clipboardTtlMs?: number;
  requestTtlMs?: number;
  actionTtlMs?: number;
  maxRecentActions?: number;
  maxRecentResources?: number;
  perceptionMinIntervalMs?: number;
  perceptionMaxBackoffMs?: number;
  timelineStateFile?: string;
}
