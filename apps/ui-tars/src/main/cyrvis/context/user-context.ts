import type { ControllerEvent } from '../types';
import { isSensitiveMemoryText } from '../memory-context';
import type {
  DynamicContextOptions,
  FocusedControlContext,
  RecentActionContext,
  StateFact,
  TaskContext,
  UserContextSnapshot,
  WindowContext,
} from './types';

const DEFAULT_WINDOW_TTL_MS = 15_000;
const DEFAULT_FOCUS_TTL_MS = 5_000;
const DEFAULT_SELECTED_TEXT_TTL_MS = 30_000;
const DEFAULT_CLIPBOARD_TTL_MS = 60_000;
const DEFAULT_REQUEST_TTL_MS = 10 * 60_000;
const DEFAULT_ACTION_TTL_MS = 10 * 60_000;

const normalizeText = (value: string, maxLength: number): string => {
  const trimmed = value.trim();
  if (!trimmed || isSensitiveMemoryText(trimmed)) {
    return '';
  }
  return trimmed.slice(0, maxLength);
};

const isExpired = (fact: StateFact<unknown> | null, now: number): boolean =>
  Boolean(fact && fact.expiresAt !== null && fact.expiresAt <= now);

const taskInstruction = (event: ControllerEvent): string | null => {
  if ('instruction' in event && typeof event.instruction === 'string') {
    return normalizeText(event.instruction, 300) || null;
  }
  return null;
};

export class UserContextStore {
  private readonly now: () => number;
  private readonly windowTtlMs: number;
  private readonly focusTtlMs: number;
  private readonly selectedTextTtlMs: number;
  private readonly clipboardTtlMs: number;
  private readonly requestTtlMs: number;
  private readonly actionTtlMs: number;
  private readonly maxRecentActions: number;
  private readonly maxRecentResources: number;
  private readonly listeners = new Set<
    (snapshot: UserContextSnapshot) => void
  >();
  private revision = 0;
  private updatedAt = 0;
  private activeApplication: StateFact<string> | null = null;
  private activeWindow: StateFact<WindowContext> | null = null;
  private focusedControl: StateFact<FocusedControlContext> | null = null;
  private selectedText: StateFact<string> | null = null;
  private clipboard: StateFact<string> | null = null;
  private recentRequest: StateFact<string> | null = null;
  private recentActions: RecentActionContext[] = [];
  private recentResourceIds: string[] = [];
  private currentTask: TaskContext | null = null;

  constructor(options: DynamicContextOptions = {}) {
    this.now = options.now ?? Date.now;
    this.windowTtlMs = options.windowTtlMs ?? DEFAULT_WINDOW_TTL_MS;
    this.focusTtlMs = options.focusTtlMs ?? DEFAULT_FOCUS_TTL_MS;
    this.selectedTextTtlMs =
      options.selectedTextTtlMs ?? DEFAULT_SELECTED_TEXT_TTL_MS;
    this.clipboardTtlMs = options.clipboardTtlMs ?? DEFAULT_CLIPBOARD_TTL_MS;
    this.requestTtlMs = options.requestTtlMs ?? DEFAULT_REQUEST_TTL_MS;
    this.actionTtlMs = options.actionTtlMs ?? DEFAULT_ACTION_TTL_MS;
    this.maxRecentActions = options.maxRecentActions ?? 20;
    this.maxRecentResources = options.maxRecentResources ?? 20;
  }

  setActiveWindow(window: WindowContext | null): void {
    const next = window
      ? this.fact(window, 'system', 1, this.windowTtlMs, 'private')
      : null;
    if (
      this.activeWindow?.value.pid === next?.value.pid &&
      this.activeWindow?.value.title === next?.value.title
    ) {
      this.activeWindow = next;
      return;
    }
    this.activeWindow = next;
    this.activeApplication = null;
    this.touch();
  }

  setActiveApplication(resourceId: string | null): void {
    if ((this.activeApplication?.value || null) === resourceId) {
      return;
    }
    this.activeApplication = resourceId
      ? this.fact(resourceId, 'system', 0.9, this.windowTtlMs, 'public')
      : null;
    this.touch();
  }

  syncActiveApplication(resourceId: string | null): boolean {
    if ((this.activeApplication?.value || null) === resourceId) {
      return false;
    }
    this.activeApplication = resourceId
      ? this.fact(resourceId, 'system', 0.9, this.windowTtlMs, 'public')
      : null;
    return true;
  }

  setFocusedControl(control: FocusedControlContext | null): void {
    if (this.syncFocusedControl(control)) this.touch();
  }

  syncFocusedControl(control: FocusedControlContext | null): boolean {
    if (!control?.name.trim()) {
      if (this.focusedControl === null) return false;
      this.focusedControl = null;
      return true;
    }
    if (
      this.focusedControl?.value.name === control.name.trim().slice(0, 200) &&
      this.focusedControl?.value.role === control.role?.slice(0, 120) &&
      this.focusedControl?.value.automationId ===
        control.automationId?.slice(0, 200)
    ) {
      return false;
    }
    this.focusedControl = this.fact(
      {
        name: normalizeText(control.name, 200),
        role: control.role?.slice(0, 120),
        automationId: control.automationId?.slice(0, 200),
      },
      'user',
      0.9,
      this.focusTtlMs,
      'private',
    );
    return true;
  }

  setSelectedText(text: string | null): void {
    if (this.syncSelectedText(text)) this.touch();
  }

  syncSelectedText(text: string | null): boolean {
    const normalized = text ? normalizeText(text, 1_000) : '';
    if ((this.selectedText?.value || '') === normalized) return false;
    this.selectedText = normalized
      ? this.fact(normalized, 'user', 0.9, this.selectedTextTtlMs, 'private')
      : null;
    return true;
  }

  setClipboard(text: string | null): void {
    if (this.syncClipboard(text)) this.touch();
  }

  syncClipboard(text: string | null): boolean {
    const normalized = text ? normalizeText(text, 2_000) : '';
    if ((this.clipboard?.value || '') === normalized) return false;
    this.clipboard = normalized
      ? this.fact(normalized, 'perception', 0.9, this.clipboardTtlMs, 'private')
      : null;
    return true;
  }

  recordUserText(text: string): void {
    const normalized = normalizeText(text, 300);
    if (!normalized) {
      return;
    }
    this.recentRequest = this.fact(
      normalized,
      'user',
      0.8,
      this.requestTtlMs,
      'private',
    );
    this.touch();
  }

  recordAction(action: {
    toolId: string;
    ok: boolean;
    speech: string;
    resourceId?: string;
  }): void {
    const at = this.now();
    const next: RecentActionContext = {
      toolId: action.toolId,
      ok: action.ok,
      speech: normalizeText(action.speech, 300),
      at,
      resourceId: action.resourceId,
    };
    this.recentActions = [...this.recentActions, next].slice(
      -this.maxRecentActions,
    );
    if (action.resourceId) {
      this.touchResource(action.resourceId);
    }
    this.touch();
  }

  recordTaskEvent(event: ControllerEvent): void {
    const status =
      'status' in event && typeof event.status === 'string'
        ? event.status
        : event.type.replace(/^task_/, '');
    this.currentTask = {
      taskId: event.taskId,
      status,
      instruction:
        taskInstruction(event) || this.currentTask?.instruction || null,
      step: 'step' in event && typeof event.step === 'number' ? event.step : 0,
      at: this.now(),
    };
    if (
      status === 'done' ||
      status === 'failed' ||
      status === 'cancelled' ||
      event.type === 'task_done' ||
      event.type === 'task_failed' ||
      event.type === 'task_cancelled'
    ) {
      this.currentTask = {
        ...this.currentTask,
        status: status === 'done' ? 'done' : status,
      };
    }
    this.touch();
  }

  clearTask(taskId?: string): void {
    if (!this.currentTask || (taskId && this.currentTask.taskId !== taskId)) {
      return;
    }
    this.currentTask = null;
    this.touch();
  }

  clear(): void {
    this.focusedControl = null;
    this.selectedText = null;
    this.clipboard = null;
    this.recentRequest = null;
    this.recentActions = [];
    this.recentResourceIds = [];
    this.touch();
  }

  addRecentResource(resourceId: string): void {
    this.touchResource(resourceId);
    this.touch();
  }

  getSnapshot(): UserContextSnapshot {
    const now = this.now();
    if (isExpired(this.activeWindow, now)) this.activeWindow = null;
    if (isExpired(this.focusedControl, now)) this.focusedControl = null;
    if (isExpired(this.selectedText, now)) this.selectedText = null;
    if (isExpired(this.clipboard, now)) this.clipboard = null;
    if (isExpired(this.recentRequest, now)) this.recentRequest = null;
    if (isExpired(this.activeApplication, now)) this.activeApplication = null;
    this.recentActions = this.recentActions.filter(
      (action) => now - action.at <= this.actionTtlMs,
    );

    return {
      revision: this.revision,
      updatedAt: this.updatedAt,
      activeApplication: this.activeApplication,
      activeWindow: this.activeWindow,
      focusedControl: this.focusedControl,
      selectedText: this.selectedText,
      clipboard: this.clipboard,
      recentRequest: this.recentRequest,
      recentActions: [...this.recentActions],
      recentResourceIds: [...this.recentResourceIds],
      currentTask: this.currentTask,
    };
  }

  subscribe(listener: (snapshot: UserContextSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private fact<T>(
    value: T,
    source: StateFact<T>['source'],
    confidence: number,
    ttlMs: number,
    sensitivity: StateFact<T>['sensitivity'],
  ): StateFact<T> {
    const observedAt = this.now();
    return {
      value,
      source,
      confidence,
      observedAt,
      expiresAt: ttlMs > 0 ? observedAt + ttlMs : null,
      sensitivity,
    };
  }

  private touchResource(resourceId: string): void {
    this.recentResourceIds = [
      resourceId,
      ...this.recentResourceIds.filter((entry) => entry !== resourceId),
    ].slice(0, this.maxRecentResources);
  }

  private touch(): void {
    this.updatedAt = this.now();
    this.revision += 1;
    const snapshot = this.getSnapshot();
    for (const listener of [...this.listeners]) {
      try {
        listener(snapshot);
      } catch {
        // User-context observers must not interrupt state collection.
      }
    }
  }
}
