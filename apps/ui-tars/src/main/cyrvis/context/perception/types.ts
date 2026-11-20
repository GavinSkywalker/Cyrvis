import type { SystemStateSnapshot } from '../../system/types';
import type { DesktopHost } from '../../tools/types';
import type { ResourceDescriptor, UserContextSnapshot } from '../types';

export interface PerceptionContext {
  now: number;
  system: SystemStateSnapshot | null;
  user: UserContextSnapshot;
  desktop?: DesktopHost;
}

export interface PerceptionProvider {
  id: string;
  intervalMs: number;
  ttlMs?: number;
  timeoutMs?: number;
  triggerToolIds?: string[];
  refresh(
    context: PerceptionContext,
    signal: AbortSignal,
  ): Promise<ResourceDescriptor[]>;
  dispose?(): void | Promise<void>;
}

export type PerceptionProviderState = 'idle' | 'healthy' | 'degraded';

export interface PerceptionProviderSnapshot {
  id: string;
  state: PerceptionProviderState;
  lastRefreshAt: number | null;
  lastSuccessAt: number | null;
  nextRefreshAt: number | null;
  durationMs: number | null;
  resourceCount: number;
  consecutiveFailures: number;
  error: string | null;
}

export interface ResourceStoreChange {
  providerId: string;
  revision: number;
  upserted: string[];
  removed: string[];
  at: number;
}
